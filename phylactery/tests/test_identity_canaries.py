"""Identity canary stamps (0.14.79): the registry the per-turn check reads.

A stamp's whole job is being matched character for character, so registering
one demands it sit in its file exactly once, verbatim (no whitespace-tolerant
matching like the cleanup's passage finder). Retiring one never touches the file.
"""

import pytest

from phylactery import canaries
from phylactery.db import get_conn

STAMP = "[canary v1 — persona: if I can read this line, this file loaded whole]"


@pytest.fixture()
def conn(tmp_path):
    c = get_conn(tmp_path / "phylactery.db")
    with c:
        c.execute(
            "INSERT INTO identity_files(id, category, filename, content, created_at, updated_at) "
            "VALUES ('p','self','my_persona.md',?, '2026-06-01T00:00:00+00:00', '2026-06-01T00:00:00+00:00')",
            (f"I'm blunt.\n{STAMP}\nMore about me.\n",),
        )
    yield c
    c.close()


def test_a_stamp_registers_once_and_reads_back(conn):
    out = canaries.add("self", "my_persona.md", STAMP, label="persona", conn=conn)
    assert out["ok"] is True and out["existed"] is False
    c = out["canary"]
    assert c["id"].startswith("canary-persona") and c["at_end"] is False and c["text"] == STAMP
    again = canaries.add("self", "my_persona.md", f"  {STAMP} ", label="persona", conn=conn)
    assert again["ok"] is True and again["existed"] is True and again["canary"]["id"] == c["id"]
    assert [x["id"] for x in canaries.list_all(conn=conn)] == [c["id"]]


def test_a_stamp_must_be_in_its_file_exactly_once_and_verbatim(conn):
    near = STAMP.replace(" — ", "  —  ")   # whitespace drift is a different stamp
    assert "isn't in" in canaries.add("self", "my_persona.md", near, conn=conn)["error"]
    assert "no identity file" in canaries.add("self", "nope.md", STAMP, conn=conn)["error"]
    with conn:
        conn.execute("UPDATE identity_files SET content = content || ? WHERE id='p'", (STAMP + "\n",))
    assert "in 2 places" in canaries.add("self", "my_persona.md", STAMP, conn=conn)["error"]
    assert canaries.list_all(conn=conn) == []


def test_retiring_a_stamp_leaves_the_file_alone(conn):
    cid = canaries.add("self", "my_persona.md", STAMP, label="persona", at_end=True, conn=conn)["canary"]["id"]
    assert canaries.list_all(conn=conn)[0]["at_end"] is True
    assert canaries.remove(cid, conn=conn) == {"ok": True}
    assert canaries.remove(cid, conn=conn)["ok"] is False
    assert STAMP in conn.execute("SELECT content FROM identity_files WHERE id='p'").fetchone()["content"]
