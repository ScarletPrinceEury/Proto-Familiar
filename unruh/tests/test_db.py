"""Unit tests for db.py timezone and timestamp handling.

Run with: cd unruh && uv run pytest tests/test_db.py -q

Tests cover timezone conversion (to_local_naive), now_iso format,
DST handling (the Windows DST bug fix), and edge cases like naive
inputs, unparseable values, and missing TZ env vars.

The _ZONE_CACHE is cleared between tests to isolate timezone state.
os.environ['TZ'] is restored/deleted in teardown via a fixture.
"""

from __future__ import annotations

import os
import re
import sys
import time
from datetime import datetime

import pytest

import unruh.db as db


@pytest.fixture(autouse=True)
def reset_tz():
    """Fixture to capture and restore os.environ['TZ'] before/after each test.

    This prevents TZ state from leaking across tests, which is critical
    because _ZONE_CACHE is module-level and persists across tests.
    """
    original_tz = os.environ.get('TZ')
    yield
    # Teardown: restore original state
    db._ZONE_CACHE.clear()
    if original_tz is not None:
        os.environ['TZ'] = original_tz
    elif 'TZ' in os.environ:
        del os.environ['TZ']
    # On Unix, tzset() syncs the C runtime; guard it for portability
    if hasattr(time, 'tzset'):
        time.tzset()


class TestToLocalNaive:
    """Tests for the to_local_naive function with various timezone/DST scenarios."""

    def test_berlin_summer_dst_offset_bearing_input(self):
        """Berlin summer DST: the reported Windows bug fix.

        A 14:00+02:00 input from Google Calendar (offset-bearing) should
        stay 14:00 local, NOT regress to 13:00 (the Windows DST bug).
        """
        os.environ['TZ'] = 'Europe/Berlin'
        db._ZONE_CACHE.clear()
        if hasattr(time, 'tzset'):
            time.tzset()

        # Input is already in Berlin summer time (+02:00 CEST).
        # When converted back to local, it should remain 14:00.
        result = db.to_local_naive('2026-07-05T14:00:00+02:00')
        assert result == '2026-07-05T14:00:00', \
            f"Expected 14:00 (DST applied), got {result} (bug: 13:00 on old Windows code)"

    def test_berlin_summer_utc_to_local(self):
        """Berlin summer: UTC input should apply DST (+02:00)."""
        os.environ['TZ'] = 'Europe/Berlin'
        db._ZONE_CACHE.clear()
        if hasattr(time, 'tzset'):
            time.tzset()

        # 12:00 UTC on 2026-07-05 = 14:00 Berlin time (CEST, +02:00).
        result = db.to_local_naive('2026-07-05T12:00:00Z')
        assert result == '2026-07-05T14:00:00', \
            f"Expected 14:00 (UTC+2 DST), got {result}"

    def test_berlin_winter_standard_time(self):
        """Berlin winter: standard time (CET, +01:00, no DST)."""
        os.environ['TZ'] = 'Europe/Berlin'
        db._ZONE_CACHE.clear()
        if hasattr(time, 'tzset'):
            time.tzset()

        # 14:00+01:00 on 2026-01-05 (winter, CET standard time).
        result = db.to_local_naive('2026-01-05T14:00:00+01:00')
        assert result == '2026-01-05T14:00:00', \
            f"Expected 14:00 (standard time), got {result}"

    def test_new_york_summer_edt(self):
        """New York summer: UTC input should apply EDT (-04:00)."""
        os.environ['TZ'] = 'America/New_York'
        db._ZONE_CACHE.clear()
        if hasattr(time, 'tzset'):
            time.tzset()

        # 12:00 UTC on 2026-07-05 = 08:00 New York time (EDT, -04:00).
        result = db.to_local_naive('2026-07-05T12:00:00Z')
        assert result == '2026-07-05T08:00:00', \
            f"Expected 08:00 (UTC-4 EDT), got {result}"

    def test_naive_passthrough_unchanged(self):
        """A naive ISO string (no offset) should be reformatted to seconds but otherwise unchanged."""
        os.environ['TZ'] = 'Europe/Berlin'
        db._ZONE_CACHE.clear()
        if hasattr(time, 'tzset'):
            time.tzset()

        # Naive input is already assumed to be local wall-clock.
        result = db.to_local_naive('2026-07-05T14:00:00')
        assert result == '2026-07-05T14:00:00', \
            f"Expected naive input to pass through, got {result}"

    def test_naive_passthrough_with_microseconds_trimmed(self):
        """A naive input with sub-second precision should be trimmed to seconds."""
        os.environ['TZ'] = 'Europe/Berlin'
        db._ZONE_CACHE.clear()
        if hasattr(time, 'tzset'):
            time.tzset()

        result = db.to_local_naive('2026-07-05T14:00:00.123456')
        assert result == '2026-07-05T14:00:00', \
            f"Expected sub-second trimmed to seconds, got {result}"

    def test_none_input_passthrough(self):
        """to_local_naive(None) should return None."""
        os.environ['TZ'] = 'Europe/Berlin'
        db._ZONE_CACHE.clear()

        result = db.to_local_naive(None)
        assert result is None, f"Expected None, got {result}"

    def test_empty_string_passthrough(self):
        """to_local_naive('') should return ''."""
        os.environ['TZ'] = 'Europe/Berlin'
        db._ZONE_CACHE.clear()

        result = db.to_local_naive('')
        assert result == '', f"Expected empty string, got {result!r}"

    def test_unparseable_string_passthrough(self):
        """An unparseable string should be returned unchanged (validation at caller)."""
        os.environ['TZ'] = 'Europe/Berlin'
        db._ZONE_CACHE.clear()

        result = db.to_local_naive('not a date')
        assert result == 'not a date', f"Expected unparseable string to pass through, got {result}"

    def test_tz_unset_fallback_to_astimezone(self):
        """When TZ is unset, _local_zone() returns None and to_local_naive() falls back to astimezone().

        We can't assert an exact value (depends on runner's local zone),
        but we can assert the output is a naive ISO string (no '+' or 'Z').
        """
        # Ensure TZ is unset
        if 'TZ' in os.environ:
            del os.environ['TZ']
        db._ZONE_CACHE.clear()
        if hasattr(time, 'tzset'):
            time.tzset()

        # Assert _local_zone() returns None when TZ is unset
        assert db._local_zone() is None, "Expected _local_zone() to return None when TZ is unset"

        # to_local_naive should still work, converting to local via astimezone()
        result = db.to_local_naive('2026-07-05T12:00:00Z')
        assert result is not None and result != ''
        # Naive ISO: no '+' or 'Z' should appear
        assert '+' not in result and 'Z' not in result, \
            f"Expected naive ISO output (no offset), got {result}"
        # Should be a valid ISO string
        assert re.match(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}', result), \
            f"Expected valid naive ISO format, got {result}"


