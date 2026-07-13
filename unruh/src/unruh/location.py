"""Locations + weather cache (Weather sense, Session W-A).

The ward's places at city/ZIP granularity, and the forecast cache keyed by
them. Pure functions over a sqlite3.Connection, same shape as
schedule.py / handoff.py / intention.py.

Hard privacy rule (the reason this layer exists as its own thing): the
`label` is the only field that may ever reach the LLM. `lat`/`lon`/`timezone`
are local-only — the Node fetch half sends coordinates to the weather API and
nowhere else, and no accessor here surfaces them into a model-facing shape.
`location_public` is the deliberately narrow view the MCP layer returns.

Unruh stays network-free: geocoding and forecast fetches happen in Node
(weather-source.js); this module only stores what Node hands it (add_location
with coords already resolved; ingest_weather with a normalised forecast).
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from .db import insert_with_slug_retry, now_iso


# ── Writes ────────────────────────────────────────────────────────────


def add_location(
    conn: sqlite3.Connection,
    *,
    label: str,
    lat: float | None = None,
    lon: float | None = None,
    place_name: str | None = None,
    timezone: str | None = None,
) -> dict[str, Any]:
    """Store a location (coords already resolved by Node geocoding). The FIRST
    location added becomes current automatically — a ward with one place
    shouldn't have to also mark it. Returns {ok, id, is_current}."""
    label_clean = (label or "").strip()
    if not label_clean:
        return {"ok": False, "error": "label is required"}

    ts = now_iso()
    have_any = conn.execute("SELECT 1 FROM locations LIMIT 1").fetchone() is not None
    is_current = 0 if have_any else 1

    new_id = insert_with_slug_retry(
        conn,
        """INSERT INTO locations
               (id, label, lat, lon, place_name, timezone, is_current, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        lambda nid: (nid, label_clean, lat, lon, place_name, timezone, is_current, ts, ts),
        label=label_clean, kind="location",
    )
    return {"ok": True, "id": new_id, "is_current": bool(is_current)}


def _resolve(conn: sqlite3.Connection, ident: str) -> sqlite3.Row | None:
    """A location by id OR (case-insensitive) label — the Familiar addresses
    places by label, the UI by id."""
    row = conn.execute("SELECT * FROM locations WHERE id = ?", (ident,)).fetchone()
    if row is not None:
        return row
    return conn.execute(
        "SELECT * FROM locations WHERE lower(label) = lower(?) LIMIT 1", (ident.strip(),)
    ).fetchone()


def set_current(conn: sqlite3.Connection, *, ident: str) -> dict[str, Any]:
    """Mark one location current, clearing the rest — exactly one is current.
    `ident` is an id or a label. Returns {ok, id} or a not-found error."""
    row = _resolve(conn, ident)
    if row is None:
        return {"ok": False, "error": f"no location {ident!r}"}
    ts = now_iso()
    conn.execute("UPDATE locations SET is_current = 0, updated_at = ? WHERE is_current = 1", (ts,))
    conn.execute("UPDATE locations SET is_current = 1, updated_at = ? WHERE id = ?", (ts, row["id"]))
    return {"ok": True, "id": row["id"]}


def delete_location(conn: sqlite3.Connection, *, ident: str) -> dict[str, Any]:
    """Delete a location (ward-only surface) and its cached forecast (cascade).
    If the current one is deleted, the most-recently-updated remaining location
    becomes current so there is never a placeless gap. Returns {ok, deleted}."""
    row = _resolve(conn, ident)
    if row is None:
        return {"ok": True, "deleted": 0}
    was_current = bool(row["is_current"])
    conn.execute("DELETE FROM locations WHERE id = ?", (row["id"],))
    if was_current:
        nxt = conn.execute(
            "SELECT id FROM locations ORDER BY updated_at DESC, id LIMIT 1"
        ).fetchone()
        if nxt is not None:
            conn.execute(
                "UPDATE locations SET is_current = 1, updated_at = ? WHERE id = ?",
                (now_iso(), nxt["id"]),
            )
    return {"ok": True, "deleted": 1}


def ingest_weather(
    conn: sqlite3.Connection,
    *,
    location_id: str,
    provider: str,
    fetched_at: str,
    current: dict | None,
    hourly: list | None,
) -> dict[str, Any]:
    """Store a forecast the Node fetch half normalised. Replaces the location's
    cache row (one row per location). Validates the location exists and the
    payload shapes are sane; a malformed forecast is rejected, never stored
    half-formed. Returns {ok} or an error."""
    loc = conn.execute("SELECT 1 FROM locations WHERE id = ?", (location_id,)).fetchone()
    if loc is None:
        return {"ok": False, "error": f"no location {location_id!r}"}
    if not isinstance(current, dict):
        return {"ok": False, "error": "current must be an object"}
    if not isinstance(hourly, list):
        return {"ok": False, "error": "hourly must be an array"}
    ts = now_iso()
    conn.execute(
        """INSERT INTO weather_cache
               (location_id, provider, fetched_at, current_json, hourly_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(location_id) DO UPDATE SET
               provider = excluded.provider, fetched_at = excluded.fetched_at,
               current_json = excluded.current_json, hourly_json = excluded.hourly_json,
               updated_at = excluded.updated_at""",
        (location_id, provider, fetched_at, json.dumps(current), json.dumps(hourly), ts),
    )
    return {"ok": True}


# ── Reads ──────────────────────────────────────────────────────────────


def location_private(row: sqlite3.Row) -> dict[str, Any]:
    """FULL row incl. coords — for the Node fetch half ONLY (it needs lat/lon
    to call the weather API). Never returned by an MCP tool the model reads."""
    return {
        "id": row["id"], "label": row["label"],
        "lat": row["lat"], "lon": row["lon"],
        "place_name": row["place_name"], "timezone": row["timezone"],
        "is_current": bool(row["is_current"]),
        "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


def location_public(row: sqlite3.Row) -> dict[str, Any]:
    """LABEL-ONLY view — the shape any model-facing tool returns. No coords,
    no place_name, no timezone: the model learns a place exists and whether
    it's current, never where it is."""
    return {"id": row["id"], "label": row["label"], "is_current": bool(row["is_current"])}


def list_locations(conn: sqlite3.Connection, *, private: bool = False) -> list[dict[str, Any]]:
    """All locations, current first then alphabetical. `private=True` (Node
    fetch half) includes coords; default is the label-only public view."""
    rows = conn.execute(
        "SELECT * FROM locations ORDER BY is_current DESC, lower(label)"
    ).fetchall()
    shape = location_private if private else location_public
    return [shape(r) for r in rows]


def get_current(conn: sqlite3.Connection, *, private: bool = False) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM locations WHERE is_current = 1 LIMIT 1").fetchone()
    if row is None:
        return None
    return (location_private if private else location_public)(row)


def read_weather(conn: sqlite3.Connection, *, location_id: str) -> dict[str, Any] | None:
    """The cached forecast for a location, or None. Carries `fetched_at` so the
    caller can apply the staleness honesty rule."""
    row = conn.execute(
        "SELECT * FROM weather_cache WHERE location_id = ?", (location_id,)
    ).fetchone()
    if row is None:
        return None
    return {
        "location_id": row["location_id"],
        "provider": row["provider"],
        "fetched_at": row["fetched_at"],
        "current": json.loads(row["current_json"] or "{}"),
        "hourly": json.loads(row["hourly_json"] or "[]"),
    }
