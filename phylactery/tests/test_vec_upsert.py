"""sqlite-vec (vec0) virtual tables don't honor INSERT OR REPLACE.

Re-embedding an existing memory/node (same primary key) with
"INSERT OR REPLACE" raises "UNIQUE constraint failed on <table> primary key"
instead of replacing — so updated memories silently lost their vector
(the embedding helper catches + logs it). The fix in memory.py / graph.py is
the documented delete-then-insert pattern. These pin that behavior.
"""

import sqlite3
import pytest


def _vec_conn():
    try:
        import sqlite_vec
    except ImportError:
        pytest.skip("sqlite-vec not installed in this environment")
    c = sqlite3.connect(":memory:")
    c.enable_load_extension(True)
    sqlite_vec.load(c)
    c.enable_load_extension(False)
    c.execute(
        "CREATE VIRTUAL TABLE memory_vecs USING vec0(memory_id TEXT PRIMARY KEY, embedding float[3])"
    )
    return c


def test_delete_then_insert_allows_reembedding():
    """The fix: re-embedding the same id succeeds and replaces the vector."""
    c = _vec_conn()
    c.execute("INSERT INTO memory_vecs(memory_id, embedding) VALUES (?, ?)", ("m1", "[1, 0, 0]"))
    # delete-then-insert (what _upsert_embedding now does)
    c.execute("DELETE FROM memory_vecs WHERE memory_id=?", ("m1",))
    c.execute("INSERT INTO memory_vecs(memory_id, embedding) VALUES (?, ?)", ("m1", "[0, 1, 0]"))
    count = c.execute("SELECT COUNT(*) FROM memory_vecs").fetchone()[0]
    assert count == 1  # one row, re-embedded — no UNIQUE error


def test_insert_or_replace_raises_on_duplicate_pk():
    """Documents WHY the fix is needed: the old code path raises."""
    c = _vec_conn()
    c.execute("INSERT INTO memory_vecs(memory_id, embedding) VALUES (?, ?)", ("m1", "[1, 0, 0]"))
    # vec0 surfaces this as OperationalError "UNIQUE constraint failed on
    # memory_vecs primary key" — the exact error seen in production.
    with pytest.raises((sqlite3.OperationalError, sqlite3.IntegrityError), match="UNIQUE constraint failed"):
        c.execute(
            "INSERT OR REPLACE INTO memory_vecs(memory_id, embedding) VALUES (?, ?)",
            ("m1", "[0, 1, 0]"),
        )
