"""Consolidation LLM limits (0.12.8) — the fix for the timeout / empty-summary
failure loop where weekly→monthly→yearly and distillation all funnelled through
one raw fetch hardcoded to 4000 tokens / 60s / content-only.

Covered here:
  - _extract_message_content: reasoning_content fallback (thinking models)
  - _call_llm: honours cfg max_tokens/timeout; retries once on a timeout
  - _llm_config: env-configurable with safe fallbacks (blank/invalid/too-small)
  - _chunk_entries: lossless split of an oversized period at entry boundaries
  - _summarize_entries: single call when it fits; chunk+fold when it doesn't
"""

from unittest.mock import patch

import httpx

from phylactery import consolidate


# ── _extract_message_content: the reasoning_content fallback ──────────────────
def test_extract_prefers_content_then_reasoning():
    assert consolidate._extract_message_content({"content": "- real"}) == "- real"
    # empty content but a thinking model parked the answer in reasoning_content
    assert consolidate._extract_message_content(
        {"content": "", "reasoning_content": "- from reasoning"}) == "- from reasoning"
    assert consolidate._extract_message_content(
        {"content": "   ", "reasoning": "- from reasoning2"}) == "- from reasoning2"
    # nothing usable anywhere → empty string (the write-side guard then refuses it)
    assert consolidate._extract_message_content({"content": ""}) == ""
    assert consolidate._extract_message_content({}) == ""
    assert consolidate._extract_message_content(None) == ""


# ── _call_llm: cfg-driven cap/timeout + reasoning fallback end to end ─────────
def test_call_llm_uses_cfg_max_tokens_and_timeout():
    captured = {}

    class _Resp:
        def raise_for_status(self): pass
        def json(self): return {"choices": [{"message": {"content": "- ok"}}]}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["max_tokens"] = json["max_tokens"]
        captured["timeout"] = timeout
        return _Resp()

    cfg = {"base_url": "http://x", "api_key": "k", "model": "m",
           "max_tokens": 8000, "timeout_s": 240.0}
    with patch("httpx.post", fake_post):
        assert consolidate._call_llm(cfg, "prompt") == "- ok"
    assert captured["max_tokens"] == 8000
    assert captured["timeout"] == 240.0


def test_call_llm_reads_reasoning_content_when_content_empty():
    class _Resp:
        def raise_for_status(self): pass
        def json(self):
            return {"choices": [{"message": {"content": "", "reasoning_content": "- parked"}}]}

    with patch("httpx.post", lambda *a, **k: _Resp()):
        out = consolidate._call_llm({"base_url": "http://x", "api_key": "k", "model": "m"}, "p")
    assert out == "- parked"


