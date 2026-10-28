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
    """Add to the end of an identity file, creating it if needed. Returns
    {ok, chars, under, created}: `under` is the heading the new text now sits
    under (the file's last heading, or the first one in the text itself), which
    is where a misplaced append shows."""
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
        own = section_headings(content)
        if row:
            before = section_headings(row["content"] or "")
            under = own[0] if own and _HEADING_RE.match((content or "").lstrip()) else (before[-1] if before else None)
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
            return {"ok": True, "chars": len(content), "under": own[0] if own else None, "created": True}
        return {"ok": True, "chars": len(new_content), "under": under, "created": False}
    finally:
        if own_conn:
            conn.close()


# A heading is a line of one to six #s, then a space, then its title. A line
# that only starts with # ("#hashtag", "#1 fan") is text, not a heading; the old
# pattern ended a section at it.
_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*$", re.MULTILINE)


class SectionEditError(Exception):
    """A section edit that would do something other than what was asked."""

    def __init__(self, code: str, message: str, **info: Any):
        super().__init__(message)
        self.code = code
        self.message = message
        self.info = info


def _sections(content: str) -> list[dict[str, Any]]:
    """Every heading in order, with where its section starts and ends. A section
    runs from its heading to the next heading of ANY level (identity files are
    one # title plus ## sections, so a level-aware section would make the title
    contain the whole file and a rewrite of it replace everything)."""
    found = list(_HEADING_RE.finditer(content or ""))
    out = []
    for i, m in enumerate(found):
        end = found[i + 1].start() if i + 1 < len(found) else len(content)
        out.append({"title": m.group(2).strip(), "level": len(m.group(1)),
                    "start": m.start(), "body_start": m.end(), "end": end})
    return out


def section_headings(content: str) -> list[str]:
    """The markdown headings in a file, in order, without their #s."""
    return [s["title"] for s in _sections(content)]


def outline(content: str) -> list[dict[str, Any]]:
    """The file's headings, each with its size and, when a heading repeats,
    which one it is ("Tone", 1 of 2) — so an edit can name the one it means."""
    secs = _sections(content)
    counts: dict[str, int] = {}
    for s in secs:
        counts[s["title"]] = counts.get(s["title"], 0) + 1
    seen: dict[str, int] = {}
    out = []
    for s in secs:
        seen[s["title"]] = seen.get(s["title"], 0) + 1
        item = {"heading": s["title"], "level": s["level"], "chars": s["end"] - s["start"]}
        if counts[s["title"]] > 1:
            item["occurrence"], item["of"] = seen[s["title"]], counts[s["title"]]
        out.append(item)
    return out


def _pick_section(content: str, section: str, occurrence: int | None) -> dict[str, Any] | None:
    """The one section an edit means, or None when there's no such heading.
    Raises when the heading repeats and no occurrence says which, or the
    occurrence is out of range."""
    title = (section or "").strip()
    matches = [s for s in _sections(content) if s["title"] == title]
    if not matches:
        return None
    if occurrence is None:
        if len(matches) > 1:
            raise SectionEditError("duplicate", f"there are {len(matches)} sections headed {title!r}",
                                   count=len(matches))
        return matches[0]
    if not isinstance(occurrence, int) or isinstance(occurrence, bool) or not 1 <= occurrence <= len(matches):
        raise SectionEditError("bad_occurrence", f"there's no section {title!r} number {occurrence} (there are {len(matches)})",
                               count=len(matches))
    return matches[occurrence - 1]


def _rewrite_section(content: str, section: str, new_body: str, create_if_missing: bool = True,
                     occurrence: int | None = None) -> tuple[str, bool]:
    """Replace the body of ONE markdown section. Returns (new_content,
    replaced?). With no such heading, the section is appended at the end, or,
    when create_if_missing is False, the content comes back unchanged.

    Raises SectionEditError when the heading repeats without an occurrence, and
    when the new body carries a heading the file already has elsewhere: that's
    how a rewrite used to leave the next section in twice."""
    title = (section or "").strip()
    body = (new_body or "").strip()
    # A body that opens with the section's own heading means the body, not a
    # second copy of the heading.
    first = _HEADING_RE.match(body)
    if first and first.group(2).strip() == title:
        body = body[first.end():].strip()
    picked = _pick_section(content, title, occurrence)
    others = {s["title"] for s in _sections(content) if picked is None or s["start"] != picked["start"]}
    carried = [h for h in section_headings(body) if h in others]
    if carried:
        raise SectionEditError("includes_heading", f"the new text has \"{carried[0]}\" in it, which the file already has as its own section",
                               headings=carried)
    if picked is None:
        if not create_if_missing:
            return content, False
        return content.rstrip() + f"\n\n## {title}\n\n{body}\n", False
    heading_line = content[picked["start"]:picked["body_start"]]
    rest = content[picked["end"]:]
    return content[:picked["start"]] + f"{heading_line}\n{body}\n" + ("\n" + rest if rest else ""), True


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


