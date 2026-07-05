"""Google-Calendar ingestion → schedule nodes (mechanical, change-gated).

The inbound half of the Google integration (build spec §1). Pure over a
sqlite connection — no network (the Node adapters fetch bytes; `ical.py`
parses them; this maps the normalized events to schedule nodes and
reconciles the whole gcal-sourced set in one shot).

The contract that matters downstream: `gcal_ingest` returns the **change
classification** — `{new, updated, unchanged, removed}` — and ONLY the
`new` ids ever reach the Familiar (the projection cue, §4). A re-sync that
changes nothing returns empty `new` and prompts nothing. This is the
anti-clog guarantee: change detection is code-gated, not LLM-gated.

Reconcile rules (§1.3), keyed by `payload.gcal_uid`:
  - uid unseen                         → add_node + needs_projection  → new
  - uid seen, last_modified advanced   → update in place (keep id +    → updated
    edges + needs_projection)            consequence edges)
  - uid seen, unchanged                → no-op                        → unchanged
  - status=cancelled, or a seen uid    → resolve(node,'cancelled')    → removed
    absent from a confirmed full snapshot (record kept, not hard-deleted)

Two robustness guards on deletion reconcile (the single most important
inbound rule, §1.3):
  - It runs ONLY when `reconcile_deletes=True` AND the snapshot parsed at
    least one event — an empty/failed fetch never cancels everything.
  - It only cancels nodes whose `when_ts` is still in the FUTURE. A past
    event (or an aged-out occurrence of an expanded complex series) absent
    from a forward-looking snapshot has simply happened, not been deleted.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta
from typing import Any

from .db import now_iso, to_local_naive
from . import schedule as sched

# Payload keys the sync OWNS (overwritten on every update). Everything else
# in an existing node's payload — needs_projection, per-occurrence
# resolutions, anything the Familiar attached — is preserved across updates.
_SYNC_OWNED_KEYS = (
    "source", "gcal_uid", "gcal_last_modified", "all_day",
    "location", "description", "recurrence", "gcal_expanded_from",
    "gcal_calendar_id", "gcal_attribution",
)


def _sync_payload(ev: dict[str, Any]) -> dict[str, Any]:
    """The sync-owned payload fields for a normalized event."""
    out: dict[str, Any] = {
        "source": "gcal",
        "gcal_uid": ev["uid"],
        "gcal_last_modified": ev.get("last_modified"),
        "all_day": bool(ev.get("all_day")),
    }
    if ev.get("location"):
        out["location"] = ev["location"]
    if ev.get("description"):
        out["description"] = ev["description"]
    if ev.get("recurrence"):
        out["recurrence"] = ev["recurrence"]
    if ev.get("expanded_from"):
        out["gcal_expanded_from"] = ev["expanded_from"]
    # Which source calendar this event came from (multi-calendar support) and,
    # if the ward/Familiar told us, who that calendar belongs to. Both are
    # sync-owned: refreshed from the snapshot + the attribution map each pass.
    if ev.get("gcal_calendar_id"):
        out["gcal_calendar_id"] = ev["gcal_calendar_id"]
    if ev.get("gcal_attribution"):
        out["gcal_attribution"] = ev["gcal_attribution"]
    return out


def _is_gcal_event(node) -> bool:
    """A node the deletion-reconcile is ALLOWED to cancel: a genuine Google
    *event*, never a hand-authored phase / need / recurring routine. The
    reconcile query already filters source == 'gcal', but this is the
    belt-and-suspenders guard against a mislabeled node ever being erased
    (the routines/phases data-loss guard). type must be 'event', and it must
    carry no recurrence and not be a tracked need."""
    if node["type"] != "event":
        return False
    payload = json.loads(node["payload_json"] or "{}")
    if payload.get("recurrence") or payload.get("need"):
        return False
    return True


def dedupe_gcal_nodes(
    conn: sqlite3.Connection,
    *,
    calendar_id: str | None = None,
    include_legacy: bool = False,
) -> tuple[dict[str, sqlite3.Row], list[str]]:
    """Sync-managed nodes (payload.source == 'gcal') keyed by gcal_uid, plus
    the ids of unresolved DUPLICATE nodes that should be cancelled.

    When `calendar_id` is given, the set is SCOPED to that source calendar
    (multi-calendar): a snapshot of calendar A must never reconcile calendar
    B's events. `include_legacy` also folds in nodes with no stored
    gcal_calendar_id — the pre-multi-calendar rows, which belonged to the
    single calendar then in use; the ward's own calendar adopts them on its
    next sync (its ingest stamps the id). With no calendar_id, every gcal node
    is returned (single-calendar / back-compat behaviour).

    Historically the ingest could create two nodes with one gcal_uid (a
    RECURRENCE-ID override sharing its series' UID before the parser learned
    to split them). Reconcile needs exactly one live node per uid, so per uid
    we keep the best row — unresolved beats resolved, then the most recently
    updated — and report the other unresolved rows as duplicates for the
    caller to cancel. Resolved extras are history; they stay.
    """
    rows = conn.execute(
        """SELECT * FROM nodes
            WHERE layer = 'schedule'
              AND json_extract(payload_json, '$.source') = 'gcal'
            ORDER BY updated_at ASC, id ASC"""
    ).fetchall()
    out: dict[str, sqlite3.Row] = {}
    duplicates: list[str] = []
    for r in rows:
        payload = json.loads(r["payload_json"] or "{}")
        uid = payload.get("gcal_uid")
        if not uid:
            continue
        if calendar_id is not None:
            row_cal = payload.get("gcal_calendar_id")
            if row_cal != calendar_id and not (include_legacy and not row_cal):
                continue  # a different calendar's node — out of this snapshot's scope
        prev = out.get(uid)
        if prev is None:
            out[uid] = r
            continue
        # Prefer the unresolved row; among equals, the later-updated one
        # (rows arrive updated_at-ascending, so `r` is the later).
        prev_open, r_open = prev["resolution"] is None, r["resolution"] is None
        keep, drop = (r, prev) if (r_open or not prev_open) else (prev, r)
        out[uid] = keep
        if drop["resolution"] is None:
            duplicates.append(drop["id"])
    return out, duplicates


def list_gcal_nodes(conn: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    """Every schedule node the sync manages, keyed by gcal_uid — one row per
    uid (the keeper row when historical duplicates exist)."""
    out, _ = dedupe_gcal_nodes(conn)
    return out


def _content_differs(existing: sqlite3.Row, ev: dict[str, Any]) -> bool:
    """Whether the mapped fields of `ev` differ from the stored node — used
    when a feed omits LAST-MODIFIED so we can't trust the timestamp alone."""
    if existing["label"] != (ev.get("summary") or "(untitled)"):
        return True
    if (existing["when_ts"] or None) != (to_local_naive(ev.get("start")) or None):
        return True
    if (existing["end_ts"] or None) != (to_local_naive(ev.get("end")) or None):
        return True
    old = json.loads(existing["payload_json"] or "{}")
    new = _sync_payload(ev)
    return any(old.get(k) != v for k, v in new.items())


