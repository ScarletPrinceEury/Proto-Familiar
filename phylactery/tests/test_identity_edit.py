"""Identity whole-file edit + section delete (the Knowledge-manager editor gaps).

set_file overwrites a whole file (reaching heading-less/top content that
rewrite_section can't target); delete_section removes one section or reports it
missing. Both auto-snapshot (a no-op in-memory here) and never silently no-op.
"""

import sqlite3
from phylactery import identity as ident


def _conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute(
        "CREATE TABLE identity_files("
        "id TEXT PRIMARY KEY, category TEXT, filename TEXT, content TEXT, "
        "prompt_label TEXT, sort_order INTEGER, created_at TEXT, updated_at TEXT)"
    )
    return c


def _content(c, cat, fn):
    row = c.execute("SELECT content FROM identity_files WHERE category=? AND filename=?", (cat, fn)).fetchone()
    return row["content"] if row else None


# ── _delete_section (pure) ────────────────────────────────────────────────────

def test_delete_section_removes_heading_and_body():
    text = "intro line\n\n## Keep\nkeep body\n\n## Drop\ndrop body\n\n## Also keep\nmore\n"
    out, removed = ident._delete_section(text, "Drop")
    assert removed is True
    assert "Drop" not in out and "drop body" not in out
    assert "## Keep" in out and "## Also keep" in out and "intro line" in out


def test_delete_section_absent_reports_false():
    out, removed = ident._delete_section("## A\nx\n", "Nope")
    assert removed is False
    assert out == "## A\nx\n"


# ── set_file ──────────────────────────────────────────────────────────────────

def test_set_file_creates_then_overwrites_including_top_content():
    c = _conn()
    assert ident.set_file("self", "my_persona.md", "no headings, just prose", conn=c)["ok"] is True
    assert _content(c, "self", "my_persona.md") == "no headings, just prose"
    # Overwrite — reaches the top content a section-rewrite can't.
    assert ident.set_file("self", "my_persona.md", "## Voice\nblunt\n", conn=c)["ok"] is True
    assert _content(c, "self", "my_persona.md") == "## Voice\nblunt\n"


def test_set_file_rejects_bad_category():
    c = _conn()
    r = ident.set_file("nonsense", "x.md", "y", conn=c)
    assert r["ok"] is False and "category" in r["error"]


# ── delete_section (DB) ───────────────────────────────────────────────────────

def test_delete_section_updates_the_row():
    c = _conn()
    ident.set_file("ward", "user_life.md", "## Job\ndev\n\n## Hobby\nclimbing\n", conn=c)
    assert ident.delete_section("ward", "user_life.md", "Job", conn=c)["ok"] is True
    left = _content(c, "ward", "user_life.md")
    assert "Job" not in left and "## Hobby" in left


def test_delete_section_missing_file_or_section_errors():
    c = _conn()
    assert ident.delete_section("ward", "ghost.md", "X", conn=c)["ok"] is False
    ident.set_file("ward", "user_life.md", "## Job\ndev\n", conn=c)
    r = ident.delete_section("ward", "user_life.md", "Nope", conn=c)
    assert r["ok"] is False and "section not found" in r["error"]


def test_rewrite_then_delete_roundtrip():
    c = _conn()
    ident.set_file("custom", "notes.md", "top intro\n\n## One\na\n", conn=c)
    ident.rewrite_section("custom", "notes.md", "One", "updated", conn=c)
    assert "updated" in _content(c, "custom", "notes.md")
    ident.delete_section("custom", "notes.md", "One", conn=c)
    after = _content(c, "custom", "notes.md")
    assert "One" not in after and "top intro" in after  # top content survives a section delete


# ── The Familiar's own trimming tools (0.14.72) ──────────────────────────────
# Found in the first identity review with a live Familiar: update_identity can
# only add, rewrite_section can't reach a file without headings (and appended a
# NEW section when the heading didn't match, while reporting success), and there
# was no tool to cut a moved line out at all.

NOTES = "Lives near the river.\n**Pets:** two cats, both elderly.\nLikes quiet mornings.\n"


def test_remove_text_cuts_one_passage_from_a_file_without_headings():
    c = _conn()
    ident.set_file("ward", "user_notes.md", NOTES, conn=c)
    r = ident.remove_text("ward", "user_notes.md", "**Pets:** two cats, both elderly.", conn=c)
    assert r["ok"] is True and r["removed_chars"] == len("**Pets:** two cats, both elderly.")
    assert _content(c, "ward", "user_notes.md") == "Lives near the river.\nLikes quiet mornings.\n"


