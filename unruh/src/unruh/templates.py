"""Requirement templates (stewardship Pass 2b).

A template bundles the prerequisites for a KIND of undertaking that carries a
barrier for my human — "leaving the house" (tag: outside) needs clean clothes,
shoes by the door. It is keyed by the obstacle tag it matches, so when I put
that tag on an event I can pull the bundle in as SUGGESTED prerequisites and
prune what doesn't apply this time. The template proposes; the instance decides.

Storage only. Applying a template — resolve-or-create the prerequisite tasks
and link `requires` edges — is orchestrated in the JS motor layer from these
records plus the existing schedule wrappers. That keeps templates out of the
schedule window entirely (they are not schedule nodes).
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from .db import insert_with_slug_retry, now_iso


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id":            row["id"],
        "tag":           row["tag"],
        "label":         row["label"],
        "prerequisites": json.loads(row["prerequisites_json"] or "[]"),
        "created_at":    row["created_at"],
        "updated_at":    row["updated_at"],
    }


def _clean_prereqs(prerequisites: Any) -> list[str]:
    """Trim, de-dupe (case-insensitive), cap at 20. A prerequisite is a short
    task label, not free text."""
    out: list[str] = []
    seen: set[str] = set()
    for p in (prerequisites or []):
        s = str(p or "").strip()
        key = s.lower()
        if not s or key in seen:
            continue
        seen.add(key)
        out.append(s)
        if len(out) >= 20:
            break
    return out


def upsert_template(conn, *, tag: str, label: str, prerequisites: Any = None) -> dict[str, Any]:
    """Create or replace the template for `tag` (one template per barrier).
    Editing an existing template keeps its id stable. Returns the record."""
    t = str(tag or "").strip().lower()
    if not t:
        raise ValueError("tag is required and must be non-empty")
    lbl = str(label or "").strip()
    if not lbl:
        raise ValueError("label is required and must be non-empty")
    prereqs = _clean_prereqs(prerequisites)
    ts = now_iso()
    existing = conn.execute("SELECT id FROM templates WHERE tag = ?", (t,)).fetchone()
    if existing:
        conn.execute(
            "UPDATE templates SET label = ?, prerequisites_json = ?, updated_at = ? WHERE tag = ?",
            (lbl, json.dumps(prereqs), ts, t),
        )
        tid = existing["id"]
    else:
        tid = insert_with_slug_retry(
            conn,
            """INSERT INTO templates (id, tag, label, prerequisites_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            lambda nid: (nid, t, lbl, json.dumps(prereqs), ts, ts),
            label=lbl, kind="template",
        )
    row = conn.execute("SELECT * FROM templates WHERE id = ?", (tid,)).fetchone()
    return _row_to_dict(row)


def list_templates(conn) -> list[dict[str, Any]]:
    """Every template, tag order."""
    rows = conn.execute("SELECT * FROM templates ORDER BY tag ASC").fetchall()
    return [_row_to_dict(r) for r in rows]


def delete_template(conn, *, tag: str) -> bool:
    """Remove the template for `tag`. Returns True if one existed."""
    t = str(tag or "").strip().lower()
    if not t:
        raise ValueError("tag is required and must be non-empty")
    cur = conn.execute("DELETE FROM templates WHERE tag = ?", (t,))
    return cur.rowcount > 0
