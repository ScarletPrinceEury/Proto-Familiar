"""ids_to_slugs: mechanical re-key of legacy graph ids to readable slugs."""
import sqlite3
import uuid

from phylactery.db import get_conn
from phylactery import graph


def _mem_conn(tmp_path):
    return get_conn(tmp_path / "t.db")


def test_rekeys_nodes_edges_and_embeddings(tmp_path):
    conn = _mem_conn(tmp_path)
    a = uuid.uuid4().hex
    b = uuid.uuid4().hex
    e = uuid.uuid4().hex
    conn.execute("INSERT INTO graph_nodes(id,label,type,description,audience,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                 (a, "Sister Mira", "person", "", "ward-private", "t", "t"))
    conn.execute("INSERT INTO graph_nodes(id,label,type,description,audience,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                 (b, "Berlin", "place", "", "ward-private", "t", "t"))
    conn.execute("INSERT INTO graph_edges(id,from_id,to_id,type,weight,audience,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                 (e, a, b, "lives_in", 1.0, "ward-private", "t", "t"))
    conn.commit()

    r = graph.ids_to_slugs(conn=conn)
    assert r["ok"] and r["nodes"] == 2 and r["edges"] == 1
    new_a = r["mapping"][a]
    assert new_a.startswith("sister-mira-")
    edge = conn.execute("SELECT * FROM graph_edges").fetchone()
    assert edge["from_id"] == new_a and edge["to_id"] == r["mapping"][b]
    assert edge["id"].startswith("lives-in-") or edge["id"].startswith("lives_in-")

    # idempotent
    r2 = graph.ids_to_slugs(conn=conn)
    assert r2["nodes"] == 0 and r2["edges"] == 0
    conn.close()
