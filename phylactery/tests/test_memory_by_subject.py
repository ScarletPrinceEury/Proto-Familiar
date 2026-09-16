"""list_by_subject backs the villager consent menu: a person may see what the
Familiar holds about THEM. Matching must be exact-id (quoted inside
subjects_json) so one villager can never see another's facts through a
substring id, and consent-pending rows stay out (they surface separately as
"planned" items)."""

import sqlite3
import pytest
from unittest.mock import patch

from phylactery import memory


def _fake_embed(text):
    return "[0, 0, 0, 1]"


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


def _seed(c):
    with patch("phylactery.embed.embed_text", _fake_embed):
        memory.create("Sam started pottery", "daily", date_key="2026-07-01",
                      slug="sam-pottery", standalone=True, subjects=["v-sam"], conn=c)
        memory.create("Kim moved house", "daily", date_key="2026-07-02",
                      slug="kim-moved", standalone=True, subjects=["v-kim"], conn=c)
        memory.create("Sam visited a clinic", "daily", date_key="2026-07-03",
                      slug="sam-clinic", standalone=True, subjects=["v-sam"],
                      consent_pending=True, conn=c)


def test_lists_only_that_villagers_kept_facts():
    c = _conn()
    _seed(c)
    items = memory.list_by_subject("v-sam", conn=c)
    briefs = [i["brief"] for i in items]
    assert any("pottery" in b for b in briefs)
    assert not any("Kim" in b for b in briefs), "another villager's fact leaked"


def test_consent_pending_rows_are_excluded():
    c = _conn()
    _seed(c)
    items = memory.list_by_subject("v-sam", conn=c)
    assert not any("clinic" in i["brief"] for i in items), "pending row leaked into kept list"


def test_substring_villager_id_cannot_false_match():
    c = _conn()
    _seed(c)
    # "v-sa" is a prefix of "v-sam" — the quoted-id LIKE must not match it.
    assert memory.list_by_subject("v-sa", conn=c) == []


def test_projection_is_thin():
    c = _conn()
    _seed(c)
    item = memory.list_by_subject("v-sam", conn=c)[0]
    assert set(item.keys()) == {"id", "category", "brief", "date"}


# ── Content-gating on the proactive villager read (0.12.13, ward-signed) ──────
# When topic_grants is passed (a villager-facing proactive read), a memory ABOUT
# the villager still only surfaces if their circle is cleared for its content_tag.
# Both None (consent menu / ward) stays ungated.

def _distinct_embed(text):
    # A constant fake vector makes every memory sim-1.00, so the deduper merges
    # two same-subject rows into one. Vary the vector by text so both survive.
    import math
    s = sum(ord(ch) for ch in text)
    return f"[{math.cos(s)}, {math.sin(s)}, {math.cos(s * 2)}, {math.sin(s * 2)}]"


def _seed_tagged(c):
    with patch("phylactery.embed.embed_text", _distinct_embed):
        memory.create("Sam likes strong tea", "daily", date_key="2026-07-01",
                      slug="sam-tea", standalone=True, subjects=["v-sam"],
                      content_tag="general:open", conn=c)
        memory.create("Sam is in therapy", "daily", date_key="2026-07-02",
                      slug="sam-therapy", standalone=True, subjects=["v-sam"],
                      content_tag="mental-health:sensitive", conn=c)


def test_ungated_read_still_sees_everything_about_them():
    c = _conn(); _seed_tagged(c)
    briefs = [i["brief"] for i in memory.list_by_subject("v-sam", conn=c)]
    assert any("tea" in b for b in briefs) and any("therapy" in b for b in briefs), \
        "the consent-menu / ward read (no topic_grants) must stay ungated"


def test_content_gate_hides_a_tag_the_circle_lacks():
    c = _conn(); _seed_tagged(c)
    # Circle sees everyday life but not mental health.
    items = memory.list_by_subject("v-sam", topic_grants={"general": "open"}, conn=c)
    briefs = [i["brief"] for i in items]
    assert any("tea" in b for b in briefs), "an open everyday memory is visible"
    assert not any("therapy" in b for b in briefs), "a mental-health memory must NOT leak to a circle without that grant"


def test_content_gate_shows_a_tag_the_circle_has():
    c = _conn(); _seed_tagged(c)
    items = memory.list_by_subject(
        "v-sam", topic_grants={"general": "open", "mental-health": "sensitive"}, conn=c)
    briefs = [i["brief"] for i in items]
    assert any("therapy" in b for b in briefs), "granted, the memory surfaces"


def test_content_gate_empty_grants_is_fail_closed():
    c = _conn(); _seed_tagged(c)
    assert memory.list_by_subject("v-sam", topic_grants={}, conn=c) == [], \
        "empty grants must surface nothing (fail-closed)"
