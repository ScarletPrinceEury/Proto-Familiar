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
