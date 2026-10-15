"""Identity canary stamps (0.14.79) — the registry.

A canary stamp is an exact line I keep in one of my identity files so I can
tell my identity loaded whole. Registering one gives the check a baseline: a
stamp that's gone can only be noticed if something remembers it was there.
Proto-Familiar runs the check every turn (src/memory/identity-canaries.js);
this module only stores what to look for. Nothing here blocks an edit.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from phylactery.db import get_conn, insert_with_slug_retry, now_iso

_COLS = "id, category, filename, text, label, at_end, created_at"


def _row(r) -> dict[str, Any]:
    d = {k: r[k] for k in r.keys()}
    d["at_end"] = bool(d.get("at_end"))
    return d


def add(category: str, filename: str, text: str, label: str | None = None, at_end: bool = False,
        conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    """Register a stamp. It has to sit in the file exactly once, character for
    character — a stamp's whole job is being matched verbatim. Registering the
    same stamp twice returns the existing one."""
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        stamp = (text or "").strip()
        if not stamp:
            return {"ok": False, "error": "the stamp text is empty"}
        f = conn.execute("SELECT content FROM identity_files WHERE category=? AND filename=?",
                         (category, filename)).fetchone()
        if f is None:
            return {"ok": False, "error": f"there's no identity file {category}/{filename}"}
        n = (f["content"] or "").count(stamp)
        if n != 1:
            where = "isn't in" if n == 0 else f"is in {n} places in"
            return {"ok": False, "error": f"that stamp {where} {category}/{filename} word for word; it has to be there exactly once"}
        existing = conn.execute(f"SELECT {_COLS} FROM identity_canaries WHERE category=? AND filename=? AND text=?",
                                (category, filename, stamp)).fetchone()
        if existing is not None:
            return {"ok": True, "canary": _row(existing), "existed": True}
        name = (label or "").strip() or filename.rsplit(".", 1)[0]
        with conn:
            cid = insert_with_slug_retry(
                conn,
                f"INSERT INTO identity_canaries({_COLS}) VALUES (?,?,?,?,?,?,?)",
                lambda i: (i, category, filename, stamp, name[:60], 1 if at_end else 0, now_iso()),
                label=f"canary {name}", kind="canary",
            )
        r = conn.execute(f"SELECT {_COLS} FROM identity_canaries WHERE id=?", (cid,)).fetchone()
        return {"ok": True, "canary": _row(r), "existed": False}
    finally:
        if own_conn:
            conn.close()


def list_all(conn: sqlite3.Connection | None = None) -> list[dict[str, Any]]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        return [_row(r) for r in conn.execute(
            f"SELECT {_COLS} FROM identity_canaries ORDER BY created_at ASC")]
    finally:
        if own_conn:
            conn.close()


def remove(cid: str, conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    """Retire a stamp: the check stops looking for it. The file is untouched."""
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        with conn:
            cur = conn.execute("DELETE FROM identity_canaries WHERE id=?", (cid,))
        if cur.rowcount == 0:
            return {"ok": False, "error": f"no canary stamp {cid!r}"}
        return {"ok": True}
    finally:
        if own_conn:
            conn.close()
