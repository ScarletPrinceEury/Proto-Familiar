"""remap_audiences rewrites stored category-id `audience` values (memories +
graph nodes + edges) after the Village category-slug migration. Only rows whose
audience is an OLD id move; 'ward-private' and already-slug rows are untouched;
idempotent."""

import sqlite3
from phylactery import memory


def _conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("CREATE TABLE memories(id TEXT PRIMARY KEY, audience TEXT)")
    c.execute("CREATE TABLE graph_nodes(id TEXT PRIMARY KEY, audience TEXT)")
    c.execute("CREATE TABLE graph_edges(id TEXT PRIMARY KEY, audience TEXT)")
    return c


OLD = "00000000-0000-4000-8001-000000000001"


def _seed(c):
    c.execute("INSERT INTO memories VALUES('m1', ?)", (OLD,))
    c.execute("INSERT INTO memories VALUES('m2', 'ward-private')")
    c.execute("INSERT INTO memories VALUES('m3', 'acquaintances')")   # already a slug
    c.execute("INSERT INTO graph_nodes VALUES('n1', ?)", (OLD,))
    c.execute("INSERT INTO graph_edges VALUES('e1', ?)", (OLD,))
    c.commit()


def test_remap_moves_only_old_ids_across_all_three_tables():
    c = _conn(); _seed(c)
    r = memory.remap_audiences(c, {OLD: "close-friends"})
    assert r == {"ok": True, "memories": 1, "nodes": 1, "edges": 1}
    assert c.execute("SELECT audience FROM memories WHERE id='m1'").fetchone()["audience"] == "close-friends"
    assert c.execute("SELECT audience FROM memories WHERE id='m2'").fetchone()["audience"] == "ward-private"
    assert c.execute("SELECT audience FROM memories WHERE id='m3'").fetchone()["audience"] == "acquaintances"
    assert c.execute("SELECT audience FROM graph_nodes WHERE id='n1'").fetchone()["audience"] == "close-friends"
    assert c.execute("SELECT audience FROM graph_edges WHERE id='e1'").fetchone()["audience"] == "close-friends"


def test_remap_is_idempotent():
    c = _conn(); _seed(c)
    memory.remap_audiences(c, {OLD: "close-friends"})
    r2 = memory.remap_audiences(c, {OLD: "close-friends"})
    assert r2 == {"ok": True, "memories": 0, "nodes": 0, "edges": 0}


def test_remap_noop_on_empty_or_same_value_map():
    c = _conn(); _seed(c)
    assert memory.remap_audiences(c, {}) == {"ok": True, "memories": 0, "nodes": 0, "edges": 0}
    assert memory.remap_audiences(c, None) == {"ok": True, "memories": 0, "nodes": 0, "edges": 0}
    # old == new is skipped (no self-churn).
    assert memory.remap_audiences(c, {OLD: OLD}) == {"ok": True, "memories": 0, "nodes": 0, "edges": 0}
