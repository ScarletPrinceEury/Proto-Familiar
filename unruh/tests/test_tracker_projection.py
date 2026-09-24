"""Unit tests for the tracker projection reconcile (T-C.3a).

    cd unruh && uv run pytest tests/test_tracker_projection.py

Fresh in-memory DB per test (migrations applied). Deterministic NOW. These
exercise the pure reconcile — mint / dedup / resolve — for both projections;
the loop's gating is tested JS-side.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta

import pytest

from unruh import tracker
from unruh import tracker_projection as proj
from unruh.db import run_migrations

NOW = datetime(2026, 9, 18, 12, 0, 0)


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    run_migrations(c)
    yield c
    c.close()


def _nodes(conn, *, type=None, projection=None):
    rows = conn.execute("SELECT * FROM nodes WHERE layer='schedule'").fetchall()
    out = []
    for r in rows:
        p = json.loads(r["payload_json"] or "{}")
        if type is not None and r["type"] != type:
            continue
        if projection is not None and p.get("projection") != projection:
            continue
        out.append((r, p))
    return out


def _pantry(conn):
    return tracker.create_tracker(conn, label="Pantry", archetype="inventory", schema=[
        {"name": "name", "type": "text", "required": True},
        {"name": "expires", "type": "date"},
    ], config={"project_dates": True})["id"]


def _d(days):
    return (NOW.date() + timedelta(days=days)).isoformat()


def _menses(conn):
    return tracker.create_tracker(conn, label="Menses", archetype="series", sensitive=True, schema=[
        {"name": "flow", "type": "enum", "required": True,
         "values": ["none", "spotting", "light", "medium", "heavy"]},
    ], config={"predict": True})["id"]


# ── Pantry expiry → reminder nodes ────────────────────────────────────────────

def test_pantry_mints_one_reminder_per_expiring_item_and_dedups(conn):
    _pantry_id = _pantry(conn)
    tracker.log_entry(conn, tracker_id=_pantry_id, payload={"name": "spinach", "expires": _d(-1)})
    tracker.log_entry(conn, tracker_id=_pantry_id, payload={"name": "yoghurt", "expires": _d(2)})
    tracker.log_entry(conn, tracker_id=_pantry_id, payload={"name": "rice",    "expires": _d(30)})

    r1 = proj.project_nodes(conn, now=NOW)
    assert r1["minted"] == 2, "spinach + yoghurt (within lead); rice is far off"

    nodes = _nodes(conn, type="reminder", projection=proj.PANTRY_PROJECTION)
    assert len(nodes) == 2
    for row, p in nodes:
        assert p["sensitive"] is True            # stripped on gated turns
        assert p["entry_ref"]                    # dedup key present
        assert p["message"]                      # banner body present
        assert row["when_ts"] is not None        # fireable now
        assert row["resolution"] is None
    labels = sorted(row["label"] for row, _ in nodes)
    assert any("expired" in l for l in labels) and any("2 days" in l for l in labels)

    # Dedup: a second reconcile with unchanged data mints nothing.
    r2 = proj.project_nodes(conn, now=NOW)
    assert r2["minted"] == 0 and r2["resolved"] == 0


def test_pantry_resolves_node_when_item_leaves_the_window(conn):
    pid = _pantry(conn)
    tracker.log_entry(conn, tracker_id=pid, payload={"name": "spinach", "expires": _d(1)})
    tracker.log_entry(conn, tracker_id=pid, payload={"name": "yoghurt", "expires": _d(2)})
    assert proj.project_nodes(conn, now=NOW)["minted"] == 2

    # Re-log spinach far off (used it, bought fresh) — its latest entry leaves
    # the expiring set, so its still-open reminder is resolved `done`.
    tracker.log_entry(conn, tracker_id=pid, payload={"name": "spinach", "expires": _d(40)})
    r = proj.project_nodes(conn, now=NOW)
    assert r["minted"] == 0, "the far-off spinach entry is not projected"
    assert r["resolved"] == 1, "the old spinach reminder is resolved"

    open_reminders = [row for row, p in _nodes(conn, type="reminder") if row["resolution"] is None]
    assert len(open_reminders) == 1 and open_reminders[0]["label"].startswith("Use yoghurt")


def test_pantry_dedups_across_a_fired_node(conn):
    # A reminder that has already fired must never re-mint for the same item.
    pid = _pantry(conn)
    tracker.log_entry(conn, tracker_id=pid, payload={"name": "spinach", "expires": _d(1)})
    assert proj.project_nodes(conn, now=NOW)["minted"] == 1
    row = _nodes(conn, type="reminder")[0][0]
    conn.execute("UPDATE nodes SET resolution='fired' WHERE id=?", (row["id"],))

    r = proj.project_nodes(conn, now=NOW)
    assert r["minted"] == 0, "a fired reminder is still in the dedup set"
    assert r["resolved"] == 0, "a fired node is terminal — not re-resolved"


# ── Menses prediction → hold node ─────────────────────────────────────────────

def test_menses_mints_one_hold_and_dedups(conn):
    mid = _menses(conn)
    for ts in ("2026-06-01T09:00:00", "2026-06-29T09:00:00", "2026-07-27T09:00:00"):
        tracker.log_entry(conn, tracker_id=mid, payload={"flow": "medium"}, ts=ts)

    r1 = proj.project_nodes(conn, now=NOW)
    assert r1["minted"] == 1
    holds = _nodes(conn, type="hold", projection=proj.MENSES_PROJECTION)
    assert len(holds) == 1
    row, p = holds[0]
    assert p["sensitive"] is True
    assert p["cycle_index"] is not None
    assert row["when_ts"] is not None and row["end_ts"] is not None
    assert row["label"] == "Likely period window"

    # Dedup by cycle_index: unchanged prediction mints/updates nothing.
    r2 = proj.project_nodes(conn, now=NOW)
    assert r2["minted"] == 0 and r2["updated"] == 0 and r2["resolved"] == 0


def test_menses_no_hold_under_the_honesty_gate(conn):
    mid = _menses(conn)
    tracker.log_entry(conn, tracker_id=mid, payload={"flow": "medium"}, ts="2026-06-01T09:00:00")
    r = proj.project_nodes(conn, now=NOW)
    assert r["minted"] == 0
    assert _nodes(conn, type="hold", projection=proj.MENSES_PROJECTION) == []


def test_menses_resolves_a_superseded_cycle(conn):
    mid = _menses(conn)
    for ts in ("2026-06-01T09:00:00", "2026-06-29T09:00:00", "2026-07-27T09:00:00"):
        tracker.log_entry(conn, tracker_id=mid, payload={"flow": "medium"}, ts=ts)
    assert proj.project_nodes(conn, now=NOW)["minted"] == 1

    # A fourth cycle start advances cycle_index → new window; the old hold is retired.
    tracker.log_entry(conn, tracker_id=mid, payload={"flow": "medium"}, ts="2026-08-24T09:00:00")
    r = proj.project_nodes(conn, now=NOW)
    assert r["minted"] == 1 and r["resolved"] == 1

    open_holds = [row for row, p in _nodes(conn, type="hold", projection=proj.MENSES_PROJECTION)
                  if row["resolution"] is None]
    assert len(open_holds) == 1, "exactly one live hold — the current cycle"