def test_call_llm_retries_once_on_timeout_then_succeeds():
    calls = {"n": 0}

    class _Resp:
        def raise_for_status(self): pass
        def json(self): return {"choices": [{"message": {"content": "- recovered"}}]}

    def flaky_post(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ReadTimeout("the read operation timed out")
        return _Resp()

    with patch("httpx.post", flaky_post):
        out = consolidate._call_llm({"base_url": "http://x", "api_key": "k", "model": "m"}, "p")
    assert out == "- recovered"
    assert calls["n"] == 2, "one retry after the first timeout"


def test_call_llm_reraises_after_a_second_timeout():
    def always_timeout(*a, **k):
        raise httpx.ReadTimeout("still timing out")

    with patch("httpx.post", always_timeout):
        try:
            consolidate._call_llm({"base_url": "http://x", "api_key": "k", "model": "m"}, "p")
            assert False, "should have re-raised the timeout"
        except httpx.TimeoutException:
            pass


# ── _llm_config: env-configurable with safe fallbacks ────────────────────────
def test_llm_config_defaults_when_unset(monkeypatch):
    monkeypatch.setenv("PHYLACTERY_LLM_API_KEY", "k")
    monkeypatch.setenv("PHYLACTERY_LLM_BASE_URL", "http://x")
    monkeypatch.setenv("PHYLACTERY_LLM_MODEL", "m")
    for k in ("PHYLACTERY_LLM_MAX_TOKENS", "PHYLACTERY_LLM_TIMEOUT_S", "PHYLACTERY_LLM_CHUNK_CHARS"):
        monkeypatch.delenv(k, raising=False)
    cfg = consolidate._llm_config()
    assert cfg["max_tokens"] == consolidate._DEFAULT_MAX_TOKENS == 8000
    assert cfg["timeout_s"] == consolidate._DEFAULT_TIMEOUT_S == 240.0
    assert cfg["chunk_chars"] == consolidate._DEFAULT_CHUNK_CHARS == 60000


def test_llm_config_reads_env_overrides(monkeypatch):
    monkeypatch.setenv("PHYLACTERY_LLM_API_KEY", "k")
    monkeypatch.setenv("PHYLACTERY_LLM_BASE_URL", "http://x")
    monkeypatch.setenv("PHYLACTERY_LLM_MODEL", "m")
    monkeypatch.setenv("PHYLACTERY_LLM_MAX_TOKENS", "12000")
    monkeypatch.setenv("PHYLACTERY_LLM_TIMEOUT_S", "300")
    cfg = consolidate._llm_config()
    assert cfg["max_tokens"] == 12000
    assert cfg["timeout_s"] == 300.0


def test_llm_config_rejects_garbage_and_too_small(monkeypatch):
    monkeypatch.setenv("PHYLACTERY_LLM_API_KEY", "k")
    monkeypatch.setenv("PHYLACTERY_LLM_BASE_URL", "http://x")
    monkeypatch.setenv("PHYLACTERY_LLM_MODEL", "m")
    monkeypatch.setenv("PHYLACTERY_LLM_MAX_TOKENS", "not-a-number")
    monkeypatch.setenv("PHYLACTERY_LLM_TIMEOUT_S", "1")  # below the 10s floor
    cfg = consolidate._llm_config()
    assert cfg["max_tokens"] == 8000, "garbage falls back to default"
    assert cfg["timeout_s"] == 240.0, "a too-small timeout falls back to default"


# ── _chunk_entries: lossless split ───────────────────────────────────────────
def test_chunk_entries_fits_is_one_chunk():
    entries = ["- a", "- b"]
    assert consolidate._chunk_entries(entries, 60000) == [entries]


def test_chunk_entries_splits_losslessly():
    entries = [("x" * 1000) + f"#{i}" for i in range(20)]  # ~20 KB
    chunks = consolidate._chunk_entries(entries, 5000)
    assert len(chunks) > 1, "an oversized period splits"
    flat = [e for c in chunks for e in c]
    assert flat == entries, "concatenation is exactly the input — nothing dropped or reordered"


def test_chunk_entries_lone_oversized_entry_gets_its_own_chunk():
    entries = ["- small", "y" * 80000, "- small again"]
    chunks = consolidate._chunk_entries(entries, 60000)
    assert [e for c in chunks for e in c] == entries
    assert any(len(c) == 1 and len(c[0]) == 80000 for c in chunks)


def test_chunk_entries_empty():
    assert consolidate._chunk_entries([], 60000) == []


# ── _summarize_entries: single call vs chunk+fold ────────────────────────────
def test_summarize_small_period_is_a_single_call_with_prior_summary():
    seen = []

    def fake_call(cfg, prompt):
        seen.append(prompt)
        return "- folded"

    with patch.object(consolidate, "_call_llm", fake_call):
        out = consolidate._summarize_entries(
            {"chunk_chars": 60000}, "daily", "weekly", ["- a", "- b"], prior_summary="- prior")
    assert out == "- folded"
    assert len(seen) == 1, "one call for a period that fits"
    assert "- prior" in seen[0], "the prior summary rides the single call's fold path"


def test_summarize_oversized_period_chunks_and_folds():
    seen = []

    def fake_call(cfg, prompt):
        seen.append(prompt)
        return f"- running-{len(seen)}"

    entries = [("x" * 1000) + f"#{i}" for i in range(20)]  # forces multiple chunks at 5000
    with patch.object(consolidate, "_call_llm", fake_call):
        out = consolidate._summarize_entries(
            {"chunk_chars": 5000}, "daily", "weekly", entries)
    assert len(seen) > 1, "an oversized period makes several folding calls"
    # the running summary from call N-1 must appear in call N's fold prompt
    assert "- running-1" in seen[1], "each chunk folds into the summary so far"
    assert out.startswith("- running-")


def test_summarize_empty_chunk_result_keeps_running_summary():
    # Three ~4 KB entries at a 5 KB cap → three single-entry chunks → three calls.
    entries = ["a" * 4000, "b" * 4000, "c" * 4000]
    outs = ["- good", "- good2", ""]  # the LAST fold comes back empty

    def fake_call(cfg, prompt):
        return outs.pop(0)

    with patch.object(consolidate, "_call_llm", fake_call):
        out = consolidate._summarize_entries(
            {"chunk_chars": 5000}, "daily", "weekly", entries)
    # a trailing empty fold must not discard the summary already gathered
    assert out == "- good2", "an empty fold never wipes what was already gathered"
