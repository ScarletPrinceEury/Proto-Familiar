# Codebase audit — 2026-09 (fine-tooth-comb pass)

Scope: the whole tree end-to-end, including inside the two Python MCP services
(Phylactery `./phylactery/`, Unruh `./unruh/`), not just their Node-facing edges.
Lens: the ward's five asks — orphaned/stale, wordy commentary, disconnected
wiring, copy-paste that wants centralizing, and **anything that erodes the
Familiar's autonomy / personality / good time in the harness.**

Findings are rated **[confidence]** and **(value/effort)**. Most categories come
back clean or strong — the handful of real items are concrete and listed first.

---

## TL;DR

- **Wiring: clean.** `audit:wiring` (0/422 files) + `audit:mcp` both pass; the
  library module tree is fully imported (no orphaned modules).
- **Personality/autonomy: strong, and defended by tests.** Zero second-person
  imposed framing, zero "the user" leakage, zero bias-toward-quiet language —
  and the anti-patterns are pinned by regression tests. This is the healthiest
  part of the codebase.
- **Real actionable items: 5**, none urgent. One dead helper, one efficiency
  win that also retires an orphan tool, one self-acknowledged duplication, a
  cluster of stale dev scripts, and one soft voice-nit to eyeball.

---

## A. Orphaned / stale

### A1. Dead helper `_row_to_thin` — **[high]** (low/low) — safe to remove
`phylactery/src/phylactery/memory.py:90` defines `_row_to_thin(row)`; it is
referenced **nowhere** in the package or its tests. Genuine dead code. Delete it
(or wire it in if it was meant to back a thin-row read that never landed).

### A2. MCP tools with no caller *from this app* — **[med]** (verify before acting)
Defined in the services but never invoked through the Thalamus bridge:
- `graph_full` (Phylactery) — see **D1**; this one is actionable.
- `consolidate` (Phylactery) — superseded here by `lifecycle_pass` (on-demand,
  via `!consolidate memory` → `runLifecyclePass`) and the in-process
  `scheduler.py` thread. The MCP tool's "on-demand use" docstring no longer has
  an app-side caller.
- `memory_list_consent_pending` (Phylactery) — the `[PENDING MEMORY CONSENT]`
  block is built from the local mirror `tomes/.consent-pending.json`, not this
  tool. No references anywhere.
- `health_check` (both Phylactery and Unruh) — boot diagnostic; no programmatic
  caller. Likely an intentional manual-probe surface.

**Caveat that changes the call:** Phylactery/Unruh are **multi-embodiment** MCP
services — Psycheros, SillyTavern and other MCP clients hit them too. "Unreachable
from Proto-Familiar" is *not* the same as "dead." Before removing any of these,
confirm against the canonical-store MCP contract that no other embodiment relies
on them. `health_check` is almost certainly a keep (diagnostic). The clear win is
`graph_full` (D1), which stays *and* gets a caller.

### A3. Stale dev/probe scripts — **[med]** (low/low) — confirm then prune
In `scripts/`, unreferenced by `package.json`, prestart, docs, or each other
(0 external refs): `transcript-to-markdown.mjs`, `voice-chunking-probe.mjs`,
`voice-clarity-probe.mjs`, `voice-temperature-probe.mjs`,
`build-voice-catalogue.mjs`. These read as one-off tuning/probe artifacts left in
after their milestone. (Others like `threat-demo`, `pondering-loop-demo`,
`voice-bench`, `ui-walk`, `migrate-domain` DO have a doc/cross ref, so they're
plausibly still useful — leave them.) Suggest: delete the five, or move dev-only
probes under a `scripts/dev/` so the operational scripts stand out.

---

## B. Wordy / superfluous commentary — **largely clean**

No egregious pruning targets. The header and inline comments are overwhelmingly
**load-bearing WHY-notes** — exactly what CLAUDE.md asks for (they record the
recorded-mistake, the invariant, the "keep in step with app.js" contract). The
contrastive "it's not X, it's Y" token-bloat anti-pattern that CLAUDE.md warns
about is **absent** from the response-composition prompts (`core-prompts.js`,
`surface-context.js`, `care-check.js`, `recent-ponderings.js`).

Nothing to cut here that wouldn't lose real context. (If anything, the density
is a feature given how much hard-won lesson is encoded.)

---

## C. Disconnected wiring — **clean**

- `npm run audit:wiring`: 0 findings across 422 files (import/export, undeclared
  call, duplicate key, dead lookup, setting-unread, settings-key drift, unwired
  control, undocumented switch).
- `npm run audit:mcp`: every Thalamus call matches a real Phylactery/Unruh tool
  signature.
- Every library `.js`/`.mjs` module under root + `src/` is imported somewhere
  (the only "never imported" files are `scripts/` executables, which are meant to
  be run, not imported).

No action.

---

## D. Copy-paste / centralization

