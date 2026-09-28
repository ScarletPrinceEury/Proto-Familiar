"""run_graduation_audit must not trim the identity file when a memory_create
FAILS — that would delete the only copy of a fact that was never stored
("graduated facts aren't deleted"). The candidate is left fully intact
(content AND last_graduated_at) so the next pass retries it.
"""

import json
import sqlite3
from datetime import datetime, timedelta, timezone

import phylactery.memory as pmem
from phylactery import graduation as grad

NOW = datetime(2026, 6, 15, tzinfo=timezone.utc)

# One graduatable item + the trimmed remainder the Familiar would return.
_LLM = json.dumps({
    "graduate": [{"summary": "likes teal", "content": "my human likes the colour teal"}],
    "kept_content": "(everything else, teal removed)",
})


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("CREATE TABLE identity_files (id TEXT PRIMARY KEY, category TEXT, filename TEXT, "
              "content TEXT, care_weight TEXT, updated_at TEXT, last_graduated_at TEXT)")
    c.execute("CREATE TABLE memories (id TEXT PRIMARY KEY, register TEXT)")
    c.execute("CREATE TABLE graduation_log (id TEXT PRIMARY KEY, source_category TEXT, "
              "source_filename TEXT, memory_id TEXT, register TEXT, summary TEXT, "
              "acknowledged INTEGER, created_at TEXT)")
    return c


def _seed_candidate(c):
    # Old (120d) + never re-confirmed → eligible; safe, non-care-critical content.
    old = (NOW - timedelta(days=120)).isoformat()
    c.execute(
        "INSERT INTO identity_files VALUES ('f1','ward','notes.md',"
        "'my human likes the colour teal', NULL, ?, NULL)",
        (old,),
    )


def test_failed_create_leaves_identity_intact(monkeypatch):
    c = _conn(); _seed_candidate(c)
    monkeypatch.setattr(pmem, "create", lambda *a, **k: {"ok": False, "error": "boom"})

    res = grad.run_graduation_audit(c, {}, lambda cfg, prompt: _LLM, now=NOW)

    assert res["graduated"] == 0, "a failed store must not count as graduated"
    row = c.execute("SELECT content, last_graduated_at FROM identity_files WHERE id='f1'").fetchone()
    assert row["content"] == "my human likes the colour teal", "content must NOT be trimmed"
    assert row["last_graduated_at"] is None, "left untouched so the next pass retries"
    assert c.execute("SELECT COUNT(*) AS n FROM graduation_log").fetchone()["n"] == 0, \
        "no graduation_log row for an item that never stored"


def test_successful_create_trims_identity(monkeypatch):
    # The paired happy path: when the store succeeds, the trim DOES happen —
    # proving the withhold above is specific to failure, not a blanket freeze.
    c = _conn(); _seed_candidate(c)
    monkeypatch.setattr(pmem, "create", lambda *a, **k: {"ok": True, "id": "mem-x"})

    res = grad.run_graduation_audit(c, {}, lambda cfg, prompt: _LLM, now=NOW)

    assert res["graduated"] == 1
    row = c.execute("SELECT content, last_graduated_at FROM identity_files WHERE id='f1'").fetchone()
    assert row["content"] == "(everything else, teal removed)", "trimmed to kept_content"
    assert row["last_graduated_at"] is not None
    assert c.execute("SELECT COUNT(*) AS n FROM graduation_log").fetchone()["n"] == 1
