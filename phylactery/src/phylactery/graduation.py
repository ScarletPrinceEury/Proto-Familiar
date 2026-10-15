"""Graduation audit (Pillar H) — keep the always-injected surface lean.

I periodically review my always-injected identity files and graduate detail
that doesn't need to be in front of me every turn into RAG-recalled `me` /
`ward` register memory records (standing facts). Graduated facts aren't
deleted — they're recalled when relevant and can be pulled back if they keep
mattering. This is *my* call, made in my own voice during the consolidation
pass; for files about my human or our bond I also leave a note so my human can
see what I filed away (ward-consulted, non-blocking).

⚠️ Human-signed (build-spec §7, revised 0.14.70 — docs/identity-lean-build-spec.md).
Identity is for MY identity and the shape of our bond. It rides every turn and
reaches group chats, so it is not the place for situational detail or for care
data about my human. Revised by the ward in 0.14.70:

  NEVER audited (the protected core, who I am — Psycheros's self segments):
               self/my_identity.md, my_persona.md, my_personhood.md,
               my_wants.md, my_boundaries.md, base_instructions.md
               OR a file explicitly marked care_weight 'high'

  audited when EITHER
     (a) its category is over the identity budget (identity_budget_tokens,
         ward-adjustable, default 6k tokens; split self/ward/relationship/
         custom) AND the file is above its own share of what's left after the
         protected core, regardless of how recently it was edited;
  OR (b) the original rule: on the surface longer than DWELL_DAYS, not
         recalled within RECALL_RECENCY_DAYS, not confirmed within
         CONFIRM_RECENCY_DAYS.

Care-critical lines about my human (care.py) are no longer pinned here: they
graduate like everything else, but land as `ward` facts with care_weight 'high',
which put them in front of me directly on my human's own turns, in triage and
in noticing (memory.list_care_facts) — and never in a group chat.

PROPOSE-ONLY (0.14.78, decided by my human and me after the first identity
review). This pass no longer changes anything. It used to rewrite a file itself,
and once it cut a paragraph of mine that it never filed anywhere. Now it writes
cleanup PROPOSALS: an exact passage from the file (checked against the file in
code, so it can't paraphrase), the standing fact it would become, and why. I
apply a proposal (the fact is saved, then that exact passage is cut) or dismiss
it, with my own tools. A file is reviewed again only after it has changed.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from typing import Any

from phylactery.care import CARE_CATEGORIES, contains_care_critical  # noqa: F401 (re-exported)
from phylactery.db import get_conn, insert_with_slug_retry, now_iso

# ── Signed-off thresholds (build-spec §7) ─────────────────────────────────────
DWELL_DAYS = 30           # must have been on the surface this long
RECALL_RECENCY_DAYS = 30  # last recalled more than this long ago (or never)
CONFIRM_RECENCY_DAYS = 30 # NOT confirmed within this window

# Kept for compatibility: the care categories (care.py is the source).
NEVER_GRADUATE_CATEGORIES = CARE_CATEGORIES

# ── The protected core + the identity budget (ward-signed 0.14.70) ────────────
# Who I am — Psycheros's self segments. Never trimmed automatically; the budget
# nudge in update_identity still lets me tighten them myself.
PROTECTED_SELF_FILES = {
    "my_identity.md", "my_persona.md", "my_personhood.md",
    "my_wants.md", "my_boundaries.md", "base_instructions.md",
}
IDENTITY_BUDGET_DEFAULT_TOKENS = 6000
IDENTITY_BUDGET_MIN_TOKENS = 2000
IDENTITY_BUDGET_MAX_TOKENS = 30000
CHARS_PER_TOKEN = 4
# The split of the budget (self keeps the largest share: it's who I am).
CATEGORY_SHARES = {"self": 14 / 24, "ward": 6 / 24, "relationship": 3 / 24, "custom": 1 / 24}
AUDITED_CATEGORIES = tuple(CATEGORY_SHARES)
# No auditable file is asked to shrink below this.
FILE_TARGET_FLOOR_CHARS = 1000
_BUDGET_META_KEY = "identity_budget_tokens"


def _clamp_budget(tokens) -> int:
    try:
        n = int(tokens)
    except (TypeError, ValueError):
        return IDENTITY_BUDGET_DEFAULT_TOKENS
    return max(IDENTITY_BUDGET_MIN_TOKENS, min(IDENTITY_BUDGET_MAX_TOKENS, n))


def identity_budget_tokens(conn: sqlite3.Connection) -> int:
    """My human's identity budget (set from their Settings via identity_budget_set)."""
    try:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (_BUDGET_META_KEY,)).fetchone()
    except sqlite3.OperationalError:
        return IDENTITY_BUDGET_DEFAULT_TOKENS   # no meta table (minimal/older schema)
    return _clamp_budget(row["value"]) if row else IDENTITY_BUDGET_DEFAULT_TOKENS