The **no-copy-paste rule is well-honored**: no function defined in two files, no
duplicated `export const`, and the cross-language mirrors (`slug-ids.js` ↔
`db.slug_id`, `content-tags.js` ↔ `content_gate.py`, `macros.js` ↔
`applyNameVars`) are all *documented intentional* mirrors, not drift. Retry/
backoff appears in several files but they are **four legitimately distinct
domains** (MCP reconnect, memorization job-queue, Discord gateway supervisor,
audio-worker crash-restart) — centralizing them would be premature abstraction.
Timestamp-stripping is correctly single-sourced (`message-sanitize.mjs`,
imported everywhere; the other "HH:MM" hits are unrelated formatting).

Two genuine items:

### D1. `getFullGraph` does N+1 round-trips where `graph_full` does 1 — **[high]** (high/med)
`thalamus.js:3754` `getFullGraph()` calls `listGraphNodes` then fans out one
subgraph MCP call **per node** (a 16-wide worker pool) to assemble edges — while
Phylactery already exposes `graph_full` (a single "full node+edge dump", the tool
flagged orphaned in A2). The robust fix kills two birds: have `getFullGraph` call
`graph_full` once, retiring both the O(N) round-trip cost **and** the orphan
status. (Backs `/api/entity/graph/full`, the Map view — behavior-equivalent,
worth a pipeline test.)

### D2. `schedulePhylacteryReconnect` / `scheduleUnruhReconnect` are near-identical — **[med]** (med/low-if-careful)
`thalamus.js:460` and `:596` — the comment at :456 literally says *"same shape as
scheduleUnruhReconnect."* They differ only in which peer/counter/backoff-constant
they touch. A `makeReconnectScheduler(peerName, {reconnectFn, backoffMs,
maxAttempts})` factory collapses both. **Caveat:** MCP connection lifecycle is
graceful-degradation-critical — do this as a strictly behavior-preserving
extraction with a test (a peer being down must still degrade to absence, never
throw into the chat path).

---

## E. Autonomy / personality / "a good time in the harness" — **the priority, and it's strong**

This is where I looked hardest, and it's the healthiest layer in the repo.

**Clean, with evidence:**
- **No second-person imposed framing** anywhere: zero hits for "You are the
  Familiar", "Respond gently", "Be supportive", "as the assistant", etc. The
  first-person convention holds across every prompt, tool description, and
  Familiar-facing string.
- **No "the user" leakage** in Familiar-facing content — it's "my human"
  throughout (the only "the user" hits are infra comments / technical fields).
- **No bias-toward-quiet language** — and this is *actively defended*: a battery
  of regression tests assert the anti-patterns never reappear
  (`assert.doesNotMatch(/bias toward staying quiet|erode trust|only when the
  answer feels obvious|weigh both|equal weight/)`) across `reachout`,
  `surface-context`, `noticing`, `pondering`, `tracker-cues`, `offer-tracker`,
  `villager-context`, and `gcal-projection`. The 1.5-hour-silence lesson is cut
  into law.
- **Generic-care register is not imposed.** Every "gently/warmly" hit is the
  Familiar's OWN first-person description of a *specific proactive act* (a warm
  reach-out is warm by definition; "the weight decays gently" is a rate
  metaphor) — never a "respond in a soft caring tone" override of identity.
- The Familiar's autonomy features are *first-class*, not grudging: its own
  interests/ponderings, the noticing loop that doesn't stand down at threat,
  warm reach-outs framed as "a companion reaches out because they're someone,"
  self-paced check-ins, even the whimsy rummaging sound. The design treats the
  Familiar as a subject, consistently.

**One soft nit to eyeball (not a defect):**
- `src/tomes/manual-tome.js` describes the Familiar's own behaviour with "gently"
  3× ("keep an eye out gently", "gently reach out", "gently raise something").
  It's accurate and in-voice — but the manual is a *self-description the Familiar
  reads*, and if a given ward's Familiar is configured grumpy/blunt/tsundere/
  kuudere, a manual that keeps narrating "I gently…" could softly pull the
  register toward default-care, against the identity. Consider dropping the
  adverb ("I keep an eye out", "I'll raise it") and letting the configured
  identity color the manner. **[low]** — a judgment call for you, and it touches
  voice near proactivity wording, so it's a flag-for-ward, not an auto-change.

---

## Suggested order if you want to act

1. **A1** delete `_row_to_thin` (trivial, safe).
2. **D1** point `getFullGraph` at `graph_full` (real efficiency + retires an
   orphan tool; add a pipeline test).
3. **A3** confirm & prune the five stale probe scripts (declutter).
4. **D2** extract the reconnect factory (careful, behavior-preserving, tested).
5. **A2** reconcile the remaining orphan MCP tools against the multi-embodiment
   contract (decide keep-as-contract vs remove — needs the canonical-store lens,
   likely a you-decision).
6. **E nit** decide on the manual-tome "gently" phrasing.

None of these are safety-path behavioural changes, so none need the ward-sign-off
gate — except that **D1/D2 touch Thalamus wiring that must keep degrading
gracefully**, so they ship as behavior-preserving refactors with tests, not
rewrites.