def projection_candidates(
    conn: sqlite3.Connection,
    *,
    now: str | None = None,
    horizon_days: int = 14,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """gcal-sourced nodes that still want the Familiar's projection (§4).

    The cue feed: items flagged `needs_projection` on first insert, still
    open, falling inside the upcoming horizon — and with NO outgoing
    consequence edge yet. That last clause is the auto-clear (§4.3): the
    moment the Familiar attaches a `causes`/`co_occurs_with` edge, the item
    drops out by pure derivation, no bookkeeping call. Updated/unchanged/
    removed items never carry the flag, so they never appear here.

    Returns [{id, label, when}], soonest first — the JS cue layer applies
    the per-turn cap and the turn/time aging on top.
    """
    now_local = now or now_iso()
    try:
        horizon = (datetime.fromisoformat(now_local) + timedelta(days=horizon_days)).isoformat(timespec="seconds")
    except (TypeError, ValueError):
        horizon = (datetime.now() + timedelta(days=horizon_days)).isoformat(timespec="seconds")
    rows = conn.execute(
        """SELECT id, label, when_ts FROM nodes
            WHERE layer = 'schedule'
              AND json_extract(payload_json, '$.source') = 'gcal'
              AND json_extract(payload_json, '$.needs_projection') = 1
              AND resolution IS NULL
              AND when_ts IS NOT NULL
              AND when_ts BETWEEN ? AND ?
              AND id NOT IN (
                SELECT src_id FROM edges WHERE kind IN ('causes', 'co_occurs_with')
              )
            ORDER BY when_ts ASC
            LIMIT ?""",
        (now_local, horizon, limit),
    ).fetchall()
    return [{"id": r["id"], "label": r["label"], "when": r["when_ts"]} for r in rows]


def gcal_ingest(
    conn: sqlite3.Connection,
    *,
    ics_text: str | None = None,
    events: list[dict[str, Any]] | None = None,
    reconcile_deletes: bool = True,
    now: str | None = None,
    calendar_id: str | None = None,
    include_legacy: bool = False,
    attribution: dict | None = None,
) -> dict[str, Any]:
    """Reconcile a Google-Calendar snapshot into the schedule layer.

    Pass EITHER `ics_text` (a raw `.ics` feed — parsed here via ical.py) OR
    `events` (already-normalized events from the gogcli/gcalcli adapters).
    Returns `{ok, new, updated, unchanged, removed, complex_series}` — the
    id lists the sync loop routes (only `new` reaches the projection cue).

    `calendar_id` scopes the reconcile to ONE source calendar (multi-calendar):
    dedupe + deletion only ever touch that calendar's nodes, so calendar A's
    snapshot never disturbs calendar B. `include_legacy` folds pre-multi-
    calendar rows (no stored calendar id) into this calendar's scope — set for
    the ward's own calendar so it adopts the old single-calendar rows. When
    `calendar_id` is None the behaviour is the original single-calendar one.
    """
    from . import ical  # local import keeps the module import-light

    now_local = now or now_iso()
    complex_series: list[str] = []
    if events is None:
        # Anchor the §1.4 fallback-expansion horizon to the SAME `now` the rest
        # of this call uses (deletion reconcile, and the projection horizon
        # downstream), instead of letting parse_ical default to the wall clock.
        # Identical in production (now is real-now everywhere) but keeps the
        # horizon consistent and the whole call deterministic under a passed now.
        try:
            parse_now = datetime.fromisoformat(now_local)
        except (TypeError, ValueError):
            parse_now = None
        parsed = ical.parse_ical(ics_text or "", now=parse_now)
        events = parsed["events"]
        complex_series = parsed["complex_series"]
    events = events or []

    # Stamp the source calendar + its attribution onto every event in this
    # snapshot (the single stamping point, so the iCal path — parsed here — is
    # attributed the same as the pre-normalized native/CLI events). _sync_payload
    # then persists both onto each node.
    if calendar_id or attribution is not None:
        for ev in events:
            if not isinstance(ev, dict):
                continue
            if calendar_id and not ev.get("gcal_calendar_id"):
                ev["gcal_calendar_id"] = calendar_id
            if attribution is not None:
                ev["gcal_attribution"] = attribution

    existing, duplicate_ids = dedupe_gcal_nodes(
        conn, calendar_id=calendar_id, include_legacy=include_legacy,
    )
    seen_uids: set[str] = set()
    new_ids: list[str] = []
    updated_ids: list[str] = []
    unchanged_ids: list[str] = []
    removed_ids: list[str] = []

    # Heal historical duplicates (two live nodes sharing one gcal_uid):
    # cancel every non-keeper so the ward's schedule shows each Google
    # event exactly once again.
    for did in duplicate_ids:
        sched.resolve(conn, id=did, resolution="cancelled")
        removed_ids.append(did)

    for ev in events:
        uid = ev.get("uid")
        if not uid or uid in seen_uids:
            # A repeated uid within one snapshot would make the reconcile
            # flip-flop and duplicate nodes; first occurrence wins, the
            # rest are a feed anomaly (the parser splits legitimate
            # RECURRENCE-ID overrides into distinct uids upstream).
            continue
        seen_uids.add(uid)
        node = existing.get(uid)
        cancelled = ev.get("status") == "cancelled"

        if node is None:
            if cancelled:
                continue  # never-seen + already cancelled → nothing to do
            payload = _sync_payload(ev)
            payload["needs_projection"] = True  # first insert only (§1.2)
            try:
                nid = sched.add_node(
                    conn, type="event", label=ev.get("summary") or "(untitled)",
                    when=ev.get("start"), end=ev.get("end"), payload=payload,
                )
                new_ids.append(nid)
            except ValueError:
                continue  # a malformed event is skipped, not fatal
            continue

        if cancelled:
            sched.resolve(conn, id=node["id"], resolution="cancelled")
            removed_ids.append(node["id"])
            continue

        # Skip when LAST-MODIFIED is present and not advanced; otherwise diff.
        stored_lm = json.loads(node["payload_json"] or "{}").get("gcal_last_modified")
        incoming_lm = ev.get("last_modified")
        if incoming_lm and stored_lm and incoming_lm <= stored_lm:
            unchanged_ids.append(node["id"])
            continue
        if not _content_differs(node, ev):
            unchanged_ids.append(node["id"])
            continue

        # Update in place — keep the node id (and its consequence edges), and
        # preserve every non-sync-owned payload key (needs_projection, etc).
        merged = json.loads(node["payload_json"] or "{}")
        merged.update(_sync_payload(ev))
        sched.update_node(
            conn, id=node["id"], label=ev.get("summary") or "(untitled)",
            when=ev.get("start"), end=ev.get("end"), payload=merged,
        )
        updated_ids.append(node["id"])

    # Deletion reconcile — only on a confirmed-good full snapshot that parsed
    # at least one event, and only for still-future nodes (§1.3 guards).
    # `existing` is already scoped to source == 'gcal' (and, when given, to
    # this calendar_id), but _is_gcal_event is the hard data-loss guard: a
    # phase, a need-window, or a recurring routine is NEVER cancelled here,
    # even if something mislabeled it — deletion touches genuine Google events
    # only.
    if reconcile_deletes and events:
        for uid, node in existing.items():
            if uid in seen_uids or node["resolution"]:
                continue
            if not _is_gcal_event(node):
                continue  # never cancel a phase / need / recurring node
            when_local = to_local_naive(node["when_ts"]) if node["when_ts"] else None
            if when_local and when_local < now_local:
                continue  # past / aged-out occurrence → not a deletion
            sched.resolve(conn, id=node["id"], resolution="cancelled")
            removed_ids.append(node["id"])

    return {
        "ok": True,
        "new": new_ids,
        "updated": updated_ids,
        "unchanged": unchanged_ids,
        "removed": removed_ids,
        "complex_series": complex_series,
    }