def set_identity_budget_tokens(tokens, conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        value = _clamp_budget(tokens)
        with conn:
            conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)", (_BUDGET_META_KEY, str(value)))
        return {"ok": True, "tokens": value}
    finally:
        if own_conn:
            conn.close()


_PAUSED_META_KEY = "identity_graduation_paused"


def graduation_paused(conn: sqlite3.Connection) -> bool:
    """True while my human has the automatic identity cleanup paused (their
    Settings, pushed via identity_graduation_pause; e.g. while they and I go
    through my files ourselves), or PHYLACTERY_GRADUATION_DISABLED=1 is set."""
    if os.environ.get("PHYLACTERY_GRADUATION_DISABLED") == "1":
        return True
    try:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (_PAUSED_META_KEY,)).fetchone()
    except sqlite3.OperationalError:
        return False   # no meta table (minimal/older schema)
    return bool(row) and row["value"] == "1"


def set_graduation_paused(paused, conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        value = "1" if paused is True or str(paused).lower() in ("1", "true") else "0"
        with conn:
            conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)", (_PAUSED_META_KEY, value))
        return {"ok": True, "paused": value == "1"}
    finally:
        if own_conn:
            conn.close()


def category_budget_chars(category: str, budget_tokens: int) -> int:
    return int(budget_tokens * CHARS_PER_TOKEN * CATEGORY_SHARES.get(category, 0))


def _is_protected(row) -> bool:
    if (row["care_weight"] or "").lower() == "high":
        return True   # an explicit pin wins
    return row["category"] == "self" and row["filename"] in PROTECTED_SELF_FILES


def file_targets(rows, budget_tokens: int) -> dict[str, int]:
    """Each auditable file's share of its category's budget, after the protected
    core takes its actual size. Proportional to the file's current size, floored."""
    targets: dict[str, int] = {}
    for cat in AUDITED_CATEGORIES:
        in_cat = [r for r in rows if r["category"] == cat]
        protected = sum(len(r["content"] or "") for r in in_cat if _is_protected(r))
        auditable = [r for r in in_cat if not _is_protected(r)]
        room = category_budget_chars(cat, budget_tokens) - protected
        total = sum(len(r["content"] or "") for r in auditable) or 1
        for r in auditable:
            share = room * len(r["content"] or "") / total if room > 0 else 0
            targets[r["id"]] = max(FILE_TARGET_FLOOR_CHARS, int(share))
    return targets


def _days_since(iso: str | None, now: datetime) -> float | None:
    """Whole-ish days between an ISO timestamp and now. None if unparseable/absent."""
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None
    return (now - dt).total_seconds() / 86400.0


