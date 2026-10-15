"""Propose-only cleanup (0.14.78) can't lose a fact.

The graduation pass only writes proposals; it never touches identity or memory.
Applying a proposal saves the standing fact FIRST and cuts the passage only
after the fact is stored, so a failed save leaves the file whole and the
proposal open to try again ("graduated facts aren't deleted").
"""

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

import phylactery.memory as pmem
from phylactery import graduation as grad
from phylactery.db import get_conn

NOW = datetime(2026, 6, 15, tzinfo=timezone.utc)
CONTENT = "My human is Sam.\nMy human likes the colour teal.\n"
_LLM = json.dumps({"proposals": [{
    "passage": "My human likes the colour teal.",
    "summary": "likes teal", "fact": "My human likes the colour teal.", "why": "only matters when colours come up",
}]})


@pytest.fixture()
def c(tmp_path):
    conn = get_conn(tmp_path / "phylactery.db")
    with patch.object(pmem, "_upsert_embedding", lambda *a, **k: None), \
         patch.object(pmem, "_find_duplicate", lambda *a, **k: None):
        old = (NOW - timedelta(days=120)).isoformat()   # past the 30-day dwell → eligible
        with conn:
            conn.execute("INSERT INTO identity_files(id, category, filename, content, created_at, updated_at) "
                         "VALUES ('f1','ward','user_notes.md',?,?,?)", (CONTENT, old, old))
        yield conn
    conn.close()


def _content(c):
    return c.execute("SELECT content FROM identity_files WHERE id='f1'").fetchone()["content"]


def test_the_pass_only_proposes_and_changes_nothing(c):
    res = grad.run_graduation_audit(c, {}, lambda cfg, prompt: _LLM, now=NOW)
    assert res["proposed"] == 1 and res["graduated"] == 0
    assert _content(c) == CONTENT, "the file is untouched"
    assert c.execute("SELECT COUNT(*) AS n FROM memories").fetchone()["n"] == 0, "no memory written"
    [p] = grad.list_cleanup_proposals(conn=c)
    assert p["passage"] == "My human likes the colour teal." and p["status"] == "open"


def test_a_failed_fact_save_cuts_nothing_and_leaves_the_proposal_open(c, monkeypatch):
    grad.run_graduation_audit(c, {}, lambda cfg, prompt: _LLM, now=NOW)
    [p] = grad.list_cleanup_proposals(conn=c)
    monkeypatch.setattr(pmem, "create", lambda *a, **k: {"ok": False, "error": "boom"})
    out = grad.apply_cleanup_proposal(p["id"], conn=c)
    assert out["ok"] is False and "nothing was cut" in out["error"]
    assert _content(c) == CONTENT
    assert grad.list_cleanup_proposals(conn=c)[0]["status"] == "open", "can be tried again"


def test_applying_saves_the_fact_then_cuts_exactly_that_passage(c):
    grad.run_graduation_audit(c, {}, lambda cfg, prompt: _LLM, now=NOW)
    [p] = grad.list_cleanup_proposals(conn=c)
    out = grad.apply_cleanup_proposal(p["id"], conn=c)
    assert out["ok"] is True and out["memory_id"]
    assert _content(c) == "My human is Sam.\n"
    assert c.execute("SELECT register FROM memories WHERE id=?", (out["memory_id"],)).fetchone()["register"] == "ward"
    assert grad.list_cleanup_proposals(status="applied", conn=c)[0]["id"] == p["id"]
