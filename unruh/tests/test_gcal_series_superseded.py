"""Doubled events: a series node superseded by its own occurrences (0.14.80).

An iCal-link sync stores a recurring event as ONE series node (`<id>@google.com`
with a repeat rule). Google's own API delivers the same series as one event per
occurrence (`<id>_<date>`). After switching sources both lived on: the series
node kept generating every occurrence beside the per-occurrence nodes, so each
showed twice. Its anchor date is in the past, so deletion reconcile never
touched it. These pin the fix: the series node stops repeating one second
before its first separate occurrence, its history stays, and a source that
still sends the series as a series is never capped.
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from unruh import gcal, schedule as sched
from unruh.db import run_migrations

NOW = "2026-07-05T12:00:00"
SERIES = "abc123series@google.com"


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    run_migrations(c)
    yield c
    c.close()


def _series_node(conn, uid=SERIES, resolutions=None, calendar_id=None):
    """A series node as the iCal-link sync left it: weekly, anchor in the past."""
    payload = {"source": "gcal", "gcal_uid": uid, "all_day": True,
               "recurrence": {"freq": "weekly"}, "resolutions": resolutions or {"2026-06-24": "done"}}
    if calendar_id:
        payload["gcal_calendar_id"] = calendar_id
    return sched.add_node(conn, type="event", label="Wash day", when="2024-07-24T00:00:00",
                          end="2024-07-25T00:00:00", payload=payload)


def _occurrence(day, *, series_uid=SERIES, timed=False):
    """One occurrence as Google's API (singleEvents) delivers it."""
    base = SERIES.split("@")[0]
    ev = {"uid": f"{base}_{day.replace('-', '')}" + ("T080000Z" if timed else ""),
          "summary": "Wash day", "start": f"{day}T{'08' if timed else '00'}:00:00",
          "end": f"{day}T{'09' if timed else '23'}:00:00", "all_day": not timed,
          "recurrence": None, "status": "confirmed", "last_modified": None}
    if series_uid:
        ev["series_uid"] = series_uid
    return ev


def _payload(conn, nid):
    return json.loads(conn.execute("SELECT payload_json FROM nodes WHERE id=?", (nid,)).fetchone()["payload_json"])


def test_the_old_series_stops_repeating_before_its_first_separate_occurrence(conn):
    sid = _series_node(conn)
    res = gcal.gcal_ingest(conn, events=[_occurrence("2026-07-08"), _occurrence("2026-07-15")], now=NOW)
    assert res["series_capped"] == [sid]
    p = _payload(conn, sid)
    assert p["recurrence"] == {"freq": "weekly", "until": "2026-07-07T23:59:59"}, "local-naive, never a bare date"
    assert p["resolutions"] == {"2026-06-24": "done"}, "its history stays"
    assert conn.execute("SELECT resolution FROM nodes WHERE id=?", (sid,)).fetchone()["resolution"] is None
    again = gcal.gcal_ingest(conn, events=[_occurrence("2026-07-08"), _occurrence("2026-07-15")], now=NOW)
    assert again["series_capped"] == [], "idempotent"


def test_existing_occurrence_nodes_heal_the_series_without_a_series_link(conn):
    # Occurrence nodes synced before the adapter carried series_uid: Google's
    # `<id>_<date>` shape still names the series.
    sid = _series_node(conn)
    gcal.gcal_ingest(conn, events=[_occurrence("2026-07-08", series_uid=None, timed=True)], now=NOW)
    assert _payload(conn, sid)["recurrence"]["until"] == "2026-07-08T07:59:59"


def test_a_source_that_still_sends_the_series_owns_its_rule(conn):
    sid = _series_node(conn)
    gcal.gcal_ingest(conn, events=[_occurrence("2026-07-08")], reconcile_deletes=False, now=NOW)
    # Back on a source that sends the series itself: the feed's rule wins and
    # nothing caps it again while the series is in the snapshot.
    series_ev = {"uid": SERIES, "summary": "Wash day", "start": "2024-07-24T00:00:00", "end": "2024-07-25T00:00:00",
                 "all_day": True, "recurrence": {"freq": "weekly"}, "status": "confirmed", "last_modified": None}
    res = gcal.gcal_ingest(conn, events=[series_ev], reconcile_deletes=False, now=NOW)
    assert res["series_capped"] == []
    assert _payload(conn, sid)["recurrence"] == {"freq": "weekly"}


def test_unrelated_series_and_hand_made_nodes_are_left_alone(conn):
    other = _series_node(conn, uid="zzz999other@google.com")
    mine = sched.add_node(conn, type="event", label="Wash day", when="2024-07-24T00:00:00",
                          payload={"recurrence": {"freq": "weekly"}})
    gcal.gcal_ingest(conn, events=[_occurrence("2026-07-08")], now=NOW)
    assert "until" not in _payload(conn, other)["recurrence"]
    assert "until" not in _payload(conn, mine)["recurrence"]


def test_a_series_filed_under_the_old_link_calendar_id_still_stops(conn):
    # 0.14.81: the same shared calendar has one id under the iCal link and
    # another under the Google account. The old series node sits under the
    # link's id, which no snapshot uses any more; its occurrences arrive under
    # the account's id. Scoped matching never saw it.
    sid = _series_node(conn, calendar_id="old-link-calendar")
    res = gcal.gcal_ingest(conn, events=[_occurrence("2026-07-08")], calendar_id="account-calendar", now=NOW)
    assert res["series_capped"] == [sid]
    assert _payload(conn, sid)["recurrence"]["until"] == "2026-07-07T23:59:59"
