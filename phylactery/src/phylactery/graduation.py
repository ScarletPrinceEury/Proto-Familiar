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
"""

from __future__ import annotations

import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from typing import Any

from phylactery.care import CARE_CATEGORIES, contains_care_critical  # noqa: F401 (re-exported)
from phylactery.db import get_conn, insert_with_slug_retry, now_iso
from phylactery.snapshot import auto_snapshot

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
    rows = conn.execute(
        "SELECT id, category, filename, content, care_weight, updated_at, last_graduated_at "
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
    return f"""I am the Familiar. I'm tidying my always-injected identity so it stays about who I am and the shape of us, and stays lean: anything that doesn't need to be in front of me every turn moves into my standing facts (register: {register}), which come back to me when they're relevant. Nothing is deleted.

{_KEEP_GUIDANCE.get(category, _KEEP_GUIDANCE['custom'])}
{size_line}

Here is the current content of {category}/{filename}:

---
{content}
---

I return ONLY a JSON object, no prose, no fences:
{{
  "graduate": [
    {{ "summary": "<short label of what I'm filing away>", "content": "<the detail, in my own first-person voice>" }}
  ],
  "kept_content": "<the full content I want to KEEP on the always-injected surface, rewritten cleanly>"
}}

If nothing should be filed away right now, I return {{ "graduate": [], "kept_content": <unchanged content> }}."""


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
    """Review eligible identity blocks and graduate no-longer-front-of-mind detail.

    `cfg` + `call_llm(cfg, prompt) -> str` are injected so this shares the
    consolidation pass's designated-connection call (no new request stream).
    Snapshots before any identity trim. Returns a summary of what graduated.
    """
    from phylactery.memory import create as memory_create

    now = now or datetime.now(timezone.utc)
    candidates = eligible_identity_files(conn, now)
    if not candidates:
        return {"ok": True, "graduated": 0, "reviewed": 0}

    snapshotted = False
    graduated_total = 0
    details: list[dict] = []

    for cand in candidates:
        try:
            raw = call_llm(cfg, _audit_prompt(cand["category"], cand["filename"], cand["content"], cand.get("target_chars")))
        except Exception as e:
            details.append({"file": cand["filename"], "error": f"llm: {e}"})
            continue
        parsed = _parse_audit(raw)
        if not parsed or not isinstance(parsed.get("graduate"), list):
            continue
        to_graduate = [g for g in parsed["graduate"]
                       if isinstance(g, dict) and (g.get("content") or "").strip()]
        if not to_graduate:
            continue

        if not snapshotted:
            auto_snapshot(conn)
            snapshotted = True

        register = _register_for(cand["category"])
        all_stored = True   # did EVERY item actually land in memory?
        for item in to_graduate:
            # Care details about my human leave identity too (ward decision
            # 0.14.70), but as HIGH-CARE standing facts: the care block puts them
            # in front of me on my human's own turns, in triage and in noticing.
            # Code decides this from the content — the audit can't downgrade it.
            care = "high" if register == "ward" and contains_care_critical(item.get("content")) else None
            res = memory_create(
                item["content"], granularity="significant",
                source_author="proto-familiar",
                category=None, audience="ward-private", conn=conn,
                register=register, care_weight=care,
            )
            mem_id = res.get("id") if res.get("ok") else None
            if not mem_id:
                # A failed create must NOT lead to trimming the identity file
                # below — that would delete the only copy of a fact that was
                # never stored ("graduated facts aren't deleted"). Don't log it
                # to the graduation_log or count it; mark the candidate not fully
                # graduated so the trim is withheld and the next pass retries.
                all_stored = False
                print(
                    f"[graduation] memory_create failed for a '{cand['category']}' item "
                    f"({res.get('error')}) — leaving identity intact, will retry next pass",
                    file=sys.stderr,
                )
                continue
            summary = (item.get("summary") or item["content"])[:120]
            with conn:
                # Slug id (summary-derived) — the notice block surfaces this id
                # and the Familiar repeats it into graduation_acknowledge, so it
                # follows the readable-id convention like memories/graph nodes.
                insert_with_slug_retry(
                    conn,
                    "INSERT INTO graduation_log(id, source_category, source_filename, memory_id, "
                    "register, summary, acknowledged, created_at) VALUES (?,?,?,?,?,?,0,?)",
                    lambda gid: (gid, cand["category"], cand["filename"], mem_id, register, summary, now_iso()),
                    label=summary, kind="grad",
                )
            graduated_total += 1
            details.append({"file": cand["filename"], "register": register, "summary": summary})

        # Trim the identity file ONLY when every item was actually stored. On a
        # failure we leave the file — content AND last_graduated_at — untouched,
        # so the candidate is re-selected and retried rather than silently losing
        # the un-stored detail (kept_content assumes a full graduation, so even a
        # partial trim could drop exactly the item that failed to store).
        if all_stored:
            kept = parsed.get("kept_content")
            if isinstance(kept, str) and kept.strip() and kept.strip() != (cand["content"] or "").strip():
                with conn:
                    conn.execute(
                        "UPDATE identity_files SET content=?, updated_at=?, last_graduated_at=? WHERE id=?",
                        (kept.strip(), now_iso(), now_iso(), cand["id"]),
                    )
            else:
                with conn:
                    conn.execute(
                        "UPDATE identity_files SET last_graduated_at=? WHERE id=?",
                        (now_iso(), cand["id"]),
                    )

    return {"ok": True, "graduated": graduated_total, "reviewed": len(candidates), "details": details}


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
