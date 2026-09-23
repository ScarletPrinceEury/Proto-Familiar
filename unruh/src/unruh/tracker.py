"""Tracker layer — the ward's private ledgers (build spec: docs/trackers-build-spec.md).

Pure functions over a sqlite3.Connection (the interest.py / schedule.py shape) so
they're trivial to unit-test with an in-memory DB. Four archetypes:

  state     — one field, one current value (laundry: clean/in-progress/dirty).
  inventory — items, each an upsert keyed by a required `name` field (pantry).
  series    — dated entries over time (mood, sleep, meds).
  gauge     — decaying UPKEEP (eating, hydration): an entry is a REFILL; the level
              is derived in code from time-since-last-refill (§10). The safety
              ladder (check-first → crisis) lives at the Node layer, not here.

Exact-values discipline: the model never sets a level or a gauge band — it logs
events; code derives everything. `validate_entry` is the code gate the §5.2
memorization ingest and every `log_entry` pass through; a malformed entry is
dropped/reported, never silently stored wrong.
"""

from __future__ import annotations

import json
import math
import sqlite3
from datetime import datetime, date
from pathlib import Path
from typing import Any

from .db import insert_with_slug_retry, now_iso, to_local_naive

# ── Vocabulary (constants so tests + the MCP layer validate without re-typing) ──

ARCHETYPES = {"state", "inventory", "series", "gauge"}
FIELD_TYPES = {"enum", "number", "scale", "quantity", "date", "text", "text[]", "boolean"}
ENTRY_SOURCES = {"chat", "inferred", "clarified", "send-button"}

DEFAULT_ENTRY_CAP_PER_DAY = 24

# §4 inventory-expiry projection: pantry-class items get a "use first" cue this
# many days before they expire. Pure derivation — code owns the date maths.
EXPIRY_LEAD_DAYS = 3

# Gauge bands, low → critical. `extreme` opens a CHECK at the Node layer (never a
# cue, never an auto-escalation — build spec §10.6).
GAUGE_BANDS = ("fine", "fading", "low", "overdue", "extreme")
TEMPLATES_DIR = Path(__file__).parent / "templates" / "trackers"


# ── Schema validation (pure) ────────────────────────────────────────────────


def validate_schema(schema: Any, archetype: str) -> list[dict[str, Any]]:
    """Validate + normalise a field-spec array. Raises ValueError on anything
    malformed (surfaced to the ward, never stored broken). Returns the cleaned list."""
    if archetype not in ARCHETYPES:
        raise ValueError(f"unknown archetype {archetype!r}; expected one of {sorted(ARCHETYPES)}")
    if schema is None:
        schema = []
    if not isinstance(schema, list):
        raise ValueError("schema must be a list of field specs")

    cleaned: list[dict[str, Any]] = []
    seen: set[str] = set()
    for f in schema:
        if not isinstance(f, dict):
            raise ValueError("each field spec must be an object")
        name = str(f.get("name", "")).strip()
        ftype = str(f.get("type", "")).strip()
        if not name:
            raise ValueError("a field spec is missing `name`")
        if name in seen:
            raise ValueError(f"duplicate field name {name!r}")
        seen.add(name)
        if ftype not in FIELD_TYPES:
            raise ValueError(f"field {name!r}: unknown type {ftype!r}; expected {sorted(FIELD_TYPES)}")
        spec: dict[str, Any] = {"name": name, "type": ftype}
        if f.get("required"):
            spec["required"] = True
        if ftype == "enum":
            values = f.get("values")
            if not isinstance(values, list) or not values:
                raise ValueError(f"field {name!r}: enum needs a non-empty `values` list")
            spec["values"] = [str(v) for v in values]
        if ftype == "scale":
            if not isinstance(f.get("min"), (int, float)) or not isinstance(f.get("max"), (int, float)):
                raise ValueError(f"field {name!r}: scale needs integer `min` and `max`")
            spec["min"], spec["max"] = int(f["min"]), int(f["max"])
        if ftype == "number":
            for k in ("min", "max"):
                if isinstance(f.get(k), (int, float)):
                    spec[k] = f[k]
            if isinstance(f.get("unit"), str):
                spec["unit"] = f["unit"]
        cleaned.append(spec)

    # Archetype shape rules (build spec §1.1).
    if archetype == "state" and len(cleaned) != 1:
        raise ValueError("state archetype needs exactly one field")
    if archetype == "inventory":
        name_field = next((f for f in cleaned if f["name"] == "name"), None)
        if name_field is None or not name_field.get("required"):
            raise ValueError("inventory archetype needs a required `name` field (the item key)")
    return cleaned


