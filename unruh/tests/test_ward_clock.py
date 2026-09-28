"""Ward-clock time-model fixes (2026-09 audit, Theme 1).

The derived-signal code must compute 'now' on the WARD's clock (TZ), not the
platform's — else on a server whose timezone differs from the ward's, gauge
bands / staleness / expiry / interest decay / elapsed stamping all drift by the
offset (the 0.7.86 bug class). These pin db.now_local / to_naive_local /
local_to_utc, and the tracker `date`-field validation that used to be dead.

    cd unruh && uv run pytest tests/test_ward_clock.py
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from unruh import db, tracker


@pytest.fixture
def la_zone(monkeypatch):
    """Ward zone = America/Los_Angeles (UTC-7 in July, PDT). Clears the cache
    around the test so the TZ override actually takes."""
    monkeypatch.setenv("TZ", "America/Los_Angeles")
    db._ZONE_CACHE.clear()
    yield
    db._ZONE_CACHE.clear()


# ── db helpers ────────────────────────────────────────────────────────────────

def test_now_local_is_naive():
    assert db.now_local().tzinfo is None


def test_to_naive_local_passes_naive_through_unchanged():
    d = datetime(2026, 7, 2, 14, 0, 0)
    assert db.to_naive_local(d) == d


def test_to_naive_local_converts_aware_in_the_ward_zone(la_zone):
    # 21:00 UTC is 14:00 in Los Angeles (PDT, UTC-7).
    aware = datetime(2026, 7, 2, 21, 0, 0, tzinfo=timezone.utc)
    got = db.to_naive_local(aware)
    assert got.tzinfo is None
    assert got == datetime(2026, 7, 2, 14, 0, 0)


def test_local_to_utc_interprets_naive_as_ward_local(la_zone):
    # 14:00 ward-local (PDT) → 21:00 UTC. A bare .astimezone() would instead
    # read the platform zone and land somewhere else on a mismatched server.
    naive = datetime(2026, 7, 2, 14, 0, 0)
    got = db.local_to_utc(naive)
    assert got.utcoffset() == timedelta(0)          # aware UTC
    assert got.replace(tzinfo=None) == datetime(2026, 7, 2, 21, 0, 0)


def test_now_local_reflects_ward_zone(la_zone):
    # now_local (ward zone) and a naive platform-UTC now differ by ~the offset;
    # the point is only that now_local is NOT the raw UTC wall-clock here.
    ward = db.now_local()
    utc_naive = datetime.now(timezone.utc).replace(tzinfo=None)
    # PDT is 7h behind UTC; allow slack for execution time.
    assert abs((utc_naive - ward) - timedelta(hours=7)) < timedelta(minutes=2)


# ── tracker `date`-field validation (was dead — stored garbage as valid) ──────

def test_date_field_rejects_unparseable_value():
    schema = [{"name": "expires", "type": "date"}]
    v = tracker.validate_entry(schema, {"expires": "banana"})
    assert v["ok"] is False
    assert any("expires" in e for e in v["errors"])


def test_date_field_accepts_and_normalises_a_real_date():
    schema = [{"name": "expires", "type": "date"}]
    v = tracker.validate_entry(schema, {"expires": "2026-07-02"})
    assert v["ok"] is True
    assert v["cleaned"]["expires"].startswith("2026-07-02")