def _delete_section(content: str, section: str, occurrence: int | None = None) -> tuple[str, bool]:
    """Remove ONE markdown section (its heading + body, up to the next heading
    or EOF). Returns (new_content, removed?). Raises SectionEditError when the
    heading repeats without an occurrence. Collapses the blank-line gap the cut
    leaves behind so the file stays tidy."""
    picked = _pick_section(content, section, occurrence)
    if picked is None:
        return content, False
    new = content[:picked["start"]] + content[picked["end"]:]
    new = re.sub(r"\n{3,}", "\n\n", new).strip()
    return (new + "\n" if new else ""), True


def read_file(category: str, filename: str, conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    """One identity file as it is right now (the copy loaded at the start of a
    turn is older the moment I edit it), with its size and an outline of its
    headings, duplicates numbered. Returns {ok, category, filename, content,
    chars, outline} or {ok:false, error, files} naming the category's files."""
    if category not in VALID_CATEGORIES:
        return {"ok": False, "error": f"invalid category: {category!r}"}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        row = conn.execute(
            "SELECT content FROM identity_files WHERE category=? AND filename=?",
            (category, filename),
        ).fetchone()
        if row is None:
            files = [r["filename"] for r in conn.execute(
                "SELECT filename FROM identity_files WHERE category=? ORDER BY sort_order, filename", (category,))]
            return {"ok": False, "error": f"no such identity file: {category}/{filename}", "files": files}
        content = row["content"] or ""
        return {"ok": True, "category": category, "filename": filename, "content": content,
                "chars": len(content), "outline": outline(content)}
    finally:
        if own_conn:
            conn.close()


def rewrite_section(
    category: str,
    filename: str,
    section: str,
    new_body: str,
    conn: sqlite3.Connection | None = None,
    create_if_missing: bool = True,
    occurrence: int | None = None,
) -> dict[str, Any]:
    """Replace one section's body. Returns {ok, replaced, chars}. With no such
    heading (or no such file) the section is created, unless create_if_missing
    is False: then nothing changes and the result is {ok:false, error, sections}
    naming the headings the file does have, so a misnamed section never quietly
    grows the file while the caller believes it rewrote one. A heading that
    repeats needs `occurrence` (1-based, as read_file's outline numbers them);
    a new body carrying a heading the file has elsewhere is refused. Refusals
    are {ok:false, code, error, sections, ...} and change nothing."""
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
            try:
                new_content, replaced = _rewrite_section(old, section, new_body, create_if_missing, occurrence)
            except SectionEditError as e:
                return {"ok": False, "code": e.code, "error": f"{e.message} in {category}/{filename}",
                        "sections": section_headings(old), **e.info}
            if not replaced and not create_if_missing:
                return {"ok": False, "error": f"no section headed {section!r} in {category}/{filename}",
                        "sections": section_headings(old)}
            auto_snapshot(conn)
            with conn:
                conn.execute(
                    "UPDATE identity_files SET content=?, updated_at=? WHERE id=?",
                    (new_content, now, row["id"]),
                )
            return {"ok": True, "replaced": replaced, "chars": len(new_content)}
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
            return {"ok": False, "code": "not_found", "error": f"that passage isn't in {category}/{filename}; it has to be quoted as the file has it"}
        if len(spans) > 1:
            return {"ok": False, "code": "repeated", "error": f"that passage is in {category}/{filename} {len(spans)} times; quote more around it so it's one place"}
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
    occurrence: int | None = None,
) -> dict[str, Any]:
    """Remove ONE markdown section (heading + body) from an identity file
    (auto-snapshots first). Returns {ok, chars} on success, {ok:false, error} if
    the file or the section isn't found — never silently no-ops. A heading that
    repeats needs `occurrence` (1-based); without it nothing changes and the
    result says how many there are (it used to remove all of them)."""
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
        old = row["content"] or ""
        try:
            new_content, removed = _delete_section(old, section, occurrence)
        except SectionEditError as e:
            return {"ok": False, "code": e.code, "error": f"{e.message} in {category}/{filename}", **e.info}
        if not removed:
            return {"ok": False, "error": f"section not found: {section!r}", "sections": section_headings(old)}
        auto_snapshot(conn)
        with conn:
            conn.execute(
                "UPDATE identity_files SET content=?, updated_at=? WHERE id=?",
                (new_content, now_iso(), row["id"]),
            )
        return {"ok": True, "chars": len(new_content)}
    finally:
        if own_conn:
            conn.close()
