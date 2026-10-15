"""Identity layer — always-injected (not vector-retrieved).

Files are stored as rows in identity_files, returned wholesale by
identity_get_all() in the same JSON shape entity-core used so
thalamus.js needs no changes until Pillar B.

The canonical ordering mirrors entity-core's context.ts ordering,
preserved here so the prompt assembly in thalamus.js stays unchanged.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any

from phylactery.db import get_conn, new_id, now_iso
from phylactery.snapshot import auto_snapshot

# Canonical file orderings (mirrors entity-core's context.ts + CLAUDE.md).
# 'user' was renamed to 'ward' at Pillar F — rename complete.
SELF_ORDER = [
    "base_instructions.md",
    "my_identity.md", "my_persona.md", "my_personhood.md",
    "my_wants.md", "my_mechanics.md",
]
WARD_ORDER = [
    "user_identity.md", "user_life.md", "user_beliefs.md",
    "user_preferences.md", "user_patterns.md", "user_notes.md",
]
RELATIONSHIP_ORDER = [
    "relationship_dynamics.md", "relationship_history.md", "relationship_notes.md",
]

_ORDER_MAP: dict[str, list[str]] = {
    "self": SELF_ORDER,
    "ward": WARD_ORDER,
    "relationship": RELATIONSHIP_ORDER,
}

VALID_CATEGORIES = {"self", "ward", "relationship", "custom"}


def _sort_key(filename: str, order: list[str]) -> tuple[int, str]:
    try:
        return (order.index(filename), filename)
    except ValueError:
        return (len(order), filename)


def _derive_prompt_label(filename: str) -> str:
    return re.sub(r"\.md$", "", filename).replace("-", "_").replace(" ", "_")


def get_all(conn: sqlite3.Connection | None = None, audience: str = "ward-private") -> dict[str, Any]:
    """Return all identity files bucketed by category:
      { self: [...], ward: [...], relationship: [...], custom: [...] }
    each a list of {filename, content, promptLabel}.
    """
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT category, filename, content, prompt_label FROM identity_files ORDER BY sort_order, filename"
        ).fetchall()

        buckets: dict[str, list[dict]] = {"self": [], "ward": [], "relationship": [], "custom": []}
        for r in rows:
            cat = r["category"]
            if cat not in buckets:
                buckets[cat] = []
            buckets[cat].append({
                "filename": r["filename"],
                "content": r["content"] or "",
                "promptLabel": r["prompt_label"] or _derive_prompt_label(r["filename"]),
            })

        # Enforce canonical ordering within each category.
        for cat, order in _ORDER_MAP.items():
            buckets[cat].sort(key=lambda f: _sort_key(f["filename"], order))

        return buckets
    finally:
        if own_conn:
            conn.close()


def append_file(
    category: str,
    filename: str,
    content: str,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    if category not in VALID_CATEGORIES:
        return {"ok": False, "error": f"invalid category: {category!r}"}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        now = now_iso()
        row = conn.execute(
            "SELECT id, content FROM identity_files WHERE category=? AND filename=?",
            (category, filename),
        ).fetchone()
        if row:
            new_content = (row["content"] or "") + "\n" + content
            with conn:
                conn.execute(
                    "UPDATE identity_files SET content=?, updated_at=? WHERE id=?",
                    (new_content, now, row["id"]),
                )
        else:
            order = _ORDER_MAP.get(category, [])
            sort_order = _sort_key(filename, order)[0]
            with conn:
                conn.execute(
                    "INSERT INTO identity_files(id,category,filename,content,prompt_label,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                    (new_id(), category, filename, content, _derive_prompt_label(filename), sort_order, now, now),
                )
        return {"ok": True}
    finally:
        if own_conn:
            conn.close()


def section_headings(content: str) -> list[str]:
    """The markdown headings in a file, in order, without their #s."""
    return [m.group(1).strip() for m in re.finditer(r"^#+\s+(.+?)\s*$", content or "", re.MULTILINE)]


