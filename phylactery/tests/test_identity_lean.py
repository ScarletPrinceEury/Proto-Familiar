"""Identity stays lean (0.14.70, ward-signed — docs/identity-lean-build-spec.md).

Identity is for the Familiar's own self and the shape of the bond. It rides every
turn and reaches group chats, so situational detail and care data about the human
belong in standing facts. These pin the revised graduation rule (protected core,
budget trigger regardless of recent edits, care lines leaving as HIGH-CARE ward
facts instead of being pinned), the auto care flag on create, and the care-facts
list that puts those facts back in front of the Familiar where they're needed.
"""

import json
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from phylactery import graduation as grad
from phylactery import memory as mem
from phylactery.db import get_conn

NOW = datetime(2026, 10, 14, tzinfo=timezone.utc)
FRESH = NOW.isoformat()          # edited today — the old rule never touched these


@pytest.fixture()
def conn(tmp_path):
    c = get_conn(tmp_path / "phylactery.db")
    with patch.object(mem, "_upsert_embedding", lambda *a, **k: None), \
         patch.object(mem, "_find_duplicate", lambda *a, **k: None):
        yield c
    c.close()


def _file(c, fid, category, filename, content, care_weight=None, updated=FRESH):
    with c:
        c.execute(
            "INSERT INTO identity_files(id, category, filename, content, care_weight, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (fid, category, filename, content, care_weight, updated, updated),
        )


def _ids(c):
    return {f["id"] for f in grad.eligible_identity_files(c, NOW)}


# ── Which files get audited ───────────────────────────────────────────────────

def test_an_over_budget_ward_file_is_audited_even_though_it_was_edited_today(conn):
    _file(conn, "w1", "ward", "ward_notes.md", "x " * 5000)       # 10k chars ≫ ward share (6k)
    cand = grad.eligible_identity_files(conn, NOW)
    assert [c["id"] for c in cand] == ["w1"]
    assert cand[0]["reason"] == "over budget"
    assert grad.FILE_TARGET_FLOOR_CHARS <= cand[0]["target_chars"] < 10000


def test_the_protected_core_is_never_audited_however_big(conn):
    for i, name in enumerate(sorted(grad.PROTECTED_SELF_FILES)):
        _file(conn, f"s{i}", "self", name, "y " * 20000, updated="2020-01-01T00:00:00+00:00")
    assert _ids(conn) == set()


def test_a_non_core_self_file_is_audited_when_self_is_over_budget(conn):
    _file(conn, "core", "self", "my_identity.md", "z " * 9000)   # protected, 18k chars
    _file(conn, "mech", "self", "my_mechanics.md", "m " * 3000)  # 6k chars
    cand = {c["id"]: c for c in grad.eligible_identity_files(conn, NOW)}
    assert set(cand) == {"mech"}
    # The protected core already uses more than self's share → the floor.
    assert cand["mech"]["target_chars"] == grad.FILE_TARGET_FLOOR_CHARS


def test_under_budget_and_recently_edited_is_left_alone(conn):
    _file(conn, "w1", "ward", "user_identity.md", "Their name is Sam; they/them.")
    assert _ids(conn) == set()


def test_an_explicit_high_care_pin_on_a_file_still_wins(conn):
    _file(conn, "w1", "ward", "ward_notes.md", "x " * 5000, care_weight="high")
    assert _ids(conn) == set()


def test_care_words_no_longer_pin_a_whole_file(conn):
    # Before 0.14.70 one "what helps" anywhere kept the entire file forever.
    _file(conn, "w1", "ward", "ward_notes.md", ("what helps: tea. " + "x " * 5000))
    assert _ids(conn) == {"w1"}


def test_the_budget_is_my_humans_setting(conn):
    _file(conn, "w1", "ward", "ward_notes.md", "x " * 2000)       # 4k chars
    assert _ids(conn) == set(), "fits the default ward share (6k)"
    assert grad.set_identity_budget_tokens(2000, conn=conn) == {"ok": True, "tokens": 2000}
    assert _ids(conn) == {"w1"}, "over the smaller ward share (2k)"
    assert grad.set_identity_budget_tokens(10, conn=conn)["tokens"] == grad.IDENTITY_BUDGET_MIN_TOKENS


# ── What the audit does with what it moves ────────────────────────────────────

def test_care_lines_leave_as_high_care_ward_facts_and_the_file_is_trimmed(conn):
    _file(conn, "w1", "ward", "ward_notes.md", "x " * 5000)
    reply = json.dumps({
        "graduate": [
            {"summary": "meds", "content": "My human takes 50mg sertraline every morning."},
            {"summary": "film", "content": "My human's favourite film is Arrival."},
        ],
        "kept_content": "My human is Sam.",
    })
    res = grad.run_graduation_audit(conn, {}, lambda cfg, prompt: reply, NOW)
    assert res["graduated"] == 2
    rows = {r["content"]: r for r in conn.execute("SELECT content, register, care_weight FROM memories")}
    assert rows["My human takes 50mg sertraline every morning."]["care_weight"] == "high"
    assert rows["My human takes 50mg sertraline every morning."]["register"] == "ward"
    assert rows["My human's favourite film is Arrival."]["care_weight"] is None
    assert conn.execute("SELECT content FROM identity_files WHERE id='w1'").fetchone()["content"] == "My human is Sam."
    assert len(grad.list_unacknowledged_graduations(conn)) == 2, "my human sees what was filed away"


