"""get_subgraph must return a label for every edge endpoint.

With depth=1 the BFS expands from the seed node and collects its edges, but
the neighbour nodes only appear *inside* those edges — their node rows
(labels/types/descriptions) were never fetched, so callers (the prompt graph
block in thalamus.js) fell back to rendering raw ids inline ("Chen has_cat
<uuid>"). The backfill in get_subgraph loads the stragglers. These pin it.
"""

import sqlite3

from phylactery.graph import get_subgraph


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("CREATE TABLE graph_nodes (id TEXT PRIMARY KEY, label TEXT, type TEXT, description TEXT)")
    c.execute("CREATE TABLE graph_edges (id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT, type TEXT, weight REAL)")
    return c


def test_subgraph_returns_neighbour_labels():
    c = _conn()
    c.execute("INSERT INTO graph_nodes VALUES ('chen', 'Chen', 'person', 'my ward')")
    c.execute("INSERT INTO graph_nodes VALUES ('mochi', 'Mochi', 'pet', 'a cat')")
    c.execute("INSERT INTO graph_nodes VALUES ('berlin', 'Berlin', 'place', '')")
    c.execute("INSERT INTO graph_edges VALUES ('e1', 'chen', 'mochi', 'has_cat', 1.0)")
    c.execute("INSERT INTO graph_edges VALUES ('e2', 'chen', 'berlin', 'lives_in', 1.0)")

    sg = get_subgraph("chen", depth=1, conn=c)
    labels = {n["id"]: n["label"] for n in sg["nodes"]}

    # The seed AND both 1-hop neighbours come back labelled (the fix).
    assert labels.get("chen") == "Chen"
    assert labels.get("mochi") == "Mochi"
    assert labels.get("berlin") == "Berlin"

    # Every edge endpoint resolves to a label — no node can leak as a bare id.
    endpoints = {e["fromId"] for e in sg["edges"]} | {e["toId"] for e in sg["edges"]}
    assert endpoints <= set(labels)


def test_subgraph_seed_with_no_edges():
    c = _conn()
    c.execute("INSERT INTO graph_nodes VALUES ('solo', 'Solo', 'person', '')")
    sg = get_subgraph("solo", depth=1, conn=c)
    assert [n["label"] for n in sg["nodes"]] == ["Solo"]
    assert sg["edges"] == []