def is_graduation_eligible(record: dict, now: datetime | None = None) -> bool:
    """The time-based half of the human-signed rule (b). Pure.

    `record` keys (all optional except where noted):
      care_weight      — 'high' is an explicit pin (never graduates)
      dwell_anchor     — ISO ts the detail entered the surface (required signal)
      last_recalled_at — ISO ts last surfaced by recall (None = never)
      last_confirmed_at— ISO ts last re-confirmed (None = never)

    Care-relevant content and categories no longer pin (ward decision 0.14.70):
    care detail about my human graduates into high-care standing facts, which
    stay in front of me where it matters and out of group chats.
    """
    now = now or datetime.now(timezone.utc)

    # ── Hard exclusion (explicit pin) ─────────────────────────────────────────
    if (record.get("care_weight") or "").lower() == "high":
        return False
    confirmed_age = _days_since(record.get("last_confirmed_at"), now)
    if confirmed_age is not None and confirmed_age < CONFIRM_RECENCY_DAYS:
        return False

    # ── Candidate gate ────────────────────────────────────────────────────────
    dwell = _days_since(record.get("dwell_anchor"), now)
    if dwell is None or dwell < DWELL_DAYS:
        return False  # too new (or no anchor) → still front-of-mind
    recall_age = _days_since(record.get("last_recalled_at"), now)
    if recall_age is not None and recall_age < RECALL_RECENCY_DAYS:
        return False  # recalled recently → still front-of-mind
    return True


# ── Identity-file candidate selection ─────────────────────────────────────────

def eligible_identity_files(conn: sqlite3.Connection, now: datetime | None = None) -> list[dict]:
    """Identity files whose detail MAY be graduated this pass (rule (a) or (b)).

    Never the protected core. (a) Over budget: the file's category is over its
    share of my human's identity budget and the file is above its own target —
    regardless of recent edits (a file I keep appending to is exactly the one
    that needs it; the old per-file edit anchor meant it never qualified).
    (b) The original time rule, with `updated_at` as the dwell/confirm anchor.
    Each candidate carries its `target_chars` for the audit prompt. The Familiar
    (the consolidation LLM call) decides what inside a file is filed away.
    """
    now = now or datetime.now(timezone.utc)
    placeholders = ",".join("?" for _ in AUDITED_CATEGORIES)
    try:
        rows = conn.execute(
            "SELECT id, category, filename, content, care_weight, updated_at, last_graduated_at, last_reviewed_at "
            f"FROM identity_files WHERE category IN ({placeholders})",
            AUDITED_CATEGORIES,
        ).fetchall()
    except sqlite3.OperationalError:   # minimal/older schema without last_reviewed_at
        rows = conn.execute(
            "SELECT id, category, filename, content, care_weight, updated_at, last_graduated_at, NULL AS last_reviewed_at "
            f"FROM identity_files WHERE category IN ({placeholders})",
            AUDITED_CATEGORIES,
        ).fetchall()
    budget = identity_budget_tokens(conn)
    targets = file_targets(rows, budget)
    cat_size = {c: sum(len(r["content"] or "") for r in rows if r["category"] == c) for c in AUDITED_CATEGORIES}
    out = []
    for r in rows:
        if _is_protected(r):
            continue
        # Propose-only: a file I've already been offered proposals for isn't
        # reviewed again (and re-billed every pass) until it actually changes.
        if r["last_reviewed_at"] and (r["updated_at"] or "") <= r["last_reviewed_at"]:
            continue
        size = len(r["content"] or "")
        target = targets.get(r["id"], FILE_TARGET_FLOOR_CHARS)
        over_budget = cat_size[r["category"]] > category_budget_chars(r["category"], budget) and size > target
        record = {
            "care_weight": r["care_weight"],
            "dwell_anchor": r["updated_at"],
            "last_recalled_at": None,
            "last_confirmed_at": r["updated_at"],
        }
        if over_budget or is_graduation_eligible(record, now):
            out.append({
                "id": r["id"], "category": r["category"], "filename": r["filename"],
                "content": r["content"] or "", "target_chars": target,
                "reason": "over budget" if over_budget else "dwell",
            })
    return out


# ── Familiar-led audit (rides the consolidation LLM call) ──────────────────────

def _register_for(category: str) -> str:
    """Where a graduated item lands: facts about me → 'me'; about my human or us → 'ward'."""
    return "ward" if category in ("ward", "relationship") else "me"