def _check_field(spec: dict[str, Any], val: Any) -> tuple[bool, Any, str]:
    """Type-check one value against its spec. Returns (ok, coerced, error)."""
    t = spec["type"]
    if t == "enum":
        return (val in spec["values"], val, f"not one of {spec['values']}")
    if t == "boolean":
        return (isinstance(val, bool), val, "expected true/false")
    if t == "number":
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            return (False, val, "expected a number")
        if "min" in spec and val < spec["min"]:
            return (False, val, f"below min {spec['min']}")
        if "max" in spec and val > spec["max"]:
            return (False, val, f"above max {spec['max']}")
        return (True, val, "")
    if t == "scale":
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            return (False, val, "expected an integer")
        iv = int(val)
        if iv != val or iv < spec["min"] or iv > spec["max"]:
            return (False, val, f"expected an integer in [{spec['min']},{spec['max']}]")
        return (True, iv, "")
    if t == "quantity":
        # {value: number, unit?: str} — a number with a free unit.
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            return (True, {"value": val}, "")
        if isinstance(val, dict) and isinstance(val.get("value"), (int, float)) and not isinstance(val.get("value"), bool):
            out = {"value": val["value"]}
            if isinstance(val.get("unit"), str):
                out["unit"] = val["unit"]
            return (True, out, "")
        return (False, val, "expected a number or {value, unit}")
    if t == "date":
        norm = to_local_naive(val) if isinstance(val, str) else None
        if norm is None:
            return (False, val, "expected a local ISO date/datetime")
        return (True, norm, "")
    if t == "text":
        return (isinstance(val, str), val, "expected text")
    if t == "text[]":
        if isinstance(val, list) and all(isinstance(x, str) for x in val):
            return (True, val, "")
        return (False, val, "expected a list of text")
    return (False, val, f"unknown type {t}")


def validate_entry(schema: Any, payload: Any) -> dict[str, Any]:
    """Validate a payload against a schema. UNKNOWN fields are DROPPED, type
    mismatches rejected, missing `required` fields reported. Pure — no I/O.
    Returns {ok, cleaned, missing, errors}."""
    schema = schema or []
    payload = payload if isinstance(payload, dict) else {}
    cleaned: dict[str, Any] = {}
    missing: list[str] = []
    errors: list[str] = []
    for spec in schema:
        name = spec["name"]
        val = payload.get(name)
        if val is None or (isinstance(val, str) and not val.strip()) or (isinstance(val, list) and not val):
            if spec.get("required"):
                missing.append(name)
            continue
        ok, coerced, err = _check_field(spec, val)
        if ok:
            cleaned[name] = coerced
        else:
            errors.append(f"{name}: {err}")
    return {"ok": not missing and not errors, "cleaned": cleaned, "missing": missing, "errors": errors}


# ── Gauge derivation (pure — build spec §10.2/§10.3) ────────────────────────


def _naive(dt: datetime) -> datetime:
    return dt.replace(tzinfo=None) if dt.tzinfo is not None else dt