def _rewrite_section(content: str, section: str, new_body: str, create_if_missing: bool = True) -> tuple[str, bool]:
    """Replace the body of a markdown section heading. Returns (new_content,
    replaced?). With no such heading, the section is appended at the end, or,
    when create_if_missing is False, the content comes back unchanged."""
    pattern = re.compile(
        r"(^#+\s+" + re.escape(section) + r"\s*$)(.*?)(?=^#+|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    body = new_body.strip()
    # A function replacement, so a backslash in the new body is text, not a group reference.
    result, n = pattern.subn(lambda m: f"{m.group(1)}\n{body}\n\n", content)
    if n == 0:
        if not create_if_missing:
            return content, False
        result = content.rstrip() + f"\n\n## {section}\n\n{body}\n"
    return result, n > 0


def _find_passage(content: str, passage: str) -> list[tuple[int, int]]:
    """Every place a quoted passage sits in the content: exact first, then with
    any run of whitespace matching any other (a quote copied out of the prompt
    can differ in line breaks or spacing, never in its words)."""
    spans, start = [], content.find(passage)
    while start != -1:
        spans.append((start, start + len(passage)))
        start = content.find(passage, start + len(passage))
    if spans:
        return spans
    words = passage.split()
    if not words:
        return []
    pattern = re.compile(r"\s+".join(re.escape(w) for w in words))
    return [m.span() for m in pattern.finditer(content)]


def _tidy(content: str) -> str:
    """Drop the blank-line gaps a cut leaves behind."""
    content = re.sub(r"[ \t]+\n", "\n", content)
    content = re.sub(r"\n{3,}", "\n\n", content).strip()
    return content + "\n" if content else ""


def _delete_section(content: str, section: str) -> tuple[str, bool]:
    """Remove a markdown section (its heading + body, up to the next heading or
    EOF). Returns (new_content, removed?). Collapses the blank-line gap the cut
    leaves behind so the file stays tidy."""
    pattern = re.compile(
        r"^#+\s+" + re.escape(section) + r"\s*$.*?(?=^#+|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    new, n = pattern.subn("", content)
    if n == 0:
        return content, False
    new = re.sub(r"\n{3,}", "\n\n", new).strip()
    return (new + "\n" if new else ""), True


def rewrite_section(
    category: str,
    filename: str,
    section: str,
    new_body: str,
    conn: sqlite3.Connection | None = None,
    create_if_missing: bool = True,
) -> dict[str, Any]:
    """Replace one section's body. Returns {ok, replaced}. With no such heading
    (or no such file) the section is created, unless create_if_missing is False:
    then nothing changes and the result is {ok:false, error, sections} naming the
    headings the file does have, so a misnamed section never quietly grows the
    file while the caller believes it rewrote one."""
    if category not in VALID_CATEGORIES:
        return {"ok": False, "error": f"invalid category: {category!r}"}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        now = now_iso()
        row = conn.execute(
            "SELECT id, content FROM identity_files WHERE category=? AND filename=?",
            (category, filename),
        ).fetchone()
        if row:
            old = row["content"] or ""
            new_content, replaced = _rewrite_section(old, section, new_body, create_if_missing)
            if not replaced and not create_if_missing:
                return {"ok": False, "error": f"no section headed {section!r} in {category}/{filename}",
                        "sections": section_headings(old)}
            auto_snapshot(conn)
            with conn:
                conn.execute(
                    "UPDATE identity_files SET content=?, updated_at=? WHERE id=?",
                    (new_content, now, row["id"]),
                )
            return {"ok": True, "replaced": replaced}
        if not create_if_missing:
            return {"ok": False, "error": f"no such identity file: {category}/{filename}", "sections": []}
        auto_snapshot(conn)
        order = _ORDER_MAP.get(category, [])
        sort_order = _sort_key(filename, order)[0]
        new_content = f"## {section}\n\n{new_body.strip()}\n"
        with conn:
            conn.execute(
                "INSERT INTO identity_files(id,category,filename,content,prompt_label,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (new_id(), category, filename, new_content, _derive_prompt_label(filename), sort_order, now, now),
            )
        return {"ok": True, "replaced": False}
    finally:
        if own_conn:
            conn.close()


def remove_text(
    category: str,
    filename: str,
    passage: str,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    """Cut one quoted passage out of an identity file (auto-snapshots first) —
    how a line that moved to a standing fact leaves identity, in any file,
    headings or not. The passage must sit in exactly one place: missing or
    repeated is {ok:false, error} and nothing changes, never a guess. Returns
    {ok, removed_chars, chars} (chars = the file's new size)."""
    if category not in VALID_CATEGORIES:
        return {"ok": False, "error": f"invalid category: {category!r}"}
    needle = (passage or "").strip()
    if not needle:
        return {"ok": False, "error": "the passage to remove is empty"}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        row = conn.execute(
            "SELECT id, content FROM identity_files WHERE category=? AND filename=?",
            (category, filename),
        ).fetchone()
        if row is None:
            return {"ok": False, "error": f"no such identity file: {category}/{filename}"}
        content = row["content"] or ""
        spans = _find_passage(content, needle)
        if not spans:
            return {"ok": False, "error": f"that passage isn't in {category}/{filename}; it has to be quoted as the file has it"}
        if len(spans) > 1:
            return {"ok": False, "error": f"that passage is in {category}/{filename} {len(spans)} times; quote more around it so it's one place"}
        start, end = spans[0]
        removed = end - start
        # Whole lines take their line break with them, so a cut bullet leaves no gap.
        if (start == 0 or content[start - 1] == "\n") and content[end:end + 1] == "\n":
            end += 1
        new_content = _tidy(content[:start] + content[end:])
        auto_snapshot(conn)
        with conn:
            conn.execute(
                "UPDATE identity_files SET content=?, updated_at=? WHERE id=?",
                (new_content, now_iso(), row["id"]),
            )
        return {"ok": True, "removed_chars": removed, "chars": len(new_content)}
    finally:
        if own_conn:
            conn.close()


def set_file(
    category: str,
    filename: str,
    content: str,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    """Overwrite a whole identity file's markdown (auto-snapshots first), creating
    it if it doesn't exist. This is the general editor: it can edit heading-less /
    top-of-file content that `rewrite_section` can't target, and remove sections by
    leaving them out. Returns {ok} or {ok:false, error}."""
    if category not in VALID_CATEGORIES:
        return {"ok": False, "error": f"invalid category: {category!r}"}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        auto_snapshot(conn)
        now = now_iso()
        row = conn.execute(
            "SELECT id FROM identity_files WHERE category=? AND filename=?",
            (category, filename),
        ).fetchone()
        with conn:
            if row:
                conn.execute(
                    "UPDATE identity_files SET content=?, updated_at=? WHERE id=?",
                    (content, now, row["id"]),
                )
            else:
                order = _ORDER_MAP.get(category, [])
                sort_order = _sort_key(filename, order)[0]
                conn.execute(
                    "INSERT INTO identity_files(id,category,filename,content,prompt_label,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                    (new_id(), category, filename, content, _derive_prompt_label(filename), sort_order, now, now),
                )
        return {"ok": True}
    finally:
        if own_conn:
            conn.close()


def delete_section(
    category: str,
    filename: str,
    section: str,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    """Remove one markdown section (heading + body) from an identity file
    (auto-snapshots first). Returns {ok} on success, {ok:false, error} if the file
    or the section isn't found — never silently no-ops."""
    if category not in VALID_CATEGORIES:
        return {"ok": False, "error": f"invalid category: {category!r}"}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        row = conn.execute(
            "SELECT id, content FROM identity_files WHERE category=? AND filename=?",
            (category, filename),
        ).fetchone()
        if row is None:
            return {"ok": False, "error": f"no such identity file: {category}/{filename}"}
        new_content, removed = _delete_section(row["content"] or "", section)
        if not removed:
            return {"ok": False, "error": f"section not found: {section!r}"}
        auto_snapshot(conn)
        with conn:
            conn.execute(
                "UPDATE identity_files SET content=?, updated_at=? WHERE id=?",
                (new_content, now_iso(), row["id"]),
            )
        return {"ok": True}
    finally:
        if own_conn:
            conn.close()