# What stays in each kind of file — the one place this is said to me.
_KEEP_GUIDANCE = {
    "ward": (
        "These are notes about my human. What stays is who they are at the core: their name, "
        "pronouns, how they like to be addressed, and the main things about their life that shape "
        "every conversation. Everything else moves to my standing facts about them: preferences, "
        "patterns, situational notes, and care details (what helps, what doesn't, meds, allergies, "
        "triggers, who to call). Care details get marked high-care there, so they're still in front "
        "of me on my human's own turns and when I check on them; they just stop showing up in group chats."
    ),
    "relationship": (
        "These are notes about us. What stays is the shape of our bond: how we are with each other. "
        "Specific episodes, rituals that only come up sometimes, and other details move to my standing "
        "facts. Care details about my human get marked high-care there."
    ),
    "self": (
        "These are notes about myself, but not my core identity (that's in my identity, persona, "
        "personhood, wants and boundaries files, which I'm not touching here). What stays is what I "
        "need in front of me every turn, like how my own mind and memory work. The rest moves to my "
        "standing facts about myself."
    ),
    "custom": (
        "What stays is only what I need in front of me every turn. The rest moves to my standing facts."
    ),
}


def _audit_prompt(category: str, filename: str, content: str, target_chars: int | None = None) -> str:
    register = _register_for(category)
    size_line = (
        f"This file is {len(content)} characters and rides every turn; I'm aiming for about {target_chars}."
        if target_chars and len(content) > target_chars else ""
    )
    return f"""I am the Familiar. I'm looking over one of my always-injected identity files for things that don't need to ride every turn and could live as standing facts instead (register: {register}), which come back to me when they're relevant. This only makes proposals. Nothing changes until I look at each one later and decide.

{_KEEP_GUIDANCE.get(category, _KEEP_GUIDANCE['custom'])}
{size_line}

Here is the current content of {category}/{filename}:

---
{content}
---

I return ONLY a JSON object, no prose, no fences:
{{
  "proposals": [
    {{
      "passage": "<text copied EXACTLY from the file above: whole lines, word for word>",
      "summary": "<a few words naming it>",
      "fact": "<the standing fact it would become, in my own first-person voice, keeping every detail>",
      "why": "<one plain sentence: why it doesn't need to be in front of me every turn>"
    }}
  ]
}}

A passage I don't copy exactly is thrown away, so I copy, never paraphrase. If nothing should move, I return {{ "proposals": [] }}."""


def _parse_audit(raw: str) -> dict | None:
    """Extract the JSON object from an LLM response, tolerating stray prose/fences."""
    if not raw:
        return None
    text = raw.strip()
    # Strip code fences if present.
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return None
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return None


