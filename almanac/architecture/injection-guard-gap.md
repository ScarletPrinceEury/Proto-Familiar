---
title: "Injection Guard: Documented but Never Wired"
topics: [architecture, safety]
sources:
  - id: injection-guard
    type: file
    path: injection-guard.js
  - id: injection-guard-tests
    type: file
    path: tests/injection-guard.test.mjs
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: architecture-doc
    type: file
    path: docs/architecture.md
---

# Injection Guard: Documented but Never Wired

**Status: open defect, found in the 0.8.55 codebase audit. Flagged to the maintainer; wiring
it is a design decision that has not been made yet.**

`injection-guard.js` exports a real, tested pattern scanner and sanitizer
(`scanForInjection`, `sanitizeExternal`) with a full unit-test file covering instruction-
override phrases, fake system markers, and per-source contexts [@injection-guard]
[@injection-guard-tests]. `CLAUDE.md`'s file table describes it as "pattern scanner +
sanitizer applied at every external-data boundary" [@claude-md], and `docs/architecture.md`
repeats the same claim [@architecture-doc]. The
[trust-tiers decision](../decisions/trust-tiers-gate-reads-not-writes) discusses it as one of
the repo's real defenses.

**None of that is true at runtime.** A history-wide search
(`git log --all -S 'sanitizeExternal' -- <runtime files>`) returns nothing: no runtime module
has ever imported or called either export, in any commit. The only consumer is the test file.
The module was built, tested, and documented — and the wiring step never happened. Its only
trace in runtime code is a comment in the triage prompt assembly explaining why the guard is
deliberately *not* applied to the ward's own words ("the injection guard is for third-party
external data, not words my human has said") — a correct scoping decision for a defense that,
as of this writing, runs nowhere.

## Why this matters more than ordinary dead code

This is the exact failure `CLAUDE.md`'s capability-reachability rule names as "dead code that
looks like care," but on the *defensive* side: three layers of documentation assert a
protection that does not exist, so every later design conversation (including the vision and
browser build specs, which both lean on "passes through injection-guard.js" as a mitigation)
inherited a false premise. External data currently reaching prompts unsanitized includes at
minimum: web page extractions (`read_webpage`/`web_search` results), Discord villager and
stranger message content, gcal-synced event titles, and villager-authored memory content
surfaced on recall.

## What wiring it needs (the open design questions)

Where to apply it is not mechanical — the boundaries differ in risk and in cost-of-mangling:

1. **Web reads** are the broadest surface and the clearest win (third-party text, no dignity
   cost to sanitizing).
2. **Villager/stranger Discord content** is external but is also *conversation* — sanitizing
   it can distort what a villager actually said, and the audience-gating + provenance systems
   already carry part of this load structurally.
3. **The ward's own words are exempt by design** (the triage comment above records why:
   replacing a ward's distress phrasing with `[removed: …]` could cause the triage LLM to
   dismiss genuine crisis as a jailbreak attempt).

Until the maintainer decides, the honest state is: the guard's protection is *aspirational*,
and prompt-injection defense currently rests on the structural systems (audience gating,
fail-closed read scoping, provenance labels, code-gated actions) rather than on text
sanitization.

## Related

- [Trust tiers gate reads, not writes](../decisions/trust-tiers-gate-reads-not-writes) — the
  page that treats pattern filtering as explicitly *insufficient* on the write side; this gap
  means even the read-side pattern layer it contrasts against was not actually running.
- [Engineering conventions](../reference/engineering-conventions) — the capability-
  reachability rule this defect is the defensive-side mirror of.
