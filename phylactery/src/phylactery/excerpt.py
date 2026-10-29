"""A long memory, shortened without looking unfinished (known-issues A3).

Recall results, the memory block that rides every turn, pondering's grounding
and the endpoints all showed `content[:300]`: a fact cut mid-word, which reads
as a fact that stops. An excerpt keeps the START and the END of the text, both
cut at word boundaries, with an explicit marker between them; the real ending
shows the fact was complete, the marker says the gap is only how it's shown.

This MIRRORS src/util/excerpt.js (the Node side, 0.14.69). One fixture of
input/output pairs, tests/fixtures/excerpt-cases.json, is run by both test
suites, so the two can't drift. Lengths are counted in characters; keep the
fixtures to text where JavaScript's UTF-16 length and Python's agree (no emoji
or other characters outside the basic plane).
"""

from __future__ import annotations

import re

EXCERPT_MARKER = "[… cut for length …]"

# Share of the budget the ending gets; the rest (minus the marker) is the start.
TAIL_SHARE = 0.3
# A word boundary is only used if it doesn't throw away more than this share of
# the part being cut — one huge unbroken run is cut hard instead.
BOUNDARY_SLACK = 0.3

# \Z, not $: Python's $ also matches before a trailing newline, JavaScript's
# only at the very end, and a cut ending on a newline picked a different word.
_LAST_WORD = re.compile(r"\s\S*\Z")
_SPACE = re.compile(r"\s")


def _head_at(text: str, n: int) -> str:
    if n <= 0:
        return ""
    cut = text[:n]
    m = _LAST_WORD.search(cut)
    sp = m.start() if m else -1
    return (cut[:sp] if sp > 0 and sp >= n * (1 - BOUNDARY_SLACK) else cut).rstrip()


def _tail_at(text: str, n: int) -> str:
    if n <= 0:
        return ""
    cut = text[len(text) - n:]
    m = _SPACE.search(cut)
    sp = m.start() if m else -1
    return (cut[sp:] if 0 <= sp <= n * BOUNDARY_SLACK else cut).lstrip()


def excerpt(text: str | None, max_len: int) -> str:
    """`text` shortened to at most `max_len` characters: start + marker + end."""
    s = str(text or "")
    if len(s) <= max_len:
        return s
    room = max_len - len(EXCERPT_MARKER) - 2  # two joining spaces
    if room <= 0:
        return s[:max(0, max_len)]
    tail_len = int(room * TAIL_SHARE)
    return f"{_head_at(s, room - tail_len)} {EXCERPT_MARKER} {_tail_at(s, tail_len)}"


def excerpt_fields(content: str | None, max_len: int = 300) -> dict:
    """The fields a recall result carries for its text: `excerpt`, and, when
    that's shorter than the memory, `truncated: True` and the full `chars`."""
    full = str(content or "")
    out = {"excerpt": excerpt(full, max_len)}
    if len(full) > max_len:
        out["truncated"] = True
        out["chars"] = len(full)
    return out