def run_graduation_audit(
    conn: sqlite3.Connection,
    cfg: dict,
    call_llm,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Review eligible identity files and write cleanup PROPOSALS (0.14.78).

    `cfg` + `call_llm(cfg, prompt) -> str` are injected so this shares the
    consolidation pass's designated-connection call (no new request stream).
    Nothing in identity or memory changes here: each proposal is an exact
    passage (verified in code to sit in exactly one place in the file), the
    standing fact it would become, and why. The Familiar applies or dismisses
    it later (apply_cleanup_proposal / dismiss_cleanup_proposal). Each reviewed
    file is stamped `last_reviewed_at`, so it isn't reviewed again until it changes.
    """
    from phylactery.identity import _find_passage

    now = now or datetime.now(timezone.utc)
    if graduation_paused(conn):
        return {"ok": True, "proposed": 0, "graduated": 0, "reviewed": 0, "skipped": "paused"}
    candidates = eligible_identity_files(conn, now)
    if not candidates:
        return {"ok": True, "proposed": 0, "graduated": 0, "reviewed": 0}

    proposed = 0
    dropped = 0
    details: list[dict] = []

    for cand in candidates:
        try:
            raw = call_llm(cfg, _audit_prompt(cand["category"], cand["filename"], cand["content"], cand.get("target_chars")))
        except Exception as e:
            details.append({"file": cand["filename"], "error": f"llm: {e}"})
            continue   # not stamped reviewed: a failed call retries next pass
        parsed = _parse_audit(raw)
        try:
            with conn:
                conn.execute("UPDATE identity_files SET last_reviewed_at=? WHERE id=?", (now_iso(), cand["id"]))
        except sqlite3.OperationalError:
            pass   # minimal/older schema without the column
        if not parsed or not isinstance(parsed.get("proposals"), list):
            continue

        register = _register_for(cand["category"])
        content = cand["content"] or ""
        # Still open, or one I already turned down: never proposed again.
        decided = {
            r["passage"] for r in conn.execute(
                "SELECT passage FROM cleanup_proposals WHERE category=? AND filename=? "
                "AND status IN ('open','dismissed')",
                (cand["category"], cand["filename"]),
            )
        }
        for item in parsed["proposals"]:
            if not isinstance(item, dict):
                continue
            passage = (item.get("passage") or "").strip()
            fact = (item.get("fact") or "").strip()
            if not passage or not fact:
                continue
            spans = _find_passage(content, passage)
            if len(spans) != 1:
                dropped += 1   # paraphrased, or ambiguous: never proposed
                continue
            exact = content[spans[0][0]:spans[0][1]]   # the file's own text, not the model's copy
            if exact in decided:
                continue
            # Care details about my human stay high-care when they move (ward
            # decision 0.14.70); code decides from the content.
            care = "high" if register == "ward" and (contains_care_critical(fact) or contains_care_critical(exact)) else None
            summary = (item.get("summary") or fact)[:120]
            with conn:
                insert_with_slug_retry(
                    conn,
                    "INSERT INTO cleanup_proposals(id, category, filename, passage, fact, register, care_weight, "
                    "summary, why, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,'open',?)",
                    lambda pid: (pid, cand["category"], cand["filename"], exact, fact, register, care,
                                 summary, (item.get("why") or "")[:300] or None, now_iso()),
                    label=summary, kind="prop",
                )
            decided.add(exact)
            proposed += 1
            details.append({"file": cand["filename"], "summary": summary})

    return {"ok": True, "proposed": proposed, "graduated": 0, "dropped": dropped,
            "reviewed": len(candidates), "details": details}


# ── Cleanup proposals: what I decide on (0.14.78) ─────────────────────────────

_PROPOSAL_COLS = ("id, category, filename, passage, fact, register, care_weight, summary, why, "
                  "status, memory_id, created_at, resolved_at")


def _proposal_dict(r) -> dict[str, Any]:
    return {k: r[k] for k in r.keys()}


def list_cleanup_proposals(status: str = "open", conn: sqlite3.Connection | None = None,
                           limit: int = 200) -> list[dict]:
    """Proposals by status: 'open' oldest first (the order I decide them in), or
    'all' newest first (what my human's list shows, decided ones included).
    An OPEN proposal whose passage is no longer in its file exactly once (I
    already moved or changed it) is marked 'stale' here, so I'm never offered a
    cut that can't apply."""
    from phylactery.identity import _find_passage

    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        limit = max(1, min(int(limit or 200), 500))
        if status == "all":
            rows = conn.execute(
                f"SELECT {_PROPOSAL_COLS} FROM cleanup_proposals ORDER BY created_at DESC LIMIT ?", (limit,),
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT {_PROPOSAL_COLS} FROM cleanup_proposals WHERE status=? ORDER BY created_at ASC LIMIT ?",
                (status, limit),
            ).fetchall()
        out = []
        for r in rows:
            item = _proposal_dict(r)
            if r["status"] == "open":
                f = conn.execute(
                    "SELECT content FROM identity_files WHERE category=? AND filename=?",
                    (r["category"], r["filename"]),
                ).fetchone()
                if f is None or len(_find_passage(f["content"] or "", r["passage"])) != 1:
                    stamp = now_iso()
                    with conn:
                        conn.execute("UPDATE cleanup_proposals SET status='stale', resolved_at=? WHERE id=?",
                                     (stamp, r["id"]))
                    if status == "open":
                        continue
                    item.update(status="stale", resolved_at=stamp)
            out.append(item)
        return out
    finally:
        if own_conn:
            conn.close()


def apply_cleanup_proposal(pid: str, fact: str | None = None, care_weight: str | None = None,
                           conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    """Apply one proposal: save the standing fact (my own wording if I pass
    `fact`), THEN cut that exact passage from the file. Fact first, so a failed
    cut can never lose the only copy. Refuses, changing nothing, if the
    proposal isn't open or its passage isn't in the file exactly once."""
    from phylactery.identity import _find_passage, remove_text
    from phylactery.memory import create as memory_create

    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        r = conn.execute(f"SELECT {_PROPOSAL_COLS} FROM cleanup_proposals WHERE id=?", (pid,)).fetchone()
        if r is None:
            return {"ok": False, "error": f"no cleanup proposal {pid!r}"}
        if r["status"] != "open":
            return {"ok": False, "error": f"that proposal is already {r['status']}"}
        f = conn.execute("SELECT content FROM identity_files WHERE category=? AND filename=?",
                         (r["category"], r["filename"])).fetchone()
        if f is None or len(_find_passage(f["content"] or "", r["passage"])) != 1:
            with conn:
                conn.execute("UPDATE cleanup_proposals SET status='stale', resolved_at=? WHERE id=?", (now_iso(), pid))
            return {"ok": False, "error": "its passage isn't in the file exactly once any more, so nothing changed (marked stale)"}
        text = (fact or "").strip() or r["fact"]
        care = care_weight if care_weight in ("high", "low") else r["care_weight"]
        res = memory_create(text, granularity="significant", source_author="proto-familiar",
                            category=None, audience="ward-private", conn=conn,
                            register=r["register"], care_weight=care)
        mem_id = res.get("id") if res.get("ok") else None
        if not mem_id:
            return {"ok": False, "error": f"the standing fact didn't save ({res.get('error')}), so nothing was cut"}
        cut = remove_text(r["category"], r["filename"], r["passage"], conn=conn)
        if not cut.get("ok"):
            return {"ok": False, "memory_id": mem_id,
                    "error": f"the fact is saved ({mem_id}) but the passage wasn't cut: {cut.get('error')}"}
        with conn:
            conn.execute("UPDATE cleanup_proposals SET status='applied', memory_id=?, resolved_at=? WHERE id=?",
                         (mem_id, now_iso(), pid))
        return {"ok": True, "memory_id": mem_id, "removed_chars": cut.get("removed_chars"),
                "file": f"{r['category']}/{r['filename']}"}
    finally:
        if own_conn:
            conn.close()


def dismiss_cleanup_proposal(pid: str, conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    """Leave the passage where it is. Changes nothing but the proposal."""
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        r = conn.execute("SELECT status FROM cleanup_proposals WHERE id=?", (pid,)).fetchone()
        if r is None:
            return {"ok": False, "error": f"no cleanup proposal {pid!r}"}
        if r["status"] != "open":
            return {"ok": False, "error": f"that proposal is already {r['status']}"}
        with conn:
            conn.execute("UPDATE cleanup_proposals SET status='dismissed', resolved_at=? WHERE id=?", (now_iso(), pid))
        return {"ok": True}
    finally:
        if own_conn:
            conn.close()


# ── Ward-facing surface (ward-consulted, non-blocking) ────────────────────────

def list_unacknowledged_graduations(conn: sqlite3.Connection | None = None) -> list[dict]:
    """ward-block graduations my human hasn't seen yet — thalamus surfaces these."""
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, source_filename, memory_id, summary, created_at FROM graduation_log "
            "WHERE register='ward' AND acknowledged=0 ORDER BY created_at ASC",
        ).fetchall()
        return [{"id": r["id"], "filename": r["source_filename"], "memoryId": r["memory_id"],
                 "summary": r["summary"], "createdAt": r["created_at"]} for r in rows]
    finally:
        if own_conn:
            conn.close()


def acknowledge_graduations(ids: list[str], conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    """Mark ward-block graduation mentions as seen."""
    if not ids:
        return {"ok": True, "acknowledged": 0}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        placeholders = ",".join("?" * len(ids))
        with conn:
            result = conn.execute(
                f"UPDATE graduation_log SET acknowledged=1 WHERE id IN ({placeholders})",
                list(ids),
            )
        return {"ok": True, "acknowledged": result.rowcount}
    finally:
        if own_conn:
            conn.close()