def test_remove_text_tolerates_different_whitespace_but_not_different_words():
    c = _conn()
    ident.set_file("ward", "user_notes.md", "## Habits\n- Walks every\n  evening by the canal.\n- Reads late.\n", conn=c)
    assert ident.remove_text("ward", "user_notes.md", "- Walks every evening by the canal.", conn=c)["ok"] is True
    assert "canal" not in _content(c, "ward", "user_notes.md")
    before = _content(c, "ward", "user_notes.md")
    r = ident.remove_text("ward", "user_notes.md", "- Reads early.", conn=c)
    assert r["ok"] is False and "isn't in" in r["error"]
    assert _content(c, "ward", "user_notes.md") == before, "a miss changes nothing"


def test_remove_text_refuses_a_passage_that_appears_twice():
    c = _conn()
    ident.set_file("ward", "user_notes.md", "- tea\n## Later\n- tea\n", conn=c)
    r = ident.remove_text("ward", "user_notes.md", "- tea", conn=c)
    assert r["ok"] is False and "2 times" in r["error"]
    assert _content(c, "ward", "user_notes.md") == "- tea\n## Later\n- tea\n"


def test_remove_text_errors_on_a_missing_file_or_empty_passage():
    c = _conn()
    assert ident.remove_text("ward", "ghost.md", "x", conn=c)["ok"] is False
    ident.set_file("ward", "user_notes.md", NOTES, conn=c)
    assert ident.remove_text("ward", "user_notes.md", "   ", conn=c)["ok"] is False


def test_rewrite_can_refuse_a_missing_heading_and_names_the_real_ones():
    c = _conn()
    ident.set_file("ward", "user_identity.md", "## Name\nSam\n\n## Places\nLisbon\n", conn=c)
    r = ident.rewrite_section("ward", "user_identity.md", "Pets", "two cats", conn=c, create_if_missing=False)
    assert r["ok"] is False and r["sections"] == ["Name", "Places"]
    assert "Pets" not in _content(c, "ward", "user_identity.md"), "nothing appended"
    assert ident.rewrite_section("ward", "ghost.md", "X", "y", conn=c, create_if_missing=False)["ok"] is False


def test_rewrite_reports_whether_it_replaced_and_still_appends_by_default():
    c = _conn()
    ident.set_file("custom", "notes.md", "## One\na\n", conn=c)
    r = ident.rewrite_section("custom", "notes.md", "One", "b", conn=c)
    assert (r["ok"], r["replaced"]) == (True, True)
    r = ident.rewrite_section("custom", "notes.md", "Two", "c", conn=c)
    assert (r["ok"], r["replaced"], r["chars"]) == (True, False, len(_content(c, "custom", "notes.md")))
    assert "## Two" in _content(c, "custom", "notes.md"), "other clients keep the old append-on-missing"


def test_rewrite_keeps_a_backslash_in_the_new_body_as_text():
    c = _conn()
    ident.set_file("custom", "notes.md", "## Paths\nold\n", conn=c)
    ident.rewrite_section("custom", "notes.md", "Paths", r"C:\Users\me and \1", conn=c)
    assert r"C:\Users\me and \1" in _content(c, "custom", "notes.md")


# ── Reading a file, and edits that act on one section (known-issues A1) ──────
# Rewrite and delete used to act on EVERY section with a matching heading, a
# section ended at any line starting with "#", and a rewrite whose new body
# carried the next section left that section in twice.

# The shape the live files have: one # title, then ## sections.
REAL = "# My Persona\n\nIntro.\n\n## Tone\nwarm\n\n## Habits\n#nightowl\nlate nights\n\n## Tone\nblunt\n"


def test_outline_numbers_repeated_headings_and_ignores_hashtags():
    out = ident.outline(REAL)
    assert [o["heading"] for o in out] == ["My Persona", "Tone", "Habits", "Tone"]
    assert (out[1]["occurrence"], out[1]["of"]) == (1, 2) and (out[3]["occurrence"], out[3]["of"]) == (2, 2)
    assert "occurrence" not in out[2]
    habits = REAL[REAL.index("## Habits"):REAL.index("## Tone\nblunt")]
    assert out[2]["chars"] == len(habits), "#nightowl is text inside Habits, not a heading"


