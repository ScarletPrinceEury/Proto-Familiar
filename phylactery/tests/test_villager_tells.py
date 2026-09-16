"""Villager tells (0.12.14): "what I've been meaning to bring up with them".

A tell lives in the per-villager memory store as kind='villager_tell' — invisible
to every narrative-only path — carrying the ward-content-gated audience sentinel
so a gated room's coarse floor admits it and the content-tag gate decides. It
surfaces exactly once (pending → surfaced → consumed), gated fail-closed the same
two-axis way as list_by_subject.
"""

import sqlite3
import pytest

from phylactery import memory


def _conn():
    try:
        import sqlite_vec
    except ImportError:
        pytest.skip("sqlite-vec not installed")
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.enable_load_extension(True)
    sqlite_vec.load(c)
    c.enable_load_extension(False)
    c.execute("""
        CREATE TABLE memories(
            id TEXT PRIMARY KEY, kind TEXT, register TEXT, granularity TEXT,
            date_key TEXT, slug TEXT, content TEXT, audience TEXT,
            subjects_json TEXT, care_weight TEXT, category TEXT, content_tag TEXT,
            consent_pending INTEGER DEFAULT 0, confidence REAL DEFAULT 1.0, attribution_confidence REAL,
            source_json TEXT, created_at TEXT, updated_at TEXT,
            recall_count INTEGER DEFAULT 0, last_recalled_at TEXT
        )
    """)
    c.execute("CREATE VIRTUAL TABLE memory_vecs USING vec0(memory_id TEXT PRIMARY KEY, embedding float[4])")
    return c


def test_create_and_list_ungated():
    c = _conn()
    assert memory.create_villager_tell("v-chen", "ask how the gig went", conn=c)["ok"]
    items = memory.list_villager_tells("v-chen", conn=c)
    assert [i["content"] for i in items] == ["ask how the gig went"]


def test_a_tell_is_invisible_to_the_fact_paths():
    c = _conn()
    memory.create_villager_tell("v-chen", "ask how the gig went", conn=c)
    # list_by_subject (narrative-only) must NOT see the tell.
    assert memory.list_by_subject("v-chen", conn=c) == []


def test_default_tag_is_open_and_surfaces_to_a_baseline_circle():
    c = _conn()
    memory.create_villager_tell("v-chen", "everyday thing", conn=c)
    items = memory.list_villager_tells(
        "v-chen", audiences=["ward-content-gated"], topic_grants={"general": "open"}, conn=c)
    assert [i["content"] for i in items] == ["everyday thing"], "an open tell surfaces to a general:open circle"


def test_a_sensitive_tell_is_hidden_without_the_grant():
    c = _conn()
    memory.create_villager_tell("v-chen", "their therapy thing", content_tag="mental-health:sensitive", conn=c)
    hidden = memory.list_villager_tells(
        "v-chen", audiences=["ward-content-gated"], topic_grants={"general": "open"}, conn=c)
    assert hidden == [], "a mental-health tell must not surface to a circle without that grant"
    shown = memory.list_villager_tells(
        "v-chen", audiences=["ward-content-gated"], topic_grants={"mental-health": "sensitive"}, conn=c)
    assert [i["content"] for i in shown] == ["their therapy thing"]


def test_empty_grants_is_fail_closed():
    c = _conn()
    memory.create_villager_tell("v-chen", "everyday thing", conn=c)
    assert memory.list_villager_tells("v-chen", audiences=["ward-content-gated"], topic_grants={}, conn=c) == []


def test_show_once_lifecycle():
    c = _conn()
    memory.create_villager_tell("v-chen", "the gig", conn=c)
    grants = {"general": "open"}
    aud = ["ward-content-gated"]
    # Turn 1: surfaces + stamps surfaced.
    first = memory.list_villager_tells("v-chen", audiences=aud, topic_grants=grants, mark_surfaced=True, conn=c)
    assert [i["content"] for i in first] == ["the gig"]
    # Turn 2: the previously-surfaced tell is consumed and NOT re-shown.
    second = memory.list_villager_tells("v-chen", audiences=aud, topic_grants=grants, mark_surfaced=True, conn=c)
    assert second == [], "a tell shows exactly once, then is consumed"
    # And it's gone from the store.
    assert memory.list_villager_tells("v-chen", conn=c) == []


def test_a_peek_without_mark_surfaced_does_not_consume():
    c = _conn()
    memory.create_villager_tell("v-chen", "the gig", conn=c)
    memory.list_villager_tells("v-chen", conn=c)   # read-only peek
    memory.list_villager_tells("v-chen", conn=c)
    assert len(memory.list_villager_tells("v-chen", conn=c)) == 1, "peeking never consumes"


def test_dedup_on_repeat():
    c = _conn()
    a = memory.create_villager_tell("v-chen", "ask how the gig went", conn=c)
    b = memory.create_villager_tell("v-chen", "ask how the gig went", conn=c)
    assert b.get("deduped") is True and b["id"] == a["id"]
    assert len(memory.list_villager_tells("v-chen", conn=c)) == 1


def test_one_villagers_tell_never_leaks_to_another():
    c = _conn()
    memory.create_villager_tell("v-chen", "chen thing", conn=c)
    assert memory.list_villager_tells("v-kim", conn=c) == []
    # substring id must not false-match either
    assert memory.list_villager_tells("v-che", conn=c) == []
