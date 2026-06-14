"""
Migration: entity-core data directory → Phylactery SQLite.

Reads entity-core's markdown files + graph.db and writes them into
the running Phylactery instance's SQLite. Idempotent: records whose
source_json contains originalId already present are skipped.

Usage:
    uv run --project phylactery python -m phylactery.migrate_from_entity_core \
        --source /path/to/entity-core/data [--dry-run]

Phases:
  0  Snapshot Phylactery (recovery baseline).
  1a Identity markdown files → identity_files (user→ward rename).
  1b Memory markdown files   → memories (date-key preserved).
  1c graph.db                → graph_nodes + graph_edges.
  4  All records get audience='ward-private' (default backfill floor).
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

from phylactery.db import get_conn, new_id, now_iso
from phylactery.snapshot import auto_snapshot

# ── Helpers ───────────────────────────────────────────────────────────────────

def _source_json(author: str, original_id: str) -> str:
    return json.dumps({
        "author": author,
        "via": "migration",
        "at": now_iso(),
        "originalId": original_id,
    })


def _already_migrated(conn: sqlite3.Connection, table: str, original_id: str) -> bool:
    """Return True if a row with this originalId is already in the table."""
    rows = conn.execute(
        f"SELECT 1 FROM {table} WHERE json_extract(source_json, '$.originalId') = ? LIMIT 1",
        (original_id,),
    ).fetchone()
    return rows is not None


# ── Phase 1a: Identity files ──────────────────────────────────────────────────

def migrate_identity(
    conn: sqlite3.Connection,
    source_data_dir: Path,
    dry_run: bool,
) -> tuple[int, int]:
    """Walk identity subdirs and insert into identity_files. Returns (imported, skipped)."""
    imported = 0
    skipped = 0

    # Map: subdirectory name → Phylactery category
    # entity-core's 'user/' directory becomes 'ward' category (Pillar F rename).
    dir_to_category = {
        "self":         "self",
        "user":         "ward",
        "relationship": "relationship",
        "custom":       "custom",
    }

    for dir_name, category in dir_to_category.items():
        subdir = source_data_dir / dir_name
        if not subdir.exists():
            continue
        for md_file in sorted(subdir.glob("*.md")):
            filename = md_file.name
            original_id = f"ec-identity:{dir_name}/{filename}"
            if _already_migrated(conn, "identity_files", original_id):
                skipped += 1
                continue
            content = md_file.read_text(encoding="utf-8", errors="replace")
            src = _source_json("migration:entity-core", original_id)
            now = now_iso()
            if not dry_run:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO identity_files
                        (id, category, filename, content, sort_order, audience,
                         source_json, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 999, 'ward-private', ?, ?, ?)
                    """,
                    (new_id(), category, filename, content, src, now, now),
                )
                conn.commit()
            imported += 1

    return imported, skipped


# ── Phase 1b: Memory files ────────────────────────────────────────────────────