def test_rewrite_refuses_a_repeated_heading_without_occurrence():
    c = _conn()
    ident.set_file("self", "my_persona.md", REAL, conn=c)
    r = ident.rewrite_section("self", "my_persona.md", "Tone", "calm", conn=c, create_if_missing=False)
    assert r["ok"] is False and r["code"] == "duplicate" and r["count"] == 2
    assert _content(c, "self", "my_persona.md") == REAL
    r = ident.rewrite_section("self", "my_persona.md", "Tone", "calm", conn=c, create_if_missing=False, occurrence=2)
    assert r["ok"] is True
    after = _content(c, "self", "my_persona.md")
    assert "## Tone\nwarm" in after and "## Tone\ncalm" in after and "blunt" not in after
    assert ident.rewrite_section("self", "my_persona.md", "Tone", "x", conn=c, occurrence=3)["code"] == "bad_occurrence"


def test_rewrite_refuses_a_body_that_carries_another_section():
    c = _conn()
    text = "# T\n\n## A\nold a\n\n## B\nold b\n"
    ident.set_file("self", "my_wants.md", text, conn=c)
    r = ident.rewrite_section("self", "my_wants.md", "A", "new a\n\n## B\nold b", conn=c, create_if_missing=False)
    assert r["ok"] is False and r["code"] == "includes_heading" and r["headings"] == ["B"]
    assert _content(c, "self", "my_wants.md") == text, "nothing changed"


def test_rewrite_of_one_section_keeps_the_rest_and_the_title():
    c = _conn()
    ident.set_file("self", "my_wants.md", "# T\n\nintro\n\n## A\nold a\n\n## B\nold b\n", conn=c)
    r = ident.rewrite_section("self", "my_wants.md", "A", "## A\nnew a", conn=c, create_if_missing=False)
    assert r["ok"] is True and r["chars"] == len(_content(c, "self", "my_wants.md"))
    after = _content(c, "self", "my_wants.md")
    assert after.count("## A") == 1, "a body that opens with its own heading doesn't double it"
    assert "# T\n\nintro" in after and "new a" in after and "old a" not in after and "## B\nold b" in after


def test_rewrite_of_a_section_doesnt_stop_at_a_hashtag_line():
    c = _conn()
    ident.set_file("self", "my_persona.md", "## Habits\n#nightowl\nlate\n\n## Other\nx\n", conn=c)
    ident.rewrite_section("self", "my_persona.md", "Habits", "early now", conn=c, create_if_missing=False)
    after = _content(c, "self", "my_persona.md")
    assert "#nightowl" not in after and "late" not in after and "## Other\nx" in after


def test_delete_refuses_a_repeated_heading_and_then_removes_just_one():
    c = _conn()
    ident.set_file("self", "my_persona.md", REAL, conn=c)
    r = ident.delete_section("self", "my_persona.md", "Tone", conn=c)
    assert r["ok"] is False and r["code"] == "duplicate" and r["count"] == 2
    assert _content(c, "self", "my_persona.md") == REAL
    r = ident.delete_section("self", "my_persona.md", "Tone", conn=c, occurrence=1)
    assert r["ok"] is True
    after = _content(c, "self", "my_persona.md")
    assert "warm" not in after and "## Tone\nblunt" in after and "# My Persona" in after


def test_read_file_returns_the_current_text_and_outline_or_the_real_files():
    c = _conn()
    ident.set_file("self", "my_persona.md", REAL, conn=c)
    r = ident.read_file("self", "my_persona.md", conn=c)
    assert r["ok"] and r["content"] == REAL and r["chars"] == len(REAL) and len(r["outline"]) == 4
    miss = ident.read_file("self", "my_persna.md", conn=c)
    assert miss["ok"] is False and miss["files"] == ["my_persona.md"]


def test_append_says_where_the_text_landed():
    c = _conn()
    ident.set_file("self", "my_wants.md", "# T\n\n## Things I'm curious about\n- moths\n", conn=c)
    r = ident.append_file("self", "my_wants.md", "- tide pools", conn=c)
    assert r["ok"] and r["under"] == "Things I'm curious about" and r["chars"] == len(_content(c, "self", "my_wants.md"))
    r = ident.append_file("self", "my_wants.md", "## New\n- a", conn=c)
    assert r["under"] == "New"
    r = ident.append_file("self", "brand_new.md", "plain", conn=c)
    assert r["created"] is True and r["under"] is None