class TestNowIso:
    """Tests for now_iso() format and timezone behavior."""

    def test_now_iso_format_with_tz(self):
        """now_iso() should return a naive ISO string in seconds precision (19 chars)."""
        os.environ['TZ'] = 'Europe/Berlin'
        db._ZONE_CACHE.clear()
        if hasattr(time, 'tzset'):
            time.tzset()

        result = db.now_iso()

        # Assert format: YYYY-MM-DDTHH:MM:SS (19 characters)
        assert len(result) == 19, \
            f"Expected 19-char ISO string, got {len(result)}: {result}"
        assert re.match(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}', result), \
            f"Expected YYYY-MM-DDTHH:MM:SS format, got {result}"
        # Must be naive: no timezone offset or 'Z'
        assert '+' not in result and 'Z' not in result, \
            f"Expected naive (no offset), got {result}"

    def test_now_iso_no_tz_fallback(self):
        """now_iso() should work even when TZ is unset (falls back to system local)."""
        if 'TZ' in os.environ:
            del os.environ['TZ']
        db._ZONE_CACHE.clear()
        if hasattr(time, 'tzset'):
            time.tzset()

        result = db.now_iso()

        # Same format checks as above
        assert len(result) == 19, \
            f"Expected 19-char ISO string, got {len(result)}: {result}"
        assert re.match(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}', result), \
            f"Expected YYYY-MM-DDTHH:MM:SS format, got {result}"
        assert '+' not in result and 'Z' not in result, \
            f"Expected naive (no offset), got {result}"


