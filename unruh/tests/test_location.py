"""Unit tests for the locations + weather-cache layer (Weather sense W-A).

Run with: cd unruh && uv run pytest tests/test_location.py
"""

from __future__ import annotations

import sqlite3

import pytest

from unruh import location as loc
from unruh.db import run_migrations


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    run_migrations(c)
    yield c
    c.close()


# ── add / current ─────────────────────────────────────────────────────


def test_first_location_is_current(conn):
    r = loc.add_location(conn, label="home", lat=52.5, lon=13.4, timezone="Europe/Berlin")
    assert r["ok"] and r["is_current"] is True
    # A second is NOT auto-current.
    r2 = loc.add_location(conn, label="work", lat=52.4, lon=13.5)
    assert r2["is_current"] is False


def test_label_required(conn):
    assert loc.add_location(conn, label="   ")["ok"] is False


def test_set_current_by_label_and_id(conn):
    a = loc.add_location(conn, label="home")["id"]
    b = loc.add_location(conn, label="work")["id"]
    # by label
    assert loc.set_current(conn, ident="work")["id"] == b
    assert loc.get_current(conn)["id"] == b
    # exactly one current
    assert sum(1 for x in loc.list_locations(conn) if x["is_current"]) == 1
    # by id
    loc.set_current(conn, ident=a)
    assert loc.get_current(conn)["id"] == a
    # unknown
    assert loc.set_current(conn, ident="nope")["ok"] is False


def test_delete_reassigns_current(conn):
    a = loc.add_location(conn, label="home")["id"]  # current
    loc.add_location(conn, label="work")
    d = loc.delete_location(conn, ident="home")
    assert d["deleted"] == 1
    # work becomes current — never a placeless gap
    cur = loc.get_current(conn)
    assert cur is not None and cur["label"] == "work"
    # deleting a non-existent location is a no-op, not an error
    assert loc.delete_location(conn, ident="ghost") == {"ok": True, "deleted": 0}


# ── privacy shapes ────────────────────────────────────────────────────


def test_public_view_hides_coords(conn):
    loc.add_location(conn, label="home", lat=52.5, lon=13.4, place_name="Berlin", timezone="Europe/Berlin")
    pub = loc.list_locations(conn)[0]
    assert set(pub.keys()) == {"id", "label", "is_current"}
    assert "lat" not in pub and "place_name" not in pub and "timezone" not in pub
    # get_current default is public too
    assert set(loc.get_current(conn).keys()) == {"id", "label", "is_current"}


def test_private_view_carries_coords(conn):
    loc.add_location(conn, label="home", lat=52.5, lon=13.4, timezone="Europe/Berlin")
    priv = loc.list_locations(conn, private=True)[0]
    assert priv["lat"] == 52.5 and priv["lon"] == 13.4 and priv["timezone"] == "Europe/Berlin"


# ── weather cache ─────────────────────────────────────────────────────


def test_ingest_and_read_roundtrip(conn):
    lid = loc.add_location(conn, label="home")["id"]
    cur = {"temp_c": 6, "weather_code": 61, "precip_mm": 0.4, "wind_kmh": 12}
    hourly = [{"time": "2026-07-11T15:00:00", "temp_c": 6, "weather_code": 61,
               "precip_mm": 0.4, "precip_prob": 70, "wind_kmh": 12}]
    r = loc.ingest_weather(conn, location_id=lid, provider="open-meteo",
                           fetched_at="2026-07-11T14:00:00", current=cur, hourly=hourly)
    assert r["ok"] is True
    got = loc.read_weather(conn, location_id=lid)
    assert got["provider"] == "open-meteo"
    assert got["current"]["temp_c"] == 6
    assert got["hourly"][0]["precip_prob"] == 70
    assert got["fetched_at"] == "2026-07-11T14:00:00"


def test_ingest_replaces_not_appends(conn):
    lid = loc.add_location(conn, label="home")["id"]
    loc.ingest_weather(conn, location_id=lid, provider="open-meteo",
                       fetched_at="t1", current={"temp_c": 1}, hourly=[])
    loc.ingest_weather(conn, location_id=lid, provider="met-norway",
                       fetched_at="t2", current={"temp_c": 2}, hourly=[])
    got = loc.read_weather(conn, location_id=lid)
    assert got["provider"] == "met-norway" and got["current"]["temp_c"] == 2


def test_ingest_validates(conn):
    lid = loc.add_location(conn, label="home")["id"]
    assert loc.ingest_weather(conn, location_id="ghost", provider="x",
                              fetched_at="t", current={}, hourly=[])["ok"] is False
    assert loc.ingest_weather(conn, location_id=lid, provider="x",
                              fetched_at="t", current="nope", hourly=[])["ok"] is False
    assert loc.ingest_weather(conn, location_id=lid, provider="x",
                              fetched_at="t", current={}, hourly="nope")["ok"] is False


def test_read_weather_absent(conn):
    lid = loc.add_location(conn, label="home")["id"]
    assert loc.read_weather(conn, location_id=lid) is None


def test_delete_cascades_cache(conn):
    lid = loc.add_location(conn, label="home")["id"]
    loc.ingest_weather(conn, location_id=lid, provider="x", fetched_at="t",
                       current={}, hourly=[])
    loc.delete_location(conn, ident="home")
    # cache row gone with the location (FK cascade)
    assert conn.execute("SELECT COUNT(*) AS n FROM weather_cache").fetchone()["n"] == 0
