"""list_nodes / get_full_graph honour the recall gate (Pillar E), defence in
depth for the multi-embodiment surface. None = ward sees all (the default, so
every existing ward-only caller is unchanged); a set scopes to the room's
cleared audiences; [] surfaces nothing. Both nodes AND edges are scoped, so a
gated caller can't pull a hidden node in via an edge.
"""

import sqlite3

from phylactery.graph import list_nodes, get_full_graph


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("CREATE TABLE graph_nodes (id TEXT PRIMARY KEY, label TEXT, type TEXT, description TEXT, audience TEXT)")
    c.execute("CREATE TABLE graph_edges (id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT, type TEXT, weight REAL, audience TEXT)")
    return c


def _seed(c):
    c.execute("INSERT INTO graph_nodes VALUES ('mom','Mom','person','','ward-private')")
    c.execute("INSERT INTO graph_nodes VALUES ('chen','Chen','person','','friends')")
    c.execute("INSERT INTO graph_nodes VALUES ('ann','Ann','person','','friends')")
    # A friends-visible edge to a WARD-PRIVATE node (the correlation-leak shape).
    c.execute("INSERT INTO graph_edges VALUES ('e1','chen','mom','knows',1.0,'friends')")
    # A WARD-PRIVATE edge between two friends-visible nodes.
    c.execute("INSERT INTO graph_edges VALUES ('e2','chen','ann','secret',1.0,'ward-private')")


def test_list_nodes_default_sees_all():
    c = _conn(); _seed(c)
    assert {n["id"] for n in list_nodes(conn=c)["nodes"]} == {"mom", "chen", "ann"}


def test_list_nodes_scoped_hides_ward_private():
    c = _conn(); _seed(c)
    assert {n["id"] for n in list_nodes(audiences=["friends"], conn=c)["nodes"]} == {"chen", "ann"}


def test_list_nodes_empty_audience_hides_everything():
    c = _conn(); _seed(c)
    assert list_nodes(audiences=[], conn=c)["nodes"] == []


def test_full_graph_default_sees_all():
    c = _conn(); _seed(c)
    g = get_full_graph(conn=c)
    assert {n["id"] for n in g["nodes"]} == {"mom", "chen", "ann"}
    assert {e["id"] for e in g["edges"]} == {"e1", "e2"}


def test_full_graph_scoped_hides_node_and_both_edge_leaks():
    c = _conn(); _seed(c)
    g = get_full_graph(audiences=["friends"], conn=c)
    # Ward-private Mom is gone.
    assert {n["id"] for n in g["nodes"]} == {"chen", "ann"}
    # e1 (chen→Mom) is dropped because its endpoint is hidden; e2 (chen→ann) is
    # dropped because the EDGE itself is ward-private — both leak paths closed.
    assert g["edges"] == []