def migrate_memories(
    conn: sqlite3.Connection,
    source_data_dir: Path,
    dry_run: bool,
) -> tuple[int, int]:
    """Walk memories subdirs and insert into memories. Returns (imported, skipped)."""
    imported = 0
    skipped = 0

    memories_dir = source_data_dir / "memories"
    if not memories_dir.exists():
        return 0, 0

    tiers = ["daily", "weekly", "monthly", "yearly", "significant"]

    for tier in tiers:
        tier_dir = memories_dir / tier
        if not tier_dir.exists():
            continue
        for md_file in sorted(tier_dir.glob("*.md")):
            stem = md_file.stem  # filename without .md
            original_id = f"ec-memory:{tier}/{stem}"
            if _already_migrated(conn, "memories", original_id):
                skipped += 1
                continue

            content = md_file.read_text(encoding="utf-8", errors="replace")
            src = _source_json("migration:entity-core", original_id)
            now = now_iso()

            # date_key is the full stem for all tiers.
            # For significant: stem is YYYY-MM-DD_slug — stored as-is.
            date_key = stem

            if not dry_run:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO memories
                        (id, granularity, date_key, kind, register, content,
                         audience, source_json, created_at, updated_at)
                    VALUES (?, ?, ?, 'narrative', 'episodic', ?,
                            'ward-private', ?, ?, ?)
                    """,
                    (new_id(), tier, date_key, content, src, now, now),
                )
                conn.commit()
            imported += 1

    return imported, skipped


# ── Phase 1c: Graph ────────────────────────────────────────────────────────────

def _probe_table_names(graph_conn: sqlite3.Connection) -> tuple[str | None, str | None]:
    """Probe for node/edge table names: try 'nodes'/'edges' first, then 'node'/'edge'."""
    tables = {
        r[0]
        for r in graph_conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    nodes_tbl = "nodes" if "nodes" in tables else ("node" if "node" in tables else None)
    edges_tbl = "edges" if "edges" in tables else ("edge" if "edge" in tables else None)
    return nodes_tbl, edges_tbl


def _columns(graph_conn: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in graph_conn.execute(f"PRAGMA table_info({table})").fetchall()}


def migrate_graph(
    conn: sqlite3.Connection,
    source_data_dir: Path,
    dry_run: bool,
) -> tuple[int, int, int, int]:
    """Read graph.db and insert nodes+edges. Returns (nodes_imported, nodes_skipped, edges_imported, edges_skipped)."""
    graph_db = source_data_dir / "graph.db"
    if not graph_db.exists():
        return 0, 0, 0, 0

    try:
        gconn = sqlite3.connect(str(graph_db))
        gconn.row_factory = sqlite3.Row
    except Exception as e:
        print(f"[migrate] Warning: could not open graph.db: {e}", file=sys.stderr)
        return 0, 0, 0, 0

    try:
        nodes_tbl, edges_tbl = _probe_table_names(gconn)

        nodes_imported = nodes_skipped = 0
        edges_imported = edges_skipped = 0

        # ── Nodes ────────────────────────────────────────────────────────────
        if nodes_tbl:
            cols = _columns(gconn, nodes_tbl)
            label_col       = "label"       if "label"       in cols else None
            type_col        = "type"        if "type"        in cols else None
            description_col = "description" if "description" in cols else None

            try:
                for row in gconn.execute(f"SELECT * FROM {nodes_tbl}").fetchall():
                    node_id = row["id"] if "id" in cols else None
                    if node_id is None:
                        continue
                    original_id = f"ec-node:{node_id}"
                    if _already_migrated(conn, "graph_nodes", original_id):
                        nodes_skipped += 1
                        continue

                    label       = row[label_col]       if label_col       else None
                    node_type   = row[type_col]         if type_col        else None
                    description = row[description_col]  if description_col else None
                    src = _source_json("migration:entity-core", original_id)
                    now = now_iso()

                    if not dry_run:
                        # label is NOT NULL in graph_nodes — fall back to id string.
                        safe_label = label if label is not None else str(node_id)
                        conn.execute(
                            """
                            INSERT OR IGNORE INTO graph_nodes
                                (id, label, type, description, audience, source_json,
                                 created_at, updated_at)
                            VALUES (?, ?, ?, ?, 'ward-private', ?, ?, ?)
                            """,
                            (new_id(), safe_label, node_type, description, src, now, now),
                        )
                        conn.commit()
                    nodes_imported += 1
            except Exception as e:
                print(f"[migrate] Warning: error reading nodes from graph.db: {e}", file=sys.stderr)

        # ── Edges ────────────────────────────────────────────────────────────
        if edges_tbl:
            cols = _columns(gconn, edges_tbl)
            # Try both column name conventions
            from_col   = "fromId"  if "fromId"  in cols else ("from_id" if "from_id" in cols else None)
            to_col     = "toId"    if "toId"    in cols else ("to_id"   if "to_id"   in cols else None)
            type_col   = "type"    if "type"    in cols else None
            weight_col = "weight"  if "weight"  in cols else None

            try:
                for row in gconn.execute(f"SELECT * FROM {edges_tbl}").fetchall():
                    edge_id = row["id"] if "id" in cols else None
                    if edge_id is None:
                        continue
                    original_id = f"ec-edge:{edge_id}"
                    if _already_migrated(conn, "graph_edges", original_id):
                        edges_skipped += 1
                        continue

                    from_id    = row[from_col]   if from_col   else None
                    to_id      = row[to_col]      if to_col     else None
                    edge_type  = row[type_col]    if type_col   else None
                    weight     = row[weight_col]  if weight_col else None
                    src = _source_json("migration:entity-core", original_id)
                    now = now_iso()

                    if not dry_run:
                        # type is NOT NULL in graph_edges — use 'unknown' if missing.
                        safe_type = edge_type if edge_type is not None else "unknown"
                        conn.execute(
                            """
                            INSERT OR IGNORE INTO graph_edges
                                (id, from_id, to_id, type, weight, audience,
                                 source_json, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, 'ward-private', ?, ?, ?)
                            """,
                            (new_id(), from_id, to_id, safe_type, weight, src, now, now),
                        )
                        conn.commit()
                    edges_imported += 1
            except Exception as e:
                print(f"[migrate] Warning: error reading edges from graph.db: {e}", file=sys.stderr)

    except Exception as e:
        print(f"[migrate] Warning: graph.db schema unrecognised, skipping: {e}", file=sys.stderr)
        return 0, 0, 0, 0
    finally:
        gconn.close()

    return nodes_imported, nodes_skipped, edges_imported, edges_skipped


# ── Graph reconciliation report (Phase 2) ─────────────────────────────────────

def print_person_nodes(conn: sqlite3.Connection) -> None:
    """Print person-type nodes for manual villager-match review."""
    try:
        rows = conn.execute(
            "SELECT id, label, description FROM graph_nodes WHERE type = 'person' ORDER BY label"
        ).fetchall()
        if not rows:
            print("\nPerson nodes (review for villager matches): (none)")
            return
        print("\nPerson nodes (review for villager matches):")
        for r in rows:
            desc = f" — {r['description']}" if r["description"] else ""
            print(f"  {r['label']}{desc}")
    except Exception as e:
        print(f"[migrate] Warning: could not query person nodes: {e}", file=sys.stderr)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Migrate entity-core data directory into Phylactery SQLite."
    )
    parser.add_argument(
        "--source",
        required=True,
        help="Path to the entity-core data directory (the one containing self/, memories/, etc.)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Walk files and count what would be imported without writing anything.",
    )
    args = parser.parse_args()

    source_dir = Path(args.source).resolve()
    if not source_dir.exists():
        print(f"Error: source directory does not exist: {source_dir}", file=sys.stderr)
        sys.exit(1)

    dry_prefix = "[DRY RUN] " if args.dry_run else ""
    print(f"{dry_prefix}Migrating entity-core data from: {source_dir}")

    # Phase 0: open Phylactery connection (runs migrations) + snapshot.
    conn = get_conn()
    if not args.dry_run:
        print("Phase 0: snapshotting Phylactery before any writes…")
        auto_snapshot(conn)
        print("  Snapshot created.")
    else:
        print("Phase 0: [DRY RUN] skipping snapshot.")

    # Phase 1a: identity files.
    print("Phase 1a: importing identity files…")
    id_imported, id_skipped = migrate_identity(conn, source_dir, args.dry_run)

    # Phase 1b: memory files.
    print("Phase 1b: importing memory files…")
    mem_imported, mem_skipped = migrate_memories(conn, source_dir, args.dry_run)

    # Phase 1c: graph.
    print("Phase 1c: importing graph nodes and edges…")
    nodes_imported, nodes_skipped, edges_imported, edges_skipped = migrate_graph(
        conn, source_dir, args.dry_run
    )

    conn.close()

    # Summary.
    print(
        f"\n{dry_prefix}Migration complete.\n"
        f"  Identity : {id_imported} imported, {id_skipped} skipped.\n"
        f"  Memories : {mem_imported} imported, {mem_skipped} skipped.\n"
        f"  Graph    : {nodes_imported} nodes, {edges_imported} edges imported "
        f"({nodes_skipped} nodes, {edges_skipped} edges skipped)."
    )

    # Phase 2: person-node reconciliation report (manual, not auto-merge).
    if not args.dry_run and (nodes_imported + nodes_skipped) > 0:
        conn2 = get_conn()
        print_person_nodes(conn2)
        conn2.close()


if __name__ == "__main__":
    main()