def gauge_bands(config: dict[str, Any]) -> dict[str, float]:
    """Pull + validate the four band boundaries (hours) from a gauge config.
    Raises ValueError if not grace ≤ low ≤ overdue ≤ extreme."""
    g = (config or {}).get("gauge", {}) if isinstance(config, dict) else {}
    try:
        grace = float(g["grace_hours"]); low = float(g["low_hours"])
        overdue = float(g["overdue_hours"]); extreme = float(g["extreme_hours"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("gauge config needs numeric grace_hours ≤ low_hours ≤ overdue_hours ≤ extreme_hours")
    if not (0 <= grace <= low <= overdue <= extreme):
        raise ValueError("gauge thresholds must satisfy 0 ≤ grace ≤ low ≤ overdue ≤ extreme")
    return {"grace": grace, "low": low, "overdue": overdue, "extreme": extreme}


def gauge_level(last_refill_ts: str | None, config: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    """Derive a gauge's current level from time since the last refill. PURE — the
    model never sets this. Returns {level: 0..1, band, hours_since}. With no refill
    ever, the gauge reads empty (extreme) — nothing's been tended.
    level: 1.0 through `grace`, linear to 0.0 at `extreme`, clamped [0,1]."""
    b = gauge_bands(config)
    if not last_refill_ts:
        return {"level": 0.0, "band": "extreme", "hours_since": None}
    n = _naive(now) if now is not None else datetime.now()
    try:
        last = _naive(datetime.fromisoformat(last_refill_ts))
    except (TypeError, ValueError):
        return {"level": 0.0, "band": "extreme", "hours_since": None}
    hours = max(0.0, (n - last).total_seconds() / 3600.0)
    if hours < b["grace"]:
        band = "fine"
    elif hours < b["low"]:
        band = "fading"
    elif hours < b["overdue"]:
        band = "low"
    elif hours < b["extreme"]:
        band = "overdue"
    else:
        band = "extreme"
    span = b["extreme"] - b["grace"]
    if hours <= b["grace"]:
        level = 1.0
    elif span <= 0 or hours >= b["extreme"]:
        level = 0.0
    else:
        level = max(0.0, min(1.0, 1.0 - (hours - b["grace"]) / span))
    return {"level": round(level, 4), "band": band, "hours_since": round(hours, 3)}


# ── Writes ──────────────────────────────────────────────────────────────────


def create_tracker(conn: sqlite3.Connection, *, label: str, archetype: str,
                   schema: Any = None, config: Any = None, sensitive: bool = False,
                   template: str | None = None) -> dict[str, Any]:
    """Create a tracker. Validates the schema for the archetype; a gauge config is
    validated too. Returns {ok, id}."""
    if not label or not label.strip():
        raise ValueError("label is required")
    cleaned_schema = validate_schema(schema, archetype)
    cfg = dict(config or {})
    if archetype == "gauge":
        gauge_bands(cfg)  # validate ordering up front
    ts = now_iso()
    tid = insert_with_slug_retry(
        conn,
        """INSERT INTO trackers (id, label, archetype, schema_json, config_json,
                                 sensitive, template, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        lambda tid: (tid, label.strip(), archetype, json.dumps(cleaned_schema),
                     json.dumps(cfg), 1 if sensitive else 0, template, ts, ts),
        label=label, kind="trk",
    )
    return {"ok": True, "id": tid}


def create_from_template(conn: sqlite3.Connection, *, template_id: str) -> dict[str, Any]:
    """Create a tracker from a shipped template JSON (templates/trackers/<id>.json)."""
    path = TEMPLATES_DIR / f"{template_id}.json"
    if not path.exists():
        raise ValueError(f"no tracker template {template_id!r}")
    tpl = json.loads(path.read_text(encoding="utf-8"))
    return create_tracker(
        conn, label=tpl["label"], archetype=tpl["archetype"],
        schema=tpl.get("schema", []), config=tpl.get("config", {}),
        sensitive=bool(tpl.get("sensitive", False)), template=template_id,
    )


def _get_tracker(conn: sqlite3.Connection, tid: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM trackers WHERE id = ?", (tid,)).fetchone()


def log_entry(conn: sqlite3.Connection, *, tracker_id: str, payload: Any = None,
             ts: str | None = None, source: str = "chat",
             supersedes: str | None = None) -> dict[str, Any]:
    """Log one entry (a `gauge` refill is just an entry). Validates against the
    schema; enforces `entry_cap_per_day` — a cap hit returns {ok:false, code:'entry_cap'}
    (never a silent drop). Returns {ok, id, dropped_fields?, missing?}."""
    trk = _get_tracker(conn, tracker_id)
    if trk is None:
        return {"ok": False, "code": "no_tracker", "error": f"no tracker {tracker_id!r}"}
    if source not in ENTRY_SOURCES:
        raise ValueError(f"unknown source {source!r}; expected {sorted(ENTRY_SOURCES)}")
    schema = json.loads(trk["schema_json"] or "[]")
    cfg = json.loads(trk["config_json"] or "{}")

    v = validate_entry(schema, payload)
    if v["missing"]:
        return {"ok": False, "code": "missing_required", "missing": v["missing"], "error": f"missing: {', '.join(v['missing'])}"}
    if v["errors"]:
        return {"ok": False, "code": "invalid", "errors": v["errors"], "error": "; ".join(v["errors"])}

    entry_ts = to_local_naive(ts) or now_iso()
    day = entry_ts[:10]
    cap = int(cfg.get("entry_cap_per_day", DEFAULT_ENTRY_CAP_PER_DAY))
    count = conn.execute(
        "SELECT COUNT(*) AS c FROM tracker_entries WHERE tracker_id = ? AND substr(ts,1,10) = ? AND superseded = 0",
        (tracker_id, day),
    ).fetchone()["c"]
    if count >= cap:
        return {"ok": False, "code": "entry_cap", "error": f"daily cap of {cap} entries reached for this tracker"}

    if supersedes:
        conn.execute("UPDATE tracker_entries SET superseded = 1 WHERE id = ? AND tracker_id = ?",
                     (supersedes, tracker_id))

    created = now_iso()
    eid = insert_with_slug_retry(
        conn,
        """INSERT INTO tracker_entries (id, tracker_id, ts, payload_json, source, superseded, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)""",
        lambda eid: (eid, tracker_id, entry_ts, json.dumps(v["cleaned"]), source, created),
        label=trk["label"], kind="tke",
    )
    out = {"ok": True, "id": eid}
    dropped = [k for k in (payload or {}) if k not in v["cleaned"] and k not in {s["name"] for s in schema}]
    if dropped:
        out["dropped_fields"] = dropped
    return out


def supersede_entry(conn: sqlite3.Connection, *, id: str) -> dict[str, Any]:
    """Mark an entry superseded (kept for audit). Returns {ok, superseded}."""
    cur = conn.execute("UPDATE tracker_entries SET superseded = 1 WHERE id = ? AND superseded = 0", (id,))
    return {"ok": True, "superseded": cur.rowcount}


def adjust_tracker(conn: sqlite3.Connection, *, id: str, label: str | None = None,
                  schema: Any = None, config: Any = None, sensitive: bool | None = None) -> dict[str, Any]:
    """Adjust a tracker. Schema edits are ADDITIVE ONLY — a field may be added,
    never removed or retyped (history must stay valid). Returns {ok} or raises."""
    trk = _get_tracker(conn, id)
    if trk is None:
        return {"ok": False, "error": f"no tracker {id!r}"}
    ts = now_iso()
    sets, args = [], []
    if label and label.strip():
        sets.append("label = ?"); args.append(label.strip())
    if schema is not None:
        old = json.loads(trk["schema_json"] or "[]")
        old_by = {f["name"]: f for f in old}
        new = validate_schema(schema, trk["archetype"])
        for f in new:
            if f["name"] in old_by and old_by[f["name"]] != f:
                raise ValueError(f"field {f['name']!r} can be added, never removed or retyped")
        for name in old_by:
            if name not in {f["name"] for f in new}:
                raise ValueError(f"field {name!r} cannot be removed (history must stay valid)")
        sets.append("schema_json = ?"); args.append(json.dumps(new))
    if config is not None:
        cfg = dict(config)
        if trk["archetype"] == "gauge":
            gauge_bands(cfg)
        sets.append("config_json = ?"); args.append(json.dumps(cfg))
    if sensitive is not None:
        sets.append("sensitive = ?"); args.append(1 if sensitive else 0)
    if not sets:
        return {"ok": True, "unchanged": True}
    sets.append("updated_at = ?"); args.append(ts)
    args.append(id)
    conn.execute(f"UPDATE trackers SET {', '.join(sets)} WHERE id = ?", args)
    return {"ok": True}


def drop_tracker(conn: sqlite3.Connection, *, id: str) -> dict[str, Any]:
    """Delete a tracker and its entries (ward-only surface — never over MCP).
    Returns {ok, dropped}."""
    cur = conn.execute("DELETE FROM trackers WHERE id = ?", (id,))
    return {"ok": True, "dropped": cur.rowcount}


# ── Reads ────────────────────────────────────────────────────────────────────


def _entries(conn: sqlite3.Connection, tid: str, *, days: int | None = None, now: datetime | None = None) -> list[sqlite3.Row]:
    if days is not None:
        n = _naive(now) if now is not None else datetime.now()
        floor = (n - _timedelta_days(days)).isoformat(timespec="seconds")
        return conn.execute(
            "SELECT * FROM tracker_entries WHERE tracker_id = ? AND superseded = 0 AND ts >= ? ORDER BY ts ASC",
            (tid, floor),
        ).fetchall()
    return conn.execute(
        "SELECT * FROM tracker_entries WHERE tracker_id = ? AND superseded = 0 ORDER BY ts ASC",
        (tid,),
    ).fetchall()


def _timedelta_days(days: int):
    from datetime import timedelta
    return timedelta(days=days)


def read_tracker(conn: sqlite3.Connection, *, id: str, days: int = 14, now: datetime | None = None) -> dict[str, Any]:
    """Archetype-aware summary (code, no LLM). state → current value; inventory →
    item list (latest per name); series → windowed entries; gauge → level/band."""
    trk = _get_tracker(conn, id)
    if trk is None:
        return {"ok": False, "error": f"no tracker {id!r}"}
    arch = trk["archetype"]
    cfg = json.loads(trk["config_json"] or "{}")
    base = {"ok": True, "id": id, "label": trk["label"], "archetype": arch, "sensitive": bool(trk["sensitive"])}

    if arch == "gauge":
        last = conn.execute(
            "SELECT ts FROM tracker_entries WHERE tracker_id = ? AND superseded = 0 ORDER BY ts DESC LIMIT 1", (id,),
        ).fetchone()
        g = gauge_level(last["ts"] if last else None, cfg, now=now)
        base.update({"band": g["band"], "level": g["level"], "hours_since": g["hours_since"],
                     "last_refill_at": last["ts"] if last else None})
        return base

    if arch == "state":
        row = conn.execute(
            "SELECT * FROM tracker_entries WHERE tracker_id = ? AND superseded = 0 ORDER BY ts DESC LIMIT 1", (id,),
        ).fetchone()
        base["current"] = json.loads(row["payload_json"]) if row else None
        base["as_of"] = row["ts"] if row else None
        return base

    if arch == "inventory":
        items: dict[str, dict[str, Any]] = {}
        for r in _entries(conn, id):
            p = json.loads(r["payload_json"] or "{}")
            name = p.get("name")
            if name:
                items[name] = {**p, "as_of": r["ts"]}
        base["items"] = list(items.values())
        return base

    # series
    rows = _entries(conn, id, days=days, now=now)
    base["entries"] = [{"id": r["id"], "ts": r["ts"], **json.loads(r["payload_json"] or "{}")} for r in rows]
    base["count"] = len(rows)
    return base


def list_trackers(conn: sqlite3.Connection, *, include_archived: bool = False) -> list[dict[str, Any]]:
    """All trackers (id, label, archetype, sensitive, archived, field names) — the
    legend. Archived trackers are omitted by default (the Familiar's active view);
    the ward-facing management list passes include_archived=True to see them all."""
    where = "" if include_archived else "WHERE archived_at IS NULL"
    rows = conn.execute(f"SELECT * FROM trackers {where} ORDER BY created_at ASC").fetchall()
    out = []
    for r in rows:
        schema = json.loads(r["schema_json"] or "[]")
        out.append({"id": r["id"], "label": r["label"], "archetype": r["archetype"],
                    "sensitive": bool(r["sensitive"]), "archived": r["archived_at"] is not None,
                    "archived_at": r["archived_at"], "fields": [f["name"] for f in schema]})
    return out


def archive_tracker(conn: sqlite3.Connection, *, id: str, archived: bool = True) -> dict[str, Any]:
    """Soft-pause or resume a tracker (ward-facing). Archiving keeps every entry but
    takes the tracker out of the Familiar's active surfaces (list/cues/projections/
    passive capture); un-archiving restores it. A no-op hard delete is drop_tracker.
    Returns {ok, archived} or {ok:false, error} if the tracker is unknown."""
    trk = _get_tracker(conn, id)
    if trk is None:
        return {"ok": False, "error": f"no tracker {id!r}"}
    stamp = now_iso() if archived else None
    conn.execute("UPDATE trackers SET archived_at = ?, updated_at = ? WHERE id = ?", (stamp, now_iso(), id))
    return {"ok": True, "archived": bool(archived)}


# ── Derived signals (all code) ───────────────────────────────────────────────


def stale_trackers(conn: sqlite3.Connection, *, now: datetime | None = None) -> list[dict[str, Any]]:
    """Trackers whose newest entry is older than their `staleness_hours` (a §5.3
    cue candidate). Gauges are excluded — their staleness is the gauge band itself."""
    n = _naive(now) if now is not None else datetime.now()
    out = []
    for r in conn.execute("SELECT * FROM trackers WHERE archetype != 'gauge' AND archived_at IS NULL").fetchall():
        cfg = json.loads(r["config_json"] or "{}")
        hours = cfg.get("staleness_hours")
        if not isinstance(hours, (int, float)):
            continue
        last = conn.execute(
            "SELECT ts FROM tracker_entries WHERE tracker_id = ? AND superseded = 0 ORDER BY ts DESC LIMIT 1", (r["id"],),
        ).fetchone()
        if last is None:
            continue  # never-logged trackers don't nag on staleness
        try:
            elapsed = (n - _naive(datetime.fromisoformat(last["ts"]))).total_seconds() / 3600.0
        except (TypeError, ValueError):
            continue
        if elapsed >= hours:
            out.append({"id": r["id"], "label": r["label"], "hours_since": round(elapsed, 1)})
    return out


def cue_candidates(conn: sqlite3.Connection, *, now: datetime | None = None) -> dict[str, Any]:
    """§5.3 cue candidates: currently-stale trackers, each carrying its
    per-tracker `ask_cap_per_day` so the Node-side cue renderer can pace re-offers
    (0 = never cued, e.g. erp). Gauges are excluded here — their staleness is the
    gauge band, surfaced through the gauge cue path, not this one. The renderer
    owns the aging/dedup; this is just the honest 'what's gone quiet' snapshot."""
    stale = stale_trackers(conn, now=now)
    out = []
    for s in stale:
        r = _get_tracker(conn, s["id"])
        cfg = json.loads(r["config_json"] or "{}") if r is not None else {}
        cap = cfg.get("ask_cap_per_day", 1)
        cap = cap if isinstance(cap, (int, float)) else 1
        out.append({**s, "ask_cap_per_day": cap})
    return {"stale": out}


def _parse_date(s: Any) -> date | None:
    """Best-effort parse of a `date`-field value (day or datetime, local-naive) to
    a date. Returns None on anything unparseable — an item with a junk expiry just
    isn't projected, never crashes the cue."""
    if not s:
        return None
    txt = str(s).strip().replace("Z", "")
    try:
        return datetime.fromisoformat(txt).date()
    except (TypeError, ValueError):
        try:
            return date.fromisoformat(txt[:10])
        except (TypeError, ValueError):
            return None


def expiring_items(conn: sqlite3.Connection, *, within_days: int = EXPIRY_LEAD_DAYS,
                   now: datetime | None = None) -> dict[str, Any]:
    """§4 inventory-expiry projection: pantry-class items (inventory archetype with
    `project_dates`) whose `expires` date is within `within_days` of today —
    already-expired items included (days_left < 0), soonest first. Pure derivation;
    code owns the date maths, the model never computes days-left. Returns
    {items: [{tracker_id, tracker_label, name, expires, days_left, entry_id}]}."""
    n = _naive(now) if now is not None else datetime.now()
    today = n.date()
    out = []
    for trk in conn.execute("SELECT * FROM trackers WHERE archetype='inventory' AND archived_at IS NULL").fetchall():
        cfg = json.loads(trk["config_json"] or "{}")
        if not cfg.get("project_dates"):
            continue
        latest: dict[str, dict[str, Any]] = {}
        for r in _entries(conn, trk["id"]):
            p = json.loads(r["payload_json"] or "{}")
            name = p.get("name")
            if name:
                latest[name] = {**p, "_entry_id": r["id"]}
        for name, p in latest.items():
            d = _parse_date(p.get("expires"))
            if d is None:
                continue
            days_left = (d - today).days
            if days_left <= within_days:
                out.append({
                    "tracker_id": trk["id"], "tracker_label": trk["label"], "name": name,
                    "expires": p.get("expires"), "days_left": days_left, "entry_id": p.get("_entry_id"),
                })
    out.sort(key=lambda x: x["days_left"])
    return {"items": out}


def predictions(conn: sqlite3.Connection, *, now: datetime | None = None) -> dict[str, Any]:
    """§4 prediction candidates: every tracker with `config.predict` on, run through
    predict_windows, keeping only those that clear the honesty gate (a real window,
    i.e. ≥2 completed cycles). Returns {predictions: [{tracker_id, tracker_label,
    window, cycles_seen}]}. Pure arithmetic; the model never computes the dates."""
    out = []
    for trk in conn.execute("SELECT * FROM trackers WHERE archived_at IS NULL").fetchall():
        cfg = json.loads(trk["config_json"] or "{}")
        if not cfg.get("predict"):
            continue
        pr = predict_windows(conn, id=trk["id"], now=now)
        if pr.get("ok") and pr.get("window"):
            out.append({
                "tracker_id": trk["id"], "tracker_label": trk["label"],
                "window": pr["window"], "cycles_seen": pr.get("cycles_seen"),
            })
    return {"predictions": out}


def entry_rate_flag(conn: sqlite3.Connection, *, id: str, now: datetime | None = None) -> dict[str, Any]:
    """Watchdog (§6): a 7-day entry rate > 3× the trailing 28-day median AND ≥10
    entries in the week → flagged. A private reflection signal, never an accusation.
    Returns {flagged, week_count, median_daily}."""
    n = _naive(now) if now is not None else datetime.now()
    from datetime import timedelta
    week_floor = (n - timedelta(days=7)).isoformat(timespec="seconds")
    month_floor = (n - timedelta(days=28)).isoformat(timespec="seconds")
    week_count = conn.execute(
        "SELECT COUNT(*) c FROM tracker_entries WHERE tracker_id=? AND superseded=0 AND ts>=?",
        (id, week_floor),
    ).fetchone()["c"]
    day_rows = conn.execute(
        "SELECT substr(ts,1,10) d, COUNT(*) c FROM tracker_entries "
        "WHERE tracker_id=? AND superseded=0 AND ts>=? GROUP BY d",
        (id, month_floor),
    ).fetchall()
    counts = sorted(r["c"] for r in day_rows)
    median = counts[len(counts) // 2] if counts else 0
    flagged = bool(week_count >= 10 and median > 0 and (week_count / 7.0) > 3 * median)
    return {"flagged": flagged, "week_count": week_count, "median_daily": median}


def predict_windows(conn: sqlite3.Connection, *, id: str, now: datetime | None = None) -> dict[str, Any]:
    """Menses prediction (§4). Honesty gate: needs ≥2 COMPLETED cycles, else no
    window. Mean cycle length over up to the last 6 cycles; window = start ± 3 days
    (a constant, not SD — small-n SD lies). Pure arithmetic; the model never computes
    a date. Returns {ok, window?: {start, end, cycle_index}, cycles_seen}."""
    trk = _get_tracker(conn, id)
    if trk is None:
        return {"ok": False, "error": f"no tracker {id!r}"}
    # Cycle starts = entries whose flow is not 'none'/'spotting', first per run.
    rows = conn.execute(
        "SELECT ts, payload_json FROM tracker_entries WHERE tracker_id=? AND superseded=0 ORDER BY ts ASC", (id,),
    ).fetchall()
    # Cycle starts = a flow entry (light/medium/heavy) that opens a new run — i.e.
    # the first flow after a gap. Gap-based (not consecutive-entry based) so it works
    # whether the ward logs every day of a period OR just once per period.
    CYCLE_GAP_DAYS = 10
    starts: list[datetime] = []
    last_flow: datetime | None = None
    for r in rows:
        flow = json.loads(r["payload_json"] or "{}").get("flow")
        if flow not in ("light", "medium", "heavy"):
            continue
        try:
            d = _naive(datetime.fromisoformat(r["ts"]))
        except (TypeError, ValueError):
            continue
        if last_flow is None or (d - last_flow).days > CYCLE_GAP_DAYS:
            starts.append(d)
        last_flow = d
    if len(starts) < 3:  # ≥2 completed cycles = ≥3 starts
        return {"ok": True, "window": None, "cycles_seen": max(0, len(starts) - 1)}
    gaps = [(starts[i] - starts[i - 1]).days for i in range(1, len(starts))][-6:]
    mean_len = sum(gaps) / len(gaps)
    from datetime import timedelta
    predicted = starts[-1] + timedelta(days=round(mean_len))
    return {"ok": True, "cycles_seen": len(starts) - 1, "window": {
        "start": (predicted - timedelta(days=3)).isoformat(timespec="seconds"),
        "end": (predicted + timedelta(days=3)).isoformat(timespec="seconds"),
        "cycle_index": len(starts),
    }}