class TestLocalZone:
    """Tests for the _local_zone() helper and its caching behavior."""

    def test_local_zone_caches_result(self):
        """_local_zone() should cache the ZoneInfo object."""
        os.environ['TZ'] = 'Europe/Berlin'
        db._ZONE_CACHE.clear()

        zone1 = db._local_zone()
        zone2 = db._local_zone()

        # Same object (cached)
        assert zone1 is zone2, "Expected _local_zone() to return cached object"

    def test_local_zone_returns_none_when_unset(self):
        """_local_zone() should return None when TZ env var is unset."""
        if 'TZ' in os.environ:
            del os.environ['TZ']
        db._ZONE_CACHE.clear()

        result = db._local_zone()
        assert result is None, "Expected _local_zone() to return None when TZ is unset"

    def test_local_zone_returns_none_for_invalid_tz(self):
        """_local_zone() should return None and cache the failure for invalid TZ names."""
        os.environ['TZ'] = 'Invalid/Zone/Name'
        db._ZONE_CACHE.clear()

        result = db._local_zone()
        assert result is None, "Expected _local_zone() to return None for invalid TZ"
        # Second call should return cached None (not retry the lookup)
        result2 = db._local_zone()
        assert result2 is None, "Expected cached None result"

    def test_local_zone_cache_key_isolation(self):
        """Different TZ values should have separate cache entries."""
        db._ZONE_CACHE.clear()

        os.environ['TZ'] = 'Europe/Berlin'
        zone_berlin = db._local_zone()

        os.environ['TZ'] = 'America/New_York'
        db._ZONE_CACHE.clear()  # Simulate a fresh process
        zone_ny = db._local_zone()

        # Both should be valid but different
        assert zone_berlin is not None
        assert zone_ny is not None
        assert str(zone_berlin) != str(zone_ny)


class TestHealMalformedScheduleTimes:
    """Repair of legacy date-less / offset-stamped schedule times (the
    "T13:00:00+00:00" artifacts that leaked raw into the temporal briefing)."""

    def _phase(self, conn, node_id, when_ts, end_ts, created="2026-07-01T09:00:00"):
        conn.execute(
            "INSERT INTO nodes (id, layer, type, label, when_ts, end_ts, created_at, updated_at) "
            "VALUES (?, 'schedule', 'phase', 'Sweep', ?, ?, ?, ?)",
            (node_id, when_ts, end_ts, created, created),
        )
        conn.commit()

    def test_salvages_dateless_utc_artifact(self, tmp_path):
        conn = db.get_conn(tmp_path / "u.db")
        self._phase(conn, "p1", "T13:00:00+00:00", "T18:00:00+00:00")
        n = db.heal_malformed_schedule_times(conn)
        assert n == 1
        row = conn.execute("SELECT when_ts, end_ts FROM nodes WHERE id='p1'").fetchone()
        assert row["when_ts"] == "2026-07-01T13:00:00"   # wall-clock kept, offset dropped, dated
        assert row["end_ts"] == "2026-07-01T18:00:00"

    def test_salvages_bare_time_string(self, tmp_path):
        conn = db.get_conn(tmp_path / "u.db")
        self._phase(conn, "p2", "23:00:00", None)
        db.heal_malformed_schedule_times(conn)
        row = conn.execute("SELECT when_ts FROM nodes WHERE id='p2'").fetchone()
        assert row["when_ts"] == "2026-07-01T23:00:00"

    def test_is_idempotent(self, tmp_path):
        conn = db.get_conn(tmp_path / "u.db")
        self._phase(conn, "p3", "T13:00:00+00:00", None)
        assert db.heal_malformed_schedule_times(conn) == 1
        assert db.heal_malformed_schedule_times(conn) == 0   # already clean

    def test_leaves_clean_local_naive_untouched(self, tmp_path):
        conn = db.get_conn(tmp_path / "u.db")
        self._phase(conn, "p4", "2026-07-01T10:00:00", "2026-07-01T11:00:00")
        assert db.heal_malformed_schedule_times(conn) == 0
        row = conn.execute("SELECT when_ts FROM nodes WHERE id='p4'").fetchone()
        assert row["when_ts"] == "2026-07-01T10:00:00"
