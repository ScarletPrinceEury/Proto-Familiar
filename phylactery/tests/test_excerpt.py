"""excerpt() mirrors src/util/excerpt.js (known-issues A3).

Recall results showed content[:300], a fact cut mid-word. Both excerpts run the
same fixture, tests/fixtures/excerpt-cases.json (generated from the Node one),
so they can't drift.
"""

import json
from pathlib import Path

import pytest

from phylactery.excerpt import EXCERPT_MARKER, excerpt, excerpt_fields

FIXTURE = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "excerpt-cases.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_matches_the_node_excerpt(case):
    assert excerpt(case["text"], case["max"]) == case["out"]


def test_marker_matches_node():
    assert EXCERPT_MARKER == "[… cut for length …]"


def test_fields_say_when_it_was_cut_and_how_long_the_memory_is():
    assert excerpt_fields("short") == {"excerpt": "short"}
    long = "word " * 100
    f = excerpt_fields(long, 300)
    assert f["truncated"] is True and f["chars"] == len(long) and EXCERPT_MARKER in f["excerpt"]
    assert len(f["excerpt"]) <= 300