def test_self_detail_leaves_as_me_facts(conn):
    _file(conn, "core", "self", "my_identity.md", "z " * 9000)
    _file(conn, "mech", "self", "my_mechanics.md", "m " * 3000)
    reply = json.dumps({"graduate": [{"summary": "s", "content": "I keep my tool notes short."}], "kept_content": "How my memory works."})
    grad.run_graduation_audit(conn, {}, lambda cfg, prompt: reply, NOW)
    row = conn.execute("SELECT register, care_weight FROM memories").fetchone()
    assert row["register"] == "me" and row["care_weight"] is None


def test_the_audit_prompt_no_longer_tells_me_to_keep_care_lines(conn):
    p = grad._audit_prompt("ward", "ward_notes.md", "x" * 3000, 1200)
    assert "high-care" in p and "about 1200" in p
    assert "NEVER file away anything care-critical" not in p


# ── The auto care flag and the care-facts list ────────────────────────────────

def test_a_care_critical_ward_fact_is_high_care_whoever_writes_it(conn):
    a = mem.create("Allergic to penicillin.", "significant", slug="pen", register="ward", conn=conn)
    b = mem.create("Loves hiking.", "significant", slug="hike", register="ward", conn=conn)
    c = mem.create("I take my time with tea.", "significant", slug="tea", register="me", conn=conn)
    d = mem.create("Allergic to dust.", "significant", slug="dust", register="ward", care_weight="normal", conn=conn)
    cw = {r["id"]: r["care_weight"] for r in conn.execute("SELECT id, care_weight FROM memories")}
    assert cw[a["id"]] == "high"
    assert cw[b["id"]] is None
    assert cw[c["id"]] is None, "only facts about my human"
    assert cw[d["id"]] == "normal", "an explicit care_weight wins"


def test_my_own_high_care_call_decides_whatever_the_wording(conn):
    """0.14.71: the Familiar's high_care flag ('high'/'low', the Knowledge editor's
    vocabulary) puts a plainly worded care request in the care list, or takes a
    care-sounding one out, on create and on a later by-id update."""
    shift = mem.create("Wants a nudge to eat before a long shift.",
                       "significant", slug="shift", register="ward", care_weight="high", conn=conn)
    water = mem.create("Likes a reminder to drink water mid-afternoon.",
                       "significant", slug="water", register="ward", conn=conn)
    joke = mem.create("Jokes that coffee is their medication.",
                      "significant", slug="joke", register="ward", care_weight="low", conn=conn)
    listed = lambda: {i["id"] for i in mem.list_care_facts(conn=conn)}
    assert listed() == {shift["id"]}, "flagged by me, not by wording; the explicit low beats 'medication'"
    mem.update_memory_by_id(water["id"], care_weight="high", conn=conn)
    mem.update_memory_by_id(shift["id"], care_weight="low", conn=conn)
    assert listed() == {water["id"]}


def test_care_facts_list_reads_flagged_and_unflagged_care_facts_crisis_first(conn):
    with conn:
        for i, (content, cat, cw, pending) in enumerate([
            ("Loves hiking.", None, None, 0),                                  # not care
            ("What helps when they spiral: a walk.", None, None, 0),           # unflagged, matches
            ("Support person: their sister, 555-0100.", "support-map", "high", 0),
            ("Takes 20mg fluoxetine.", "health_info", "high", 0),
            ("Allergic to dust.", None, "normal", 0),                          # explicitly not high
            ("New med: 10mg something.", None, None, 1),                       # consent pending
        ]):
            conn.execute(
                "INSERT INTO memories(id, kind, register, granularity, date_key, content, audience, "
                "care_weight, category, consent_pending, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (f"m{i}", "narrative", "ward", "significant", f"2026-10-0{i+1}_x{i}", content,
                 "ward-private", cw, cat, pending, FRESH, FRESH),
            )
        conn.execute(
            "INSERT INTO memories(id, kind, register, granularity, date_key, content, audience, created_at, updated_at) "
            "VALUES ('me1','narrative','me','significant','2026-10-09_me','I have a trigger word for focus.','ward-private',?,?)",
            (FRESH, FRESH),
        )
    items = mem.list_care_facts(conn=conn)
    assert [i["id"] for i in items] == ["m2", "m3", "m1"], "support-map, then health, then the rest"
    assert mem.list_care_facts(limit=1, conn=conn)[0]["id"] == "m2"


def test_a_paused_cleanup_leaves_every_file_alone_budget_and_age_alike(conn, monkeypatch):
    """0.14.72: my human can pause the automatic identity cleanup (e.g. while we go
    through my files together). The budget hold alone never covered the 30-day rule."""
    old = "2026-08-01T00:00:00+00:00"   # well past the 30-day dwell
    _file(conn, "r1", "relationship", "relationship_dynamics.md", "x " * 5000, updated=old)
    assert grad.eligible_identity_files(conn, NOW), "eligible when not paused"
    asked = []
    llm = lambda cfg, prompt: asked.append(prompt) or "{}"
    assert grad.set_graduation_paused(True, conn=conn) == {"ok": True, "paused": True}
    out = grad.run_graduation_audit(conn, {}, llm, NOW)
    assert out.get("skipped") == "paused" and out["graduated"] == 0 and not asked
    grad.set_graduation_paused(False, conn=conn)
    assert not grad.graduation_paused(conn)
    monkeypatch.setenv("PHYLACTERY_GRADUATION_DISABLED", "1")
    assert grad.graduation_paused(conn), "the hard env off-switch"
