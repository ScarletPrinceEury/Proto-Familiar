"""Unit tests for Google-Calendar ingestion (build spec §1).

Run with: cd unruh && uv run pytest tests/test_gcal.py

Covers the iCal parser (ical.py) and the change-classifying upsert
(gcal.py) against fixture `.ics` strings — no network, per §1.5.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime

import pytest

from unruh import gcal, ical, schedule as sched
from unruh.db import run_migrations, to_local_naive


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    run_migrations(c)
    yield c
    c.close()


def _vevent(uid, start, summary="Thing", extra=""):
    return (
        "BEGIN:VEVENT\n"
        f"UID:{uid}\n"
        f"DTSTART:{start}\n"
        f"SUMMARY:{summary}\n"
        f"{extra}"
        "END:VEVENT\n"
    )


def _cal(*vevents):
    return "BEGIN:VCALENDAR\nVERSION:2.0\n" + "".join(vevents) + "END:VCALENDAR\n"


# ── Parser ─────────────────────────────────────────────────────────────


def test_parse_basic_utc_event():
    text = _cal(_vevent("a@google.com", "20260702T140000Z", "Dentist",
                         "DTEND:20260702T144500Z\nLOCATION:12 High St\n"))
    out = ical.parse_ical(text)
    assert len(out["events"]) == 1
    ev = out["events"][0]
    assert ev["uid"] == "a@google.com"
    assert ev["summary"] == "Dentist"
    assert ev["start"].startswith("2026-07-02T14:00:00")
    assert ev["end"].startswith("2026-07-02T14:45:00")
    assert ev["location"] == "12 High St"
    assert ev["all_day"] is False
    assert ev["status"] == "confirmed"


def test_parse_all_day_event():
    text = _cal("BEGIN:VEVENT\nUID:b\nDTSTART;VALUE=DATE:20260702\nSUMMARY:Holiday\nEND:VEVENT\n")
    ev = ical.parse_ical(text)["events"][0]
    assert ev["all_day"] is True
    assert ev["start"].startswith("2026-07-02T00:00:00")


def test_parse_line_unfolding_and_escapes():
    text = _cal("BEGIN:VEVENT\nUID:c\nDTSTART:20260702T090000Z\n"
                "SUMMARY:bring referral\\, please\nDESCRIPTION:line one\\nline two\n"
                "  and a folded tail\nEND:VEVENT\n")
    ev = ical.parse_ical(text)["events"][0]
    assert ev["summary"] == "bring referral, please"
    assert "line one\nline two and a folded tail" == ev["description"]


def test_cancelled_status_parsed():
    text = _cal(_vevent("d", "20260702T140000Z", extra="STATUS:CANCELLED\n"))
    ev = ical.parse_ical(text)["events"][0]
    assert ev["status"] == "cancelled"


def test_event_without_uid_skipped():
    text = _cal("BEGIN:VEVENT\nDTSTART:20260702T140000Z\nSUMMARY:no uid\nEND:VEVENT\n")
    assert ical.parse_ical(text)["events"] == []


# ── Recurrence: subset mapping ─────────────────────────────────────────


def test_simple_weekly_maps_to_recurrence():
    # 2026-07-02 is a Thursday.
    text = _cal(_vevent("w", "20260702T090000Z", extra="RRULE:FREQ=WEEKLY\n"))
    ev = ical.parse_ical(text)["events"][0]
    assert ev["recurrence"] == {"freq": "weekly"}


def test_biweekly_interval_maps():
    text = _cal(_vevent("w2", "20260702T090000Z", extra="RRULE:FREQ=WEEKLY;INTERVAL=2\n"))
    ev = ical.parse_ical(text)["events"][0]
    assert ev["recurrence"] == {"freq": "weekly", "interval": 2}


def test_monthly_last_friday_maps_with_js_weekday():
    # last Friday of every month; recurrence.js consumes JS getDay (FR=5).
    text = _cal(_vevent("m", "20260626T090000Z",
                        extra="RRULE:FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1\n"))
    ev = ical.parse_ical(text)["events"][0]
    assert ev["recurrence"] == {"freq": "monthly", "bysetpos": -1, "byweekday": 5}


def test_until_maps():
    text = _cal(_vevent("u", "20260702T090000Z",
                        extra="RRULE:FREQ=DAILY;UNTIL=20260710T000000Z\n"))
    ev = ical.parse_ical(text)["events"][0]
    assert ev["recurrence"]["freq"] == "daily"
    assert ev["recurrence"]["until"] == "2026-07-10"


# ── Recurrence: §1.4 fallback expansion ────────────────────────────────


def test_multiday_weekly_expands_to_occurrences():
    # MWF every week — NOT in the subset, so it materialises as occurrences.
    now = datetime(2026, 6, 29)  # a Monday
    text = _cal(_vevent("mwf", "20260629T090000Z",
                        extra="RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\n"))
    out = ical.parse_ical(text, now=now)
    assert "mwf" in out["complex_series"]
    occs = out["events"]
    assert len(occs) > 3
    # Synthetic uids carry the occurrence date, so re-sync reconciles them.
    assert all(e["uid"].startswith("mwf#") for e in occs)
    assert all(e["recurrence"] is None and e["expanded_from"] == "mwf" for e in occs)
    # Only Mon/Wed/Fri.
    for e in occs:
        wd = datetime.fromisoformat(e["start"].replace("Z", "+00:00")).weekday()
        assert wd in (0, 2, 4)


def test_fallback_horizon_bounded():
    now = datetime(2026, 1, 1)
    text = _cal(_vevent("daily-mwf", "20260101T090000Z",
                        extra="RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU\n"))
    out = ical.parse_ical(text, now=now)
    # 90-day horizon, daily → ~91 occurrences, never unbounded.
    assert 80 <= len(out["events"]) <= 95


# ── Ingest: change classification ──────────────────────────────────────


def _ingest(conn, text, **kw):
    return gcal.gcal_ingest(conn, ics_text=text, **kw)


def test_new_updated_unchanged_removed(conn):
    future = "20990702T140000Z"
    text = _cal(_vevent("x@g", future, "Dentist"))
    r1 = _ingest(conn, text)
    assert len(r1["new"]) == 1 and not r1["updated"] and not r1["removed"]
    node_id = r1["new"][0]

    # Re-sync unchanged → nothing new.
    r2 = _ingest(conn, text)
    assert not r2["new"] and r2["unchanged"] == [node_id]

    # Advance LAST-MODIFIED + change the title → updated, id preserved.
    text2 = _cal(_vevent("x@g", future, "Dentist (moved)",
                         extra="LAST-MODIFIED:20260620T090000Z\n"))
    r3 = _ingest(conn, text2)
    assert r3["updated"] == [node_id] and not r3["new"]
    row = conn.execute("SELECT label FROM nodes WHERE id=?", (node_id,)).fetchone()
    assert row["label"] == "Dentist (moved)"

    # Vanish from a confirmed full snapshot → cancelled (future event).
    other = _cal(_vevent("y@g", future, "Lunch"))
    r4 = _ingest(conn, other)
    assert node_id in r4["removed"]
    row = conn.execute("SELECT resolution FROM nodes WHERE id=?", (node_id,)).fetchone()
    assert row["resolution"] == "cancelled"


def test_needs_projection_only_on_insert(conn):
    future = "20990702T140000Z"
    r1 = _ingest(conn, _cal(_vevent("np@g", future, "A")))
    nid = r1["new"][0]
    p = json.loads(conn.execute("SELECT payload_json FROM nodes WHERE id=?", (nid,)).fetchone()["payload_json"])
    assert p["needs_projection"] is True
    assert p["source"] == "gcal" and p["gcal_uid"] == "np@g"

    # Familiar "thinks it through" → clears the flag; an update must not re-set it.
    p2 = dict(p); p2.pop("needs_projection")
    sched.update_node(conn, id=nid, payload=p2)
    _ingest(conn, _cal(_vevent("np@g", future, "A2", extra="LAST-MODIFIED:20260620T090000Z\n")))
    p3 = json.loads(conn.execute("SELECT payload_json FROM nodes WHERE id=?", (nid,)).fetchone()["payload_json"])
    assert "needs_projection" not in p3  # preserved-as-cleared, never resurrected


def test_empty_snapshot_never_cancels(conn):
    future = "20990702T140000Z"
    r1 = _ingest(conn, _cal(_vevent("keep@g", future, "Keep")))
    nid = r1["new"][0]
    # An empty (but "successful") fetch must be a no-op for deletions.
    r2 = _ingest(conn, _cal())  # zero VEVENTs
    assert not r2["removed"]
    row = conn.execute("SELECT resolution FROM nodes WHERE id=?", (nid,)).fetchone()
    assert row["resolution"] is None


def test_windowed_read_does_not_reconcile_deletes(conn):
    future = "20990702T140000Z"
    r1 = _ingest(conn, _cal(_vevent("a@g", future), _vevent("b@g", future)))
    assert len(r1["new"]) == 2
    # A partial/windowed read missing b@g, with reconcile_deletes=False.
    r2 = _ingest(conn, _cal(_vevent("a@g", future)), reconcile_deletes=False)
    assert not r2["removed"]


def test_past_event_absent_is_not_a_deletion(conn):
    past = "20200101T090000Z"
    r1 = _ingest(conn, _cal(_vevent("old@g", past, "Old")))
    nid = r1["new"][0]
    # Future-only snapshot; the past event aged out of view, not deleted.
    r2 = _ingest(conn, _cal(_vevent("new@g", "20990101T090000Z")))
    assert nid not in r2["removed"]
    row = conn.execute("SELECT resolution FROM nodes WHERE id=?", (nid,)).fetchone()
    assert row["resolution"] is None


# Projection candidates use a 14-day horizon from `now`; pin both for
# determinism. Floating local-naive DTSTART (no Z) stores as-is.
NOW = "2026-06-26T12:00:00"
SOON = "20260628T140000"   # +2 days, in horizon
FAR = "20260801T090000"    # +36 days, beyond horizon


def test_projection_candidates_flagged_in_horizon(conn):
    r = _ingest(conn, _cal(_vevent("p@g", SOON, "Dentist")))
    nid = r["new"][0]
    cands = gcal.projection_candidates(conn, now=NOW)
    assert [c["id"] for c in cands] == [nid]
    assert cands[0]["label"] == "Dentist"


def test_projection_candidate_drops_after_consequence_edge(conn):
    # Auto-clear (§4.3): once the Familiar links a consequence, it's gone.
    r = _ingest(conn, _cal(_vevent("p2@g", SOON, "Interview")))
    nid = r["new"][0]
    state_id = sched.add_node(conn, type="state", label="calm", when="2026-06-20T09:00:00")
    sched.add_edge(conn, src=nid, dst=state_id, kind="causes",
                   payload={"valence": "help", "condition": "on_resolve"})
    assert gcal.projection_candidates(conn, now=NOW) == []


def test_projection_candidate_excludes_out_of_horizon_and_resolved(conn):
    r = _ingest(conn, _cal(_vevent("near@g", SOON), _vevent("far@g", FAR)))
    cands = gcal.projection_candidates(conn, now=NOW)
    # Only the near one (the far one is past the 14-day horizon).
    assert len(cands) == 1
    # Resolving the near one removes it too.
    sched.resolve(conn, id=cands[0]["id"], resolution="done")
    assert gcal.projection_candidates(conn, now=NOW) == []


def test_ingest_threads_now_into_fallback_horizon(conn):
    # A complex (multi-BYDAY) series expands over a 90-day horizon. The horizon
    # must anchor to the `now` passed to gcal_ingest — not the wall clock — so
    # ingest stays consistent with a standalone parse at the same now (and is
    # deterministic in tests). DTSTART is floating-local so no tz shift muddies
    # the count.
    text = _cal(_vevent("mwf2@g", "20260629T090000", extra="RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\n"))
    expected = len(ical.parse_ical(text, now=datetime.fromisoformat(NOW))["events"])
    r = gcal.gcal_ingest(conn, ics_text=text, now=NOW)
    inserted = conn.execute(
        "SELECT COUNT(*) n FROM nodes WHERE json_extract(payload_json,'$.source')='gcal'"
    ).fetchone()["n"]
    assert inserted == expected == len(r["new"])
    assert expected > 3  # the series really did expand (not a degenerate 1)


def test_ingest_events_list_path(conn):
    # The authenticated-adapter path: pre-normalised events, not .ics text.
    ev = {
        "uid": "evlist@g", "summary": "Meeting", "start": "20990702T140000Z".replace("Z", "+00:00"),
        "end": None, "all_day": False, "recurrence": None, "location": None,
        "description": None, "status": "confirmed", "last_modified": None,
    }
    r = gcal.gcal_ingest(conn, events=[ev])
    assert len(r["new"]) == 1


# ── RECURRENCE-ID overrides (modified instances) ───────────────────────


def _override_vevent(uid, rid, start, summary="Thing", extra=""):
    return (
        "BEGIN:VEVENT\n"
        f"UID:{uid}\n"
        f"RECURRENCE-ID:{rid}\n"
        f"DTSTART:{start}\n"
        f"SUMMARY:{summary}\n"
        f"{extra}"
        "END:VEVENT\n"
    )


def test_override_splits_into_synthetic_uid():
    # A weekly series + one moved instance. The series must expand (a mapped
    # anchor can't express the move), the overridden original date must not
    # render, and the override gets the stable "<uid>#<orig-date>" key.
    text = _cal(
        _vevent("s@g", "20260706T100000", "Standup", extra="RRULE:FREQ=WEEKLY\n"),
        _override_vevent("s@g", "20260713T100000", "20260713T150000", "Standup (moved)"),
    )
    out = ical.parse_ical(text, now=datetime(2026, 7, 4))
    uids = [e["uid"] for e in out["events"]]
    assert len(uids) == len(set(uids)), "every event in one snapshot has a distinct uid"
    assert "s@g" not in uids, "series with overrides is expanded, not kept as anchor"
    override = next(e for e in out["events"] if e["uid"] == "s@g#2026-07-13")
    assert override["start"].startswith("2026-07-13T15:00:00")
    assert override["summary"] == "Standup (moved)"
    assert override["expanded_from"] == "s@g"
    # The original 10:00 occurrence on the 13th is excluded from expansion.
    starts = [e["start"] for e in out["events"] if e["uid"] != "s@g#2026-07-13"]
    assert not any(s.startswith("2026-07-13") for s in starts)
    # Override-forced expansion is expected behaviour, not a complex series.
    assert out["complex_series"] == []


def test_override_cancelled_instance():
    text = _cal(
        _vevent("c@g", "20260706T100000", "Weekly", extra="RRULE:FREQ=WEEKLY\n"),
        _override_vevent("c@g", "20260720T100000", "20260720T100000", "Weekly",
                         extra="STATUS:CANCELLED\n"),
    )
    out = ical.parse_ical(text, now=datetime(2026, 7, 4))
    cancelled = next(e for e in out["events"] if e["uid"] == "c@g#2026-07-20")
    assert cancelled["status"] == "cancelled"
    kept = [e for e in out["events"] if e["uid"] != "c@g#2026-07-20"]
    assert not any((e["start"] or "").startswith("2026-07-20") for e in kept)


def test_override_utc_frame_matches_utc_anchor():
    # Z-form RECURRENCE-ID against a Z-form DTSTART: exclusion + key must
    # line up in the shared frame.
    text = _cal(
        _vevent("z@g", "20260706T100000Z", "Sync", extra="RRULE:FREQ=WEEKLY\n"),
        _override_vevent("z@g", "20260713T100000Z", "20260713T120000Z"),
    )
    out = ical.parse_ical(text, now=datetime(2026, 7, 4))
    uids = [e["uid"] for e in out["events"]]
    assert "z@g#2026-07-13" in uids
    starts = [e["start"] for e in out["events"] if e["uid"] != "z@g#2026-07-13"]
    assert not any(s.startswith("2026-07-13T10") for s in starts)


def test_override_without_anchor_stands_alone():
    # Windowed feeds can carry an override whose series anchor is outside
    # the window — it must still land as its own reconcilable event.
    text = _cal(_override_vevent("lone@g", "20260710T090000", "20260710T110000", "Moved thing"))
    out = ical.parse_ical(text, now=datetime(2026, 7, 4))
    assert len(out["events"]) == 1
    ev = out["events"][0]
    assert ev["uid"] == "lone@g#2026-07-10"
    assert ev["expanded_from"] == "lone@g"


def test_override_ingest_round_trip(conn):
    # End-to-end: sync a series, then re-sync after one instance moved.
    # No duplicate nodes, no clobbered series, old time gone, new time in.
    plain = _cal(_vevent("rt@g", "20990706T100000", "Standup", extra="RRULE:FREQ=WEEKLY\n"))
    r1 = _ingest(conn, plain, now="2099-07-04T12:00:00")
    assert len(r1["new"]) == 1  # mapped-subset anchor

    moved = _cal(
        _vevent("rt@g", "20990706T100000", "Standup", extra="RRULE:FREQ=WEEKLY\n"),
        _override_vevent("rt@g", "20990713T100000", "20990713T150000", "Standup (moved)"),
    )
    r2 = _ingest(conn, moved, now="2099-07-04T12:00:00")
    # The plain anchor uid vanished from the snapshot → cancelled; the
    # expanded occurrences + override are new.
    assert r1["new"][0] in r2["removed"]
    rows = conn.execute(
        """SELECT label, when_ts FROM nodes
            WHERE json_extract(payload_json,'$.source')='gcal' AND resolution IS NULL"""
    ).fetchall()
    whens = [r["when_ts"] for r in rows]
    assert "2099-07-13T15:00:00" in whens
    assert "2099-07-13T10:00:00" not in whens
    # A third identical sync changes nothing.
    r3 = _ingest(conn, moved, now="2099-07-04T12:00:00")
    assert not r3["new"] and not r3["removed"] and not r3["updated"]


# ── Reconcile guards: duplicate uids ───────────────────────────────────


def test_same_uid_twice_in_one_snapshot_first_wins(conn):
    ev = lambda summary: {
        "uid": "dupe@g", "summary": summary, "start": "2099-07-02T14:00:00",
        "end": None, "all_day": False, "recurrence": None, "location": None,
        "description": None, "status": "confirmed", "last_modified": None,
    }
    r = gcal.gcal_ingest(conn, events=[ev("First"), ev("Second")])
    assert len(r["new"]) == 1
    rows = conn.execute(
        "SELECT label FROM nodes WHERE json_extract(payload_json,'$.gcal_uid')='dupe@g'"
    ).fetchall()
    assert [row["label"] for row in rows] == ["First"]


def test_ingest_heals_historical_duplicate_nodes(conn):
    # Two live nodes sharing one gcal_uid (the pre-fix corruption): the next
    # sync keeps one and cancels the rest.
    for label in ("Old copy", "New copy"):
        sched.add_node(conn, type="event", label=label, when="2099-07-02T14:00:00",
                       payload={"source": "gcal", "gcal_uid": "healme@g"})
    ev = {
        "uid": "healme@g", "summary": "New copy", "start": "2099-07-02T14:00:00",
        "end": None, "all_day": False, "recurrence": None, "location": None,
        "description": None, "status": "confirmed", "last_modified": None,
    }
    r = gcal.gcal_ingest(conn, events=[ev], reconcile_deletes=False)
    assert len(r["removed"]) == 1
    live = conn.execute(
        """SELECT COUNT(*) n FROM nodes
            WHERE json_extract(payload_json,'$.gcal_uid')='healme@g'
              AND resolution IS NULL"""
    ).fetchone()["n"]
    assert live == 1


# ── Multi-calendar scoping + attribution (build spec §1.5.1) ─────────────

def test_dedupe_with_calendar_id_scope(conn):
    # Two calendars' events must never interfere with each other. Insert
    # two events from different calendars; the dedupe for calendar A should
    # only see calendar A's nodes.
    ev_a = {
        "uid": "a@g", "summary": "Event A", "start": "2099-07-02T14:00:00",
        "end": None, "all_day": False, "recurrence": None, "location": None,
        "description": None, "status": "confirmed", "last_modified": None,
    }
    ev_b = {
        "uid": "b@g", "summary": "Event B", "start": "2099-07-02T14:00:00",
        "end": None, "all_day": False, "recurrence": None, "location": None,
        "description": None, "status": "confirmed", "last_modified": None,
    }
    r1 = gcal.gcal_ingest(conn, events=[ev_a], calendar_id="calA")
    r2 = gcal.gcal_ingest(conn, events=[ev_b], calendar_id="calB")
    assert len(r1["new"]) == 1 and len(r2["new"]) == 1
    id_a, id_b = r1["new"][0], r2["new"][0]

    # Verify both nodes have the right calendar_id in payload
    node_a = conn.execute("SELECT payload_json FROM nodes WHERE id=?", (id_a,)).fetchone()
    payload_a = json.loads(node_a["payload_json"])
    assert payload_a["gcal_calendar_id"] == "calA"

    node_b = conn.execute("SELECT payload_json FROM nodes WHERE id=?", (id_b,)).fetchone()
    payload_b = json.loads(node_b["payload_json"])
    assert payload_b["gcal_calendar_id"] == "calB"


def test_reconcile_deletes_scoped_to_calendar(conn):
    # When syncing calendar A with a confirmed empty snapshot, calendar B's
    # events must NOT be cancelled. Insert events from both calendars.
    future = "2099-07-02T14:00:00"
    ev_a = {
        "uid": "scopea@g", "summary": "From A", "start": future,
        "end": None, "all_day": False, "recurrence": None, "location": None,
        "description": None, "status": "confirmed", "last_modified": None,
    }
    ev_b = {
        "uid": "scopeb@g", "summary": "From B", "start": future,
        "end": None, "all_day": False, "recurrence": None, "location": None,
        "description": None, "status": "confirmed", "last_modified": None,
    }
    r1 = gcal.gcal_ingest(conn, events=[ev_a], calendar_id="calA")
    r2 = gcal.gcal_ingest(conn, events=[ev_b], calendar_id="calB")
    id_a, id_b = r1["new"][0], r2["new"][0]

    # Now re-sync calendar A with a different event (empty snapshot for ev_a)
    # and reconcile_deletes=True. ev_a should be cancelled, but ev_b untouched.
    ev_a_new = {
        "uid": "new_a@g", "summary": "Another from A", "start": future,
        "end": None, "all_day": False, "recurrence": None, "location": None,
        "description": None, "status": "confirmed", "last_modified": None,
    }
    r3 = gcal.gcal_ingest(conn, events=[ev_a_new], calendar_id="calA", reconcile_deletes=True)
    assert id_a in r3["removed"], "Event A should be cancelled"
    assert id_b not in r3["removed"], "Event B should NOT be cancelled"

    node_b_after = conn.execute("SELECT resolution FROM nodes WHERE id=?", (id_b,)).fetchone()
    assert node_b_after["resolution"] is None, "Event B should remain unresolved"


def test_include_legacy_adopts_nodes_into_calendar(conn):
    # A pre-multi-calendar node (no gcal_calendar_id) should be adopted by the
    # ward's calendar when include_legacy=True. Create a legacy node, then
    # sync the ward's calendar.
    legacy_payload = {
        "source": "gcal",
        "gcal_uid": "legacy@g",
        "gcal_last_modified": None,
        "all_day": False,
    }
    legacy_id = sched.add_node(
        conn, type="event", label="Legacy event", when="2099-07-02T14:00:00",
        payload=legacy_payload
    )
    # Verify it has no gcal_calendar_id
    node = conn.execute("SELECT payload_json FROM nodes WHERE id=?", (legacy_id,)).fetchone()
    p = json.loads(node["payload_json"])
    assert "gcal_calendar_id" not in p

    # Now sync the ward's calendar with a different event, and include_legacy=True
    # The legacy node should be considered part of this calendar's scope, so if
    # it's missing from the snapshot, it gets cancelled.
    ev_ward = {
        "uid": "ward@g", "summary": "Ward event", "start": "2099-07-02T14:00:00",
        "end": None, "all_day": False, "recurrence": None, "location": None,
        "description": None, "status": "confirmed", "last_modified": None,
    }
    r = gcal.gcal_ingest(conn, events=[ev_ward], calendar_id="calWard", include_legacy=True, reconcile_deletes=True)
    assert legacy_id in r["removed"], "Legacy node should be reconciled (cancelled) when in scope"

    # Now test with include_legacy=False: the legacy node should NOT be reconciled
    legacy_id2 = sched.add_node(
        conn, type="event", label="Another legacy", when="2099-07-02T15:00:00",
        payload={"source": "gcal", "gcal_uid": "legacy2@g"}
    )
    r2 = gcal.gcal_ingest(conn, events=[ev_ward], calendar_id="calWard", include_legacy=False, reconcile_deletes=True)
    assert legacy_id2 not in r2["removed"], "Legacy node should NOT be reconciled when include_legacy=False"


def test_attribution_stamped_on_ingest(conn):
    # attribution parameter stamps the kind/ref/label onto each event's payload
    future = "2099-07-02T14:00:00"
    ev = {
        "uid": "attr@g", "summary": "Calendar item", "start": future,
        "end": None, "all_day": False, "recurrence": None, "location": None,
        "description": None, "status": "confirmed", "last_modified": None,
    }
    attribution = {"kind": "villager", "ref": "v123", "label": "Mom"}
    r = gcal.gcal_ingest(
        conn, events=[ev], calendar_id="calMom",
        attribution=attribution
    )
    assert len(r["new"]) == 1
    node_id = r["new"][0]

    node = conn.execute("SELECT payload_json FROM nodes WHERE id=?", (node_id,)).fetchone()
    payload = json.loads(node["payload_json"])
    assert payload["gcal_attribution"] == attribution, "Attribution should be stamped"
    assert payload["gcal_calendar_id"] == "calMom"


def test_attribution_preserved_on_update(conn):
    # When an event is updated (LAST-MODIFIED changed), the attribution should
    # persist (it's in the sync-owned keys). Create, then update.
    future = "2099-07-02T14:00:00"
    ev = {
        "uid": "attr2@g", "summary": "Item", "start": future,
        "end": None, "all_day": False, "recurrence": None, "location": None,
        "description": None, "status": "confirmed", "last_modified": "2099-07-01T10:00:00Z",
    }
    attr1 = {"kind": "ward", "label": "My calendar"}
    r1 = gcal.gcal_ingest(conn, events=[ev], calendar_id="calA", attribution=attr1)
    node_id = r1["new"][0]

    # Now update with a newer LAST-MODIFIED and different attribution
    ev_updated = dict(ev)
    ev_updated["last_modified"] = "2099-07-02T10:00:00Z"
    ev_updated["summary"] = "Item (rescheduled)"
    attr2 = {"kind": "villager", "ref": "v1", "label": "Friend"}
    r2 = gcal.gcal_ingest(conn, events=[ev_updated], calendar_id="calA", attribution=attr2)
    assert node_id in r2["updated"]

    node = conn.execute("SELECT payload_json FROM nodes WHERE id=?", (node_id,)).fetchone()
    payload = json.loads(node["payload_json"])
    # The new attribution should be applied
    assert payload["gcal_attribution"] == attr2


# ── Data-loss guards (critical reconciliation safety) ─────────────────────

def test_phase_never_cancelled_by_gcal_reconcile(conn):
    # A hand-authored phase with source='gcal' (mislabeled) should NEVER be
    # cancelled by reconciliation. Create a phase with gcal source, then
    # reconcile with different events.
    phase_id = sched.add_node(
        conn, type="phase", label="Morning", when="2099-07-02T07:00:00",
        end="2099-07-02T08:00:00",
        payload={"source": "gcal", "gcal_uid": "mislabeled_phase@g"}
    )
    # Sync with a different event, reconcile_deletes=True
    ev = {
        "uid": "real@g", "summary": "Real event", "start": "2099-07-02T14:00:00",
        "end": None, "all_day": False, "recurrence": None, "location": None,
        "description": None, "status": "confirmed", "last_modified": None,
    }
    r = gcal.gcal_ingest(conn, events=[ev], reconcile_deletes=True)
    # The phase should NOT be in removed (the _is_gcal_event guard)
    assert phase_id not in r["removed"], "Phase should never be cancelled"
    node = conn.execute("SELECT resolution FROM nodes WHERE id=?", (phase_id,)).fetchone()
    assert node["resolution"] is None


def test_need_never_cancelled_by_gcal_reconcile(conn):
    # A tracked need window with source='gcal' should NEVER be cancelled.
    # Create a need and reconcile.
    need_id = sched.add_node(
        conn, type="event", label="Medication", when="2099-07-02T09:00:00",
        end="2099-07-02T09:15:00",
        payload={"source": "gcal", "gcal_uid": "mislabeled_need@g", "need": True}
    )
    ev = {
        "uid": "real2@g", "summary": "Real", "start": "2099-07-02T14:00:00",
        "end": None, "all_day": False, "recurrence": None, "location": None,
        "description": None, "status": "confirmed", "last_modified": None,
    }
    r = gcal.gcal_ingest(conn, events=[ev], reconcile_deletes=True)
    assert need_id not in r["removed"], "Need should never be cancelled"


def test_recurring_node_never_cancelled_by_gcal_reconcile(conn):
    # A recurring routine (with recurrence dict) marked as gcal should not be
    # cancelled. Create a recurring event with recurrence set.
    recur_id = sched.add_node(
        conn, type="event", label="Weekly standup", when="2099-07-02T10:00:00",
        payload={
            "source": "gcal", "gcal_uid": "recurring_mislabeled@g",
            "recurrence": {"freq": "weekly"}
        }
    )
    ev = {
        "uid": "other@g", "summary": "Meeting", "start": "2099-07-02T14:00:00",
        "end": None, "all_day": False, "recurrence": None, "location": None,
        "description": None, "status": "confirmed", "last_modified": None,
    }
    r = gcal.gcal_ingest(conn, events=[ev], reconcile_deletes=True)
    assert recur_id not in r["removed"], "Recurring node should never be cancelled"
