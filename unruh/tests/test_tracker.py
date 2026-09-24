"""Unit tests for the tracker layer (T-A).

    cd unruh && uv run pytest tests/test_tracker.py

Fresh in-memory DB per test (migrations applied, so 0007_trackers is live).
Deterministic timestamps so decay/gauge maths never flakes on real elapsing.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta

import pytest

from unruh import tracker
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


# ── validate_schema ──────────────────────────────────────────────────────────

def test_validate_schema_archetype_rules():
    # state needs exactly one field
    with pytest.raises(ValueError):
        tracker.validate_schema([], "state")
    with pytest.raises(ValueError):
        tracker.validate_schema([{"name": "a", "type": "text"}, {"name": "b", "type": "text"}], "state")
    tracker.validate_schema([{"name": "state", "type": "enum", "required": True, "values": ["clean", "dirty"]}], "state")
    # inventory needs a required `name`
    with pytest.raises(ValueError):
        tracker.validate_schema([{"name": "qty", "type": "number"}], "inventory")
    tracker.validate_schema([{"name": "name", "type": "text", "required": True}], "inventory")
    # enum needs values; unknown type rejected; duplicate names rejected
    with pytest.raises(ValueError):
        tracker.validate_schema([{"name": "m", "type": "enum"}], "series")
    with pytest.raises(ValueError):
        tracker.validate_schema([{"name": "m", "type": "weird"}], "series")
    with pytest.raises(ValueError):
        tracker.validate_schema([{"name": "m", "type": "text"}, {"name": "m", "type": "text"}], "series")


# ── validate_entry (the §5.2 ingest / log gate) ──────────────────────────────

def test_validate_entry_drops_unknown_checks_types_reports_missing():
    schema = [
        {"name": "mood", "type": "enum", "required": True, "values": ["good", "low"]},
        {"name": "note", "type": "text"},
        {"name": "score", "type": "scale", "min": 0, "max": 10},
    ]
    # unknown field dropped; good is valid; note kept
    v = tracker.validate_entry(schema, {"mood": "good", "note": "fine", "junk": "x"})
    assert v["ok"] is True
    assert v["cleaned"] == {"mood": "good", "note": "fine"}
    # missing required
    v = tracker.validate_entry(schema, {"note": "x"})
    assert v["ok"] is False and v["missing"] == ["mood"]
    # bad enum + out-of-range scale → errors, not stored
    v = tracker.validate_entry(schema, {"mood": "purple", "score": 99})
    assert v["ok"] is False and len(v["errors"]) == 2
    # boolean/number strictness (a string is not a number)
    assert tracker.validate_entry([{"name": "h", "type": "number"}], {"h": "8"})["ok"] is False
    assert tracker.validate_entry([{"name": "b", "type": "boolean"}], {"b": True})["ok"] is True


# ── create / log / read per archetype ────────────────────────────────────────

def test_series_create_log_read(conn):
    tid = tracker.create_tracker(conn, label="Mood", archetype="series", sensitive=True, schema=[
        {"name": "mood", "type": "enum", "required": True, "values": ["good", "low"]},
    ])["id"]
    assert tracker.log_entry(conn, tracker_id=tid, payload={"mood": "good"}, ts="2026-09-18T09:00:00")["ok"]
    assert tracker.log_entry(conn, tracker_id=tid, payload={"mood": "low"}, ts="2026-09-18T18:00:00")["ok"]
    r = tracker.read_tracker(conn, id=tid, now=NOW)
    assert r["archetype"] == "series" and r["count"] == 2
    assert [e["mood"] for e in r["entries"]] == ["good", "low"]  # oldest-first


def test_state_read_is_current_value(conn):
    tid = tracker.create_tracker(conn, label="Laundry", archetype="state", schema=[
        {"name": "state", "type": "enum", "required": True, "values": ["clean", "dirty"]},
    ])["id"]
    tracker.log_entry(conn, tracker_id=tid, payload={"state": "dirty"}, ts="2026-09-17T10:00:00")
    tracker.log_entry(conn, tracker_id=tid, payload={"state": "clean"}, ts="2026-09-18T10:00:00")
    r = tracker.read_tracker(conn, id=tid, now=NOW)
    assert r["current"] == {"state": "clean"}


def test_inventory_read_latest_per_name(conn):
    tid = tracker.create_tracker(conn, label="Pantry", archetype="inventory", schema=[
        {"name": "name", "type": "text", "required": True}, {"name": "qty", "type": "quantity"},
    ])["id"]
    tracker.log_entry(conn, tracker_id=tid, payload={"name": "spinach", "qty": 1}, ts="2026-09-17T10:00:00")
    tracker.log_entry(conn, tracker_id=tid, payload={"name": "spinach", "qty": 2}, ts="2026-09-18T10:00:00")
    r = tracker.read_tracker(conn, id=tid, now=NOW)
    assert len(r["items"]) == 1 and r["items"][0]["qty"] == {"value": 2}


def test_log_missing_required_and_invalid_never_stored(conn):
    tid = tracker.create_tracker(conn, label="Sleep", archetype="series", schema=[
        {"name": "hours", "type": "number", "required": True, "min": 0, "max": 24},
    ])["id"]
    assert tracker.log_entry(conn, tracker_id=tid, payload={})["code"] == "missing_required"
    assert tracker.log_entry(conn, tracker_id=tid, payload={"hours": 99})["code"] == "invalid"
    assert tracker.read_tracker(conn, id=tid, now=NOW)["count"] == 0


def test_entry_cap_per_day_refuses_not_drops(conn):
    tid = tracker.create_tracker(conn, label="X", archetype="series",
                                 schema=[{"name": "n", "type": "text"}], config={"entry_cap_per_day": 2})["id"]
    for i in range(2):
        assert tracker.log_entry(conn, tracker_id=tid, payload={"n": str(i)}, ts=f"2026-09-18T0{i}:00:00")["ok"]
    over = tracker.log_entry(conn, tracker_id=tid, payload={"n": "3"}, ts="2026-09-18T05:00:00")
    assert over["ok"] is False and over["code"] == "entry_cap"


def test_supersede_and_adjust_additive_only(conn):
    tid = tracker.create_tracker(conn, label="X", archetype="series",
                                 schema=[{"name": "a", "type": "text"}])["id"]
    e = tracker.log_entry(conn, tracker_id=tid, payload={"a": "1"}, ts="2026-09-18T01:00:00")["id"]
    tracker.supersede_entry(conn, id=e)
    assert tracker.read_tracker(conn, id=tid, now=NOW)["count"] == 0
    # additive edit OK
    assert tracker.adjust_tracker(conn, id=tid, schema=[{"name": "a", "type": "text"}, {"name": "b", "type": "text"}])["ok"]
    # removing/retyping a field is refused
    with pytest.raises(ValueError):
        tracker.adjust_tracker(conn, id=tid, schema=[{"name": "a", "type": "number"}, {"name": "b", "type": "text"}])
    with pytest.raises(ValueError):
        tracker.adjust_tracker(conn, id=tid, schema=[{"name": "a", "type": "text"}])


# ── gauge (§10) ──────────────────────────────────────────────────────────────

GCFG = {"gauge": {"grace_hours": 3, "low_hours": 6, "overdue_hours": 12, "extreme_hours": 48}}

def test_gauge_level_bands_and_boundaries():
    assert tracker.gauge_level(None, GCFG)["band"] == "extreme"  # never tended
    at = lambda h: tracker.gauge_level((NOW - timedelta(hours=h)).isoformat(), GCFG, now=NOW)
    assert at(1)["band"] == "fine" and at(1)["level"] == 1.0
    assert at(4)["band"] == "fading"
    assert at(8)["band"] == "low"
    assert at(20)["band"] == "overdue"
    assert at(50)["band"] == "extreme" and at(50)["level"] == 0.0
    # monotonic decay between grace and extreme
    assert at(10)["level"] < at(4)["level"] < 1.0
    # EXACT boundaries (G3): each threshold is the exclusive floor of the NEXT
    # band — at exactly grace/low/overdue/extreme hours the higher band owns it.
    assert at(3)["band"]  == "fading"    # grace boundary
    assert at(6)["band"]  == "low"       # low boundary
    assert at(12)["band"] == "overdue"   # overdue boundary
    assert at(48)["band"] == "extreme"   # extreme boundary
    assert at(3)["level"] == 1.0         # still full at the grace edge

def test_gauge_config_ordering_validated():
    with pytest.raises(ValueError):
        tracker.create_tracker(conn=sqlite3.connect(":memory:"), label="bad", archetype="gauge",
                               config={"gauge": {"grace_hours": 10, "low_hours": 5, "overdue_hours": 12, "extreme_hours": 48}})

def test_gauge_refill_read(conn):
    tid = tracker.create_tracker(conn, label="Hydration", archetype="gauge", config=GCFG)["id"]
    tracker.log_entry(conn, tracker_id=tid, payload={}, ts=(NOW - timedelta(hours=4)).isoformat())
    r = tracker.read_tracker(conn, id=tid, now=NOW)
    assert r["archetype"] == "gauge" and r["band"] == "fading" and 0.0 < r["level"] < 1.0
    # config rides along (§10.3) so a UI meter can render the thresholds.
    assert r["config"] == GCFG["gauge"] and r["last_refill_at"] is not None


def test_gauge_refill_tops_it_back_to_full(conn):
    # A gauge refill is a plain empty-payload entry (§10.4) — its existence is
    # the signal. Backs the one-tap UI refill AND passive memorization refills.
    gid = tracker.create_tracker(conn, label="Water", archetype="gauge", config=GCFG)["id"]
    tracker.log_entry(conn, tracker_id=gid, payload={}, ts=(NOW - timedelta(hours=20)).isoformat())
    assert tracker.read_tracker(conn, id=gid, now=NOW)["band"] == "overdue"
    # Refill "now" → back to full/fine.
    assert tracker.log_entry(conn, tracker_id=gid, payload={}, ts=NOW.isoformat())["ok"]
    r = tracker.read_tracker(conn, id=gid, now=NOW)
    assert r["band"] == "fine" and r["level"] == 1.0


def test_gauge_cue_candidates_only_low_and_overdue(conn):
    def gauge(label, hours_ago):
        gid = tracker.create_tracker(conn, label=label, archetype="gauge", config=GCFG)["id"]
        tracker.log_entry(conn, tracker_id=gid, payload={}, ts=(NOW - timedelta(hours=hours_ago)).isoformat())
        return gid
    gauge("Fresh",   1)    # fine     → no cue
    gauge("Fading",  4)    # fading   → no cue (headroom)
    gauge("Water",   8)    # low      → gentle cue
    gauge("Meals",   20)   # overdue  → firmer cue
    gauge("Starved", 50)   # extreme  → opens a CHECK, never a cue
    arch = gauge("ArchLow", 8)
    tracker.archive_tracker(conn, id=arch, archived=True)   # archived → excluded

    out = tracker.gauge_cue_candidates(conn, now=NOW)["gauges"]
    by_label = {g["label"]: g for g in out}
    assert set(by_label) == {"Water", "Meals"}, "only low + overdue cue; fine/fading/extreme/archived excluded"
    assert by_label["Water"]["band"] == "low" and by_label["Meals"]["band"] == "overdue"
    assert by_label["Water"]["ask_cap_per_day"] == 1 and "hours_since" in by_label["Water"]


# ── templates + derived signals ──────────────────────────────────────────────

def test_create_from_template(conn):
    for tpl in ("laundry", "pantry", "mood", "sleep", "hydration", "meals"):
        out = tracker.create_from_template(conn, template_id=tpl)
        assert out["ok"]
    names = {t["label"] for t in tracker.list_trackers(conn)}
    assert {"Laundry", "Pantry", "Mood", "Sleep", "Hydration", "Meals"} <= names
    with pytest.raises(ValueError):
        tracker.create_from_template(conn, template_id="nope")

def test_stale_trackers(conn):
    tid = tracker.create_tracker(conn, label="Mood", archetype="series",
                                 schema=[{"name": "m", "type": "text"}], config={"staleness_hours": 24})["id"]
    tracker.log_entry(conn, tracker_id=tid, payload={"m": "x"}, ts=(NOW - timedelta(hours=40)).isoformat())
    stale = tracker.stale_trackers(conn, now=NOW)
    assert any(s["id"] == tid for s in stale)
    # a fresh entry clears it
    tracker.log_entry(conn, tracker_id=tid, payload={"m": "y"}, ts=(NOW - timedelta(hours=1)).isoformat())
    assert not any(s["id"] == tid for s in tracker.stale_trackers(conn, now=NOW))

def test_cue_candidates_attach_ask_cap_and_exclude_gauges(conn):
    # A stale series carries its ask_cap_per_day for the Node cue renderer.
    mid = tracker.create_tracker(conn, label="Mood", archetype="series",
                                 schema=[{"name": "m", "type": "text"}],
                                 config={"staleness_hours": 24, "ask_cap_per_day": 1})["id"]
    tracker.log_entry(conn, tracker_id=mid, payload={"m": "x"}, ts=(NOW - timedelta(hours=40)).isoformat())
    # An ERP-style ledger opts out of cues (ask_cap 0) but is still reported so
    # the renderer — not this layer — is the single place that decides.
    eid = tracker.create_tracker(conn, label="Erp", archetype="series",
                                 schema=[{"name": "t", "type": "text"}],
                                 config={"staleness_hours": 24, "ask_cap_per_day": 0})["id"]
    tracker.log_entry(conn, tracker_id=eid, payload={"t": "x"}, ts=(NOW - timedelta(hours=40)).isoformat())
    # A gauge is never a staleness cue candidate (its neglect is the band).
    gid = tracker.create_tracker(conn, label="Water", archetype="gauge",
                                 config={"gauge": {"grace_hours": 3, "low_hours": 6, "overdue_hours": 12, "extreme_hours": 48}})["id"]

    out = tracker.cue_candidates(conn, now=NOW)
    by_id = {s["id"]: s for s in out["stale"]}
    assert mid in by_id and by_id[mid]["ask_cap_per_day"] == 1
    assert eid in by_id and by_id[eid]["ask_cap_per_day"] == 0
    assert gid not in by_id, "gauges are excluded from staleness cues"
    assert "hours_since" in by_id[mid]


def test_expiring_items_projects_pantry_class_within_lead(conn):
    from datetime import date
    pid = tracker.create_tracker(conn, label="Pantry", archetype="inventory", schema=[
        {"name": "name", "type": "text", "required": True},
        {"name": "expires", "type": "date"},
    ], config={"project_dates": True})["id"]
    d = lambda days: (NOW.date() + timedelta(days=days)).isoformat()
    tracker.log_entry(conn, tracker_id=pid, payload={"name": "spinach", "expires": d(-1)})   # expired
    tracker.log_entry(conn, tracker_id=pid, payload={"name": "yoghurt", "expires": d(2)})    # within lead
    tracker.log_entry(conn, tracker_id=pid, payload={"name": "rice",    "expires": d(30)})   # far off
    tracker.log_entry(conn, tracker_id=pid, payload={"name": "salt"})                        # no expiry

    items = tracker.expiring_items(conn, within_days=3, now=NOW)["items"]
    names = [i["name"] for i in items]
    assert names == ["spinach", "yoghurt"], "soonest-first, only within-lead (incl. expired), skips no-date/far"
    assert items[0]["days_left"] == -1 and items[1]["days_left"] == 2
    assert items[0]["tracker_id"] == pid and "entry_id" in items[0]


def test_expiring_items_requires_project_dates(conn):
    pid = tracker.create_tracker(conn, label="Fridge", archetype="inventory", schema=[
        {"name": "name", "type": "text", "required": True}, {"name": "expires", "type": "date"},
    ], config={})["id"]  # no project_dates
    tracker.log_entry(conn, tracker_id=pid, payload={"name": "milk", "expires": (NOW.date() + timedelta(days=1)).isoformat()})
    assert tracker.expiring_items(conn, now=NOW)["items"] == [], "inventory without project_dates is never projected"


def test_watchdog_rate_flag(conn):
    tid = tracker.create_tracker(conn, label="Erp", archetype="series",
                                 schema=[{"name": "t", "type": "text"}], config={"entry_cap_per_day": 50})["id"]
    # a calm baseline in the 8-28d window, then a genuine burst this week
    for d in range(8, 20):
        tracker.log_entry(conn, tracker_id=tid, payload={"t": "x"}, ts=(NOW - timedelta(days=d)).isoformat())
    for i in range(30):
        tracker.log_entry(conn, tracker_id=tid, payload={"t": "x"}, ts=(NOW - timedelta(days=1, hours=i)).isoformat())
    flag = tracker.entry_rate_flag(conn, id=tid, now=NOW)
    assert flag["flagged"] is True and flag["week_count"] >= 10

def test_predict_windows_honesty_gate(conn):
    tid = tracker.create_tracker(conn, label="Menses", archetype="series", sensitive=True, schema=[
        {"name": "flow", "type": "enum", "required": True, "values": ["none", "spotting", "light", "medium", "heavy"]},
    ], config={"predict": True})["id"]
    # under 2 completed cycles → no window
    tracker.log_entry(conn, tracker_id=tid, payload={"flow": "medium"}, ts="2026-06-01T09:00:00")
    assert tracker.predict_windows(conn, id=tid, now=NOW)["window"] is None
    # three cycle starts ~28d apart → a window appears, ±3 days
    tracker.log_entry(conn, tracker_id=tid, payload={"flow": "medium"}, ts="2026-06-29T09:00:00")
    tracker.log_entry(conn, tracker_id=tid, payload={"flow": "medium"}, ts="2026-07-27T09:00:00")
    p = tracker.predict_windows(conn, id=tid, now=NOW)
    assert p["window"] is not None and p["cycles_seen"] == 2
    assert p["window"]["start"] < p["window"]["end"]


def test_predictions_scans_predict_enabled_and_honours_the_gate(conn):
    # A predict-enabled menses log with only ONE start → no prediction yet.
    mid = tracker.create_tracker(conn, label="Menses", archetype="series", sensitive=True, schema=[
        {"name": "flow", "type": "enum", "required": True, "values": ["none", "spotting", "light", "medium", "heavy"]},
    ], config={"predict": True})["id"]
    tracker.log_entry(conn, tracker_id=mid, payload={"flow": "medium"}, ts="2026-06-01T09:00:00")
    # A non-predict tracker is never scanned.
    tracker.create_tracker(conn, label="Mood", archetype="series",
                           schema=[{"name": "m", "type": "text"}], config={})
    assert tracker.predictions(conn, now=NOW)["predictions"] == [], "gate not cleared → nothing projected"

    # Add two more cycle starts → the window clears the gate and appears once.
    tracker.log_entry(conn, tracker_id=mid, payload={"flow": "medium"}, ts="2026-06-29T09:00:00")
    tracker.log_entry(conn, tracker_id=mid, payload={"flow": "medium"}, ts="2026-07-27T09:00:00")
    out = tracker.predictions(conn, now=NOW)["predictions"]
    assert len(out) == 1
    assert out[0]["tracker_id"] == mid and out[0]["window"]["start"] < out[0]["window"]["end"]
    assert out[0]["cycles_seen"] == 2


def test_reflection_series_aligns_by_day_and_owns_the_arithmetic(conn):
    # A sleep series (numeric mean per day) and a mood series (enum values per day).
    sid = tracker.create_tracker(conn, label="Sleep", archetype="series",
                                 schema=[{"name": "hours", "type": "scale", "min": 0, "max": 24}])["id"]
    # two entries same day → code averages (5 and 7 → 6.0)
    tracker.log_entry(conn, tracker_id=sid, payload={"hours": 5}, ts=(NOW - timedelta(days=1, hours=2)).isoformat())
    tracker.log_entry(conn, tracker_id=sid, payload={"hours": 7}, ts=(NOW - timedelta(days=1, hours=1)).isoformat())

    mid = tracker.create_tracker(conn, label="Mood", archetype="series",
                                 schema=[{"name": "mood", "type": "enum", "values": ["low", "ok", "good"]}])["id"]
    tracker.log_entry(conn, tracker_id=mid, payload={"mood": "low"}, ts=(NOW - timedelta(days=1, hours=3)).isoformat())
    tracker.log_entry(conn, tracker_id=mid, payload={"mood": "ok"},  ts=(NOW - timedelta(days=1, hours=1)).isoformat())

    ser = tracker.reflection_series(conn, days=10, now=NOW)["series"]
    by_label = {s["label"]: s for s in ser}
    assert set(by_label) == {"Sleep", "Mood"}

    sleep_day = by_label["Sleep"]["days"][0]
    assert sleep_day["n"] == 2 and sleep_day["fields"]["hours"] == 6.0, "numeric field → day mean, code-owned"

    mood_day = by_label["Mood"]["days"][0]
    assert mood_day["fields"]["mood"] == ["low", "ok"], "enum field → the day's values, in order"

    # Every tracker carries its watchdog flag folded in.
    assert "watchdog" in by_label["Sleep"] and by_label["Sleep"]["watchdog"]["flagged"] is False


def test_reflection_series_computes_anticipated_actual_gap_and_skips_empties(conn):
    # An outings-style tracker with an anticipated/actual numeric pair.
    oid = tracker.create_tracker(conn, label="Outings", archetype="series", schema=[
        {"name": "anticipated", "type": "scale", "min": 0, "max": 10},
        {"name": "actual",      "type": "scale", "min": 0, "max": 10},
    ])["id"]
    # anticipated 8, actual 3 → gap -5 (dreaded worse than it went)
    tracker.log_entry(conn, tracker_id=oid, payload={"anticipated": 8, "actual": 3},
                      ts=(NOW - timedelta(days=1)).isoformat())
    # A tracker with NO entries in the window is skipped entirely.
    tracker.create_tracker(conn, label="Empty", archetype="series",
                           schema=[{"name": "x", "type": "text"}])

    ser = tracker.reflection_series(conn, days=10, now=NOW)["series"]
    labels = {s["label"] for s in ser}
    assert labels == {"Outings"}, "empty-window trackers are skipped"
    day = ser[0]["days"][0]
    assert day["gap"] == -5.0, "code computes actual − anticipated per entry, mean per day"


def test_ensure_from_template_is_idempotent(conn):
    # First tag stands the Mood ledger up...
    a = tracker.ensure_from_template(conn, template_id="mood")
    assert a["ok"] and a["created"] is True
    # ...every tag after reuses it — no duplicates.
    b = tracker.ensure_from_template(conn, template_id="mood")
    assert b["ok"] and b["created"] is False and b["id"] == a["id"]
    moods = [t for t in tracker.list_trackers(conn) if t["label"] == "Mood"]
    assert len(moods) == 1, "exactly one Mood tracker after repeated ensures"
    # An unknown template still errors (via create_from_template).
    with pytest.raises(ValueError):
        tracker.ensure_from_template(conn, template_id="nope")


def test_reflection_series_skips_archived(conn):
    tid = tracker.create_tracker(conn, label="Mood", archetype="series",
                                 schema=[{"name": "m", "type": "text"}])["id"]
    tracker.log_entry(conn, tracker_id=tid, payload={"m": "x"}, ts=(NOW - timedelta(days=1)).isoformat())
    assert len(tracker.reflection_series(conn, now=NOW)["series"]) == 1
    tracker.archive_tracker(conn, id=tid, archived=True)
    assert tracker.reflection_series(conn, now=NOW)["series"] == [], "archived trackers leave the reflection input"


def test_archive_hides_from_active_surfaces_and_list_but_keeps_data(conn):
    tid = tracker.create_tracker(conn, label="Mood", archetype="series",
                                 schema=[{"name": "m", "type": "text"}], config={"staleness_hours": 24})["id"]
    tracker.log_entry(conn, tracker_id=tid, payload={"m": "x"}, ts=(NOW - timedelta(hours=40)).isoformat())
    # Active before archiving: in the list, and a stale cue candidate.
    assert any(t["id"] == tid for t in tracker.list_trackers(conn))
    assert any(s["id"] == tid for s in tracker.stale_trackers(conn, now=NOW))

    assert tracker.archive_tracker(conn, id=tid, archived=True) == {"ok": True, "archived": True}
    # Gone from the default (active) list + cues; still there with include_archived.
    assert not any(t["id"] == tid for t in tracker.list_trackers(conn))
    assert not any(s["id"] == tid for s in tracker.stale_trackers(conn, now=NOW))
    shown = [t for t in tracker.list_trackers(conn, include_archived=True) if t["id"] == tid]
    assert len(shown) == 1 and shown[0]["archived"] is True
    # The entry data survives (read still works).
    assert tracker.read_tracker(conn, id=tid)["count"] == 1

    # Un-archive restores it.
    assert tracker.archive_tracker(conn, id=tid, archived=False)["archived"] is False
    assert any(t["id"] == tid for t in tracker.list_trackers(conn))


def test_archive_unknown_tracker_errors(conn):
    r = tracker.archive_tracker(conn, id="ghost-z9", archived=True)
    assert r["ok"] is False


def test_archived_excluded_from_expiring_and_predictions(conn):
    pid = tracker.create_tracker(conn, label="Pantry", archetype="inventory", schema=[
        {"name": "name", "type": "text", "required": True}, {"name": "expires", "type": "date"},
    ], config={"project_dates": True})["id"]
    tracker.log_entry(conn, tracker_id=pid, payload={"name": "milk", "expires": (NOW.date() + timedelta(days=1)).isoformat()})
    assert tracker.expiring_items(conn, now=NOW)["items"], "precondition: an expiring item"
    tracker.archive_tracker(conn, id=pid, archived=True)
    assert tracker.expiring_items(conn, now=NOW)["items"] == [], "archived pantry is not projected"


def test_drop_deletes_tracker_and_entries(conn):
    tid = tracker.create_tracker(conn, label="Temp", archetype="series",
                                 schema=[{"name": "m", "type": "text"}], config={})["id"]
    tracker.log_entry(conn, tracker_id=tid, payload={"m": "x"})
    assert tracker.drop_tracker(conn, id=tid)["dropped"] == 1
    assert not any(t["id"] == tid for t in tracker.list_trackers(conn, include_archived=True))
    # entries cascaded
    assert conn.execute("SELECT COUNT(*) c FROM tracker_entries WHERE tracker_id=?", (tid,)).fetchone()["c"] == 0
