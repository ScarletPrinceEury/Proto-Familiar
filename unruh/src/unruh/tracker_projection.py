"""T-C.3a — persistent projection NODES for trackers (§4).

Pure-code reconciliation, run on a slow tick from the Node side (the
tracker-projection loop → `tracker_project` MCP tool). It mints, updates,
and resolves ward-private schedule nodes for two projections, so the
derived lines shipped in T-C.1/T-C.2 gain durable, actionable schedule
citizens:

  - **pantry expiry → a `reminder` node** per near-expiry inventory item.
    Ward decision (2026-09): the node fires a banner the moment an item
    enters the `EXPIRY_LEAD_DAYS` window. Dedup is on `entry_id`, so each
    logged item fires **exactly once** — a grocery haul fires its banners,
    but no item ever re-nags. A still-open node whose item left the
    expiring set (consumed / superseded / re-logged with a new expiry) is
    resolved `done`.

  - **menses window → ONE `hold` node** ("likely period window") per
    predicted cycle. A hold is negative space (the availability
    derivation counts it BUSY so nothing is booked over it); it never
    fires a banner. Deduped by `cycle_index`; a superseded prediction's
    hold is resolved `cancelled`, and if the honesty gate stops returning
    a window (fewer than two completed cycles) any live hold is retired.

Both node kinds carry `payload.sensitive = True`, so gated (villager)
turns strip them (stripSensitiveScheduleNodes). Code owns every date and
every count; the model never enters this path (it is not composed into the
Familiar's toolset — reached only from the projection loop).
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from typing import Any

from . import schedule as sched
from . import tracker as trk
from .db import now_iso, to_local_naive

PANTRY_PROJECTION = "tracker-expiry"
MENSES_PROJECTION = "tracker-menses"


def _projection_nodes(conn: sqlite3.Connection, projection: str) -> list[sqlite3.Row]:
    """Every schedule node this projection has ever minted, any resolution —
    the dedup set needs fired/resolved rows too, so a fired reminder never
    re-mints for the same item."""
    return conn.execute(
        "SELECT id, when_ts, end_ts, label, payload_json, resolution "
        "FROM nodes WHERE layer='schedule' "
        "AND json_extract(payload_json, '$.projection') = ?",
        (projection,),
    ).fetchall()


def _now_iso(now: datetime | None) -> str:
    """Local-naive 'now' for a minted reminder's fire time. Honours an
    injected `now` (tests) but defaults to the ward-local clock (db.now_iso,
    the same clock the reminders scheduler fires against)."""
    return now.isoformat(timespec="seconds") if now is not None else now_iso()


def _expiry_label(name: str, days_left: int) -> str:
    if days_left < 0:
        return f"Use {name} (expired)"
    if days_left == 0:
        return f"Use {name} (expires today)"
    if days_left == 1:
        return f"Use {name} (expires tomorrow)"
    return f"Use {name} (expires in {days_left} days)"


def _expiry_message(name: str, days_left: int) -> str:
    # First-person, plain, said once — the study-partner register, not a
    # mission statement (CLAUDE.md voice rule).
    if days_left < 0:
        return f"The {name} I've got logged is past its date — worth a look before you use it."
    if days_left == 0:
        return f"Heads up — the {name} I've got logged expires today. Good one to use if you can."
    if days_left == 1:
        return f"Heads up — the {name} I've got logged expires tomorrow."
    return f"Heads up — the {name} I've got logged expires in {days_left} days. Might be worth using soon."


def _project_pantry(conn: sqlite3.Connection, *, now: datetime | None, result: dict[str, int]) -> None:
    desired = trk.expiring_items(conn, now=now).get("items", [])
    existing = _projection_nodes(conn, PANTRY_PROJECTION)

    seen_entries: dict[str, list[sqlite3.Row]] = {}
    for r in existing:
        p = json.loads(r["payload_json"] or "{}")
        eid = p.get("entry_ref")
        if eid:
            seen_entries.setdefault(eid, []).append(r)

    desired_ids: set[str] = set()
    for item in desired:
        eid = item.get("entry_id")
        if not eid:
            continue
        desired_ids.add(eid)
        if eid in seen_entries:
            continue  # dedup: this item already has a node — never re-nag.
        sched.add_node(
            conn,
            type="reminder",
            label=_expiry_label(item["name"], item["days_left"]),
            when=_now_iso(now),
            payload={
                "projection": PANTRY_PROJECTION,
                "tracker_ref": item["tracker_id"],
                "entry_ref": eid,
                "sensitive": True,
                "message": _expiry_message(item["name"], item["days_left"]),
            },
        )
        result["minted"] += 1

    # A still-open node whose item left the expiring set was consumed /
    # superseded / re-logged — resolve it (a fired node stays fired).
    for eid, rows in seen_entries.items():
        if eid in desired_ids:
            continue
        for r in rows:
            if r["resolution"] is None:
                sched.resolve(conn, id=r["id"], resolution="done")
                result["resolved"] += 1


def _project_menses(conn: sqlite3.Connection, *, now: datetime | None, result: dict[str, int]) -> None:
    preds = trk.predictions(conn, now=now).get("predictions", [])
    existing = _projection_nodes(conn, MENSES_PROJECTION)

    live_by_cycle: dict[tuple[Any, Any], sqlite3.Row] = {}
    for r in existing:
        if r["resolution"] is not None:
            continue
        p = json.loads(r["payload_json"] or "{}")
        live_by_cycle[(p.get("tracker_ref"), p.get("cycle_index"))] = r

    desired_keys: set[tuple[Any, Any]] = set()
    for pred in preds:
        w = pred.get("window") or {}
        ci = w.get("cycle_index")
        tid = pred.get("tracker_id")
        if ci is None or not w.get("start"):
            continue
        key = (tid, ci)
        desired_keys.add(key)
        row = live_by_cycle.get(key)
        if row is None:
            sched.add_node(
                conn,
                type="hold",
                label="Likely period window",
                when=w["start"],
                end=w.get("end"),
                payload={
                    "projection": MENSES_PROJECTION,
                    "tracker_ref": tid,
                    "cycle_index": ci,
                    "sensitive": True,
                },
            )
            result["minted"] += 1
        else:
            start = to_local_naive(w["start"])
            end = to_local_naive(w.get("end"))
            if row["when_ts"] != start or row["end_ts"] != end:
                sched.update_node(conn, id=row["id"], when=w["start"], end=w.get("end"))
                result["updated"] += 1

    # A live hold for a superseded cycle (or one whose prediction vanished
    # under the honesty gate) is no longer the current forecast — retire it.
    for key, row in live_by_cycle.items():
        if key not in desired_keys:
            sched.resolve(conn, id=row["id"], resolution="cancelled")
            result["resolved"] += 1


def project_nodes(conn: sqlite3.Connection, *, now: datetime | None = None) -> dict[str, Any]:
    """Reconcile both projections in one transaction. Returns
    {ok, minted, updated, resolved}. Never raises on empty data — an install
    with no pantry/menses trackers simply reconciles nothing."""
    result = {"minted": 0, "updated": 0, "resolved": 0}
    _project_pantry(conn, now=now, result=result)
    _project_menses(conn, now=now, result=result)
    return {"ok": True, **result}
