"""Content-tag recall gate (Phase 4) — the Python mirror of `content-tags.js`.

A memory carries a `content_tag` of the form `"topic:level"` (see
`memory.category_to_tag`). A Village room is resolved JS-side to a per-topic
grant map — the highest level the room may see per topic, unioned across each
villager's tiers and intersected across the room's participants. This module
decides, per row, whether a memory's tag is visible to that grant map.

Kept deliberately parallel to `content-tags.js` (the gate must run where the
query runs — this is unavoidable cross-language duplication, the same pattern as
`category_to_tag` and `slug_id`). Pure, fail-closed, never raises.
"""

from __future__ import annotations

# The fixed topic vocabulary (mirror of CONTENT_TOPICS in content-tags.js).
_TOPICS = (
    "general", "medical", "mental-health", "sexuality", "gender", "family",
    "relationships", "finances", "legal", "substance", "religion", "politics",
    "work", "location", "contact-info",
)
_TOPIC_SET = frozenset(_TOPICS)
_LEVEL_RANK = {"none": 0, "open": 1, "sensitive": 2}


def _level_rank(level) -> int:
    return _LEVEL_RANK.get(level, 0)


def normalize_tag(tag):
    """Normalize an extractor/stored tag to `(topic, level)`, or None if it isn't
    a recognised topic. Accepts `"medical:sensitive"`, `"medical-sensitive"`, or a
    dict. Unknown/absent level defaults to `sensitive` (a mis-tag gates TIGHTER)."""
    topic = level = None
    if isinstance(tag, dict):
        topic, level = tag.get("topic"), tag.get("level")
    elif isinstance(tag, str):
        s = tag.strip().lower()
        # Match against the known topics (some contain hyphens, e.g.
        # mental-health), longest first, then read an optional trailing level.
        for t in sorted(_TOPICS, key=len, reverse=True):
            if s == t or s.startswith(t + ":") or s.startswith(t + "-"):
                topic = t
                rest = s[len(t):].lstrip(":-")
                if rest in ("open", "sensitive"):
                    level = rest
                break
    if topic not in _TOPIC_SET:
        return None
    return topic, (level if level in ("open", "sensitive") else "sensitive")


def memory_visible_to_grants(content_tag, topic_grants) -> bool:
    """Whether a memory's `content_tag` is visible to a room's per-topic grant map.

    `topic_grants` is `{topic: 'open'|'sensitive'}`; a topic absent from the map is
    `none` (fail-closed — a room only sees topics explicitly granted). An
    unrecognised/absent tag is treated as `general:sensitive`, so an untagged
    memory never leaks to a room that only has baseline `general:open`.

    Visible ⟺ the room's granted level for the tag's topic ≥ the tag's level.
    Pure. Never raises.
    """
    norm = normalize_tag(content_tag)
    topic, level = norm if norm else ("general", "sensitive")
    want = _level_rank(level)
    have = _level_rank((topic_grants or {}).get(topic, "none")) if isinstance(topic_grants, dict) else 0
    return have >= want and want > 0
