---
title: Engineering Conventions
topics: [reference]
sources:
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: app-js
    type: file
    path: public/app.js
  - id: audit-mcp-script
    type: file
    path: scripts/audit-mcp-contracts.mjs
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: mcp-contracts-test
    type: file
    path: tests/mcp-contracts.test.mjs
  - id: thalamus
    type: file
    path: thalamus.js
  - id: phylactery-result
    type: file
    path: phylactery-result.js
  - id: mcp-smoke-test
    type: file
    path: tests/mcp-smoke.test.mjs
  - id: llm-call-js
    type: file
    path: llm-call.js
  - id: voice-transcribe-js
    type: file
    path: src/voice/voice-transcribe.js
  - id: tome-macros-js
    type: file
    path: src/tomes/tome-macros.js
  - id: build-prompt-catalog
    type: file
    path: scripts/build-prompt-catalog.mjs
  - id: consolidate-module
    type: file
    path: phylactery/src/phylactery/consolidate.py
  - id: prompt-catalog-test
    type: file
    path: tests/prompt-catalog.test.mjs
  - id: crisis-classifier
    type: file
    path: src/safety/crisis-classifier.js
  - id: crisis-classifier-test
    type: file
    path: tests/crisis-classifier.test.mjs
  - id: message-sanitize
    type: file
    path: message-sanitize.mjs
  - id: server-js
    type: file
    path: server.js
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
  - id: collapse-tool-turns-test
    type: file
    path: tests/collapse-tool-turns.test.mjs
  - id: pondering-consolidate-js
    type: file
    path: src/pondering/pondering-consolidate.js
  - id: voice-chat-turn-js
    type: file
    path: src/voice/voice-chat-turn.js
  - id: settings-store-js
    type: file
    path: settings-store.js
  - id: contact-baselines-js
    type: file
    path: src/safety/contact-baselines.js
  - id: wait-streak-js
    type: file
    path: src/safety/wait-streak.js
  - id: audit-wiring-script
    type: file
    path: scripts/audit-wiring.mjs
  - id: voice-notes-test
    type: file
    path: tests/voice-notes.test.mjs
  - id: resolve-uv
    type: file
    path: scripts/lib/resolve-uv.mjs
  - id: json-state
    type: file
    path: src/util/json-state.js
  - id: core-prompts
    type: file
    path: core-prompts.js
  - id: guide-chat
    type: file
    path: guide-chat.js
  - id: memorization
    type: file
    path: src/memory/memorization.js
  - id: injection-guard
    type: file
    path: injection-guard.js
  - id: own-files
    type: file
    path: own-files.js
  - id: excerpt-js
    type: file
    path: src/util/excerpt.js
  - id: hippocampus-js
    type: file
    path: src/memory/hippocampus.js
  - id: memory-module
    type: file
    path: phylactery/src/phylactery/memory.py
  - id: excerpt-test
    type: file
    path: tests/excerpt.test.mjs
---

# Engineering Conventions

This page is a lookup reference for the repo-wide operating rules recorded in `CLAUDE.md`
that apply across every component, not just one subsystem. Use it to check a specific
convention before making a change; use [Architecture](../architecture) for how the
components these rules govern actually fit together. Some rules below name a file by its bare
basename (`cerebellum.js`, `thalamus.js`, `llm-call.js`) because those files still live at the
repository root; others (`voice-transcribe.js`, `tome-macros.js`) moved under `src/<domain>/`
during the Stage 1 reorganization — see
[Domain folder layout](../decisions/domain-folder-layout) for which files stayed and which
moved.

## Versioning

`package.json`'s `version` field is the single source of truth. The server reads it once at
boot and exposes it via `/api/health`, `/api/version`, the startup banner, and the sidebar
UI badge — the version must not be hard-coded anywhere else [@claude-md].

| Change | Bump |
|---|---|
| Bug fix, copy edit, dependency pin, doc tweak | patch |
| New user-visible feature, behavioral change, UX rework, new endpoint | minor |
| Breaking API/storage change, removed feature, format migration | major |
| Graduate from pre-release | drop the `-alpha` suffix |

Format while in alpha: `MAJOR.MINOR.PATCH-alpha` [@claude-md]. The version bump happens in
the same commit as the change it describes. If a change's bump is ambiguous between patch and
minor, prefer minor — it is cheaper than a wrong "patch" label shipping [@claude-md].

**One milestone = one minor.** The minor number names a milestone (0.2 = pre-Unruh, 0.3 =
Unruh, 0.4 = Cerebellum), not a count of shipped features — multiple sub-features of the same
milestone share one minor bump and land as patches within it [@claude-md]. During a
long-running feature branch that is the sole reason the minor slot is being held, ancillary
work on that branch bumps patch only; the branch name signals which feature owns the next
minor [@claude-md].

## Robust over cheap

The priority order for any proposal or implementation, in order, is robust (handles the
problem space, not just the symptom that triggered the report), sustainable (no
tribal-knowledge workarounds; state that should persist, persists), and user-accessible (the
bonded human and the Familiar can both see, reason about, and adjust the result through
surfaces they can reach) [@claude-md].

Named anti-patterns to avoid in framing a proposal: "the cheapest meaningful fix is…",
"surgical minimum…", "smallest change that closes the symptom…", "quick patch for now,
revisit later" (later rarely comes), "we can defer the harder version" (sometimes correct,
often a cover for the lazy option), and leading with token/line-count as the primary virtue
rather than a side-effect of clarity [@claude-md]. The default frame offered to the human
must be the robust one, named explicitly — not buried under "but the cheap version is also
possible" as if the two were equivalent [@claude-md].

## Fix the root cause, not the symptom

When a bug traces back to a function's architecture, rewrite the function rather than
stacking an extra condition on top of already-tangled logic. A clean rewrite is usually
shorter and less likely to introduce a new bug than a patch welded onto a broken shape
[@claude-md].

## No copy-paste of substantial logic

Never copy-paste a non-trivial code block across files; extract a shared helper instead. The
threshold is judgment, not a line count — a few genuinely parallel-but-distinct lines are
fine, a copy-pasted helper function is not [@claude-md]. Extracting a shared abstraction once
real duplication exists is the correction of a structural mistake, not premature abstraction;
inventing the abstraction *before* the duplication exists is the anti-pattern to avoid
[@claude-md]. See [Installer and launcher](../architecture/installer-and-launcher) for a
worked example: stale-instance port recycling lives once in
`scripts/ensure-port-free.mjs` rather than being copy-pasted across the shell launchers. See
[Pondering](../architecture/pondering)'s yearly-tier section (0.12.26) for a second worked
example on the other side of the same rule: adding a yearly consolidation tier alongside the
existing monthly one was built as one tier-parameterized engine (`selectTierTarget` /
`consolidateTier`, driven by a small tier-descriptor object) rather than a second copy-pasted
fold function, with the monthly tier's own exports rewritten as thin wrappers over the shared
engine so its public contract did not change [@pondering-consolidate-js].

A late-September 2026 pass found and fixed three more instances of the same mistake, all with
the same shape: logic that should exist once had quietly drifted into two or three places that
had to be kept in sync by hand.

- **`resolveUv()`** (find the `uv` binary across the install locations Astral's installer uses)
  existed as three byte-identical copies — in `ensure-phylactery-deps.mjs`, in
  `ensure-unruh-deps.mjs`, and as `thalamus.js`'s own `resolveUvBinary()` — with one copy's
  comment literally saying "Mirror thalamus.js's resolveUvBinary()" as an acknowledgment of the
  duplication rather than a fix for it. It is now one `resolveUv()` in
  `scripts/lib/resolve-uv.mjs`, imported by all three call sites; `thalamus.js` kept its own
  comment at the import site explaining the GUI-launcher/ENOENT rationale that is specific to
  its `StdioClientTransport` use and not captured by the generic helper [@resolve-uv].
- **`readJsonStateSync`** — six separate modules each hand-rolled the same "parse a JSON file,
  never throw, fall back on missing/corrupt/non-object" dance for their own sync state file
  (voice clips catalogue, call-engine active-call check, browser page watches, the weather
  mirror, the pondering web budget, and `wait-streak.js`'s streak tally). `json-state.js`
  already owned an async version, `readJsonState`; this added the sync sibling
  `readJsonStateSync(file, fallback)` with the identical contract, so all six callers adopted
  one tested implementation instead of six subtly-varying inline `try`/`catch` blocks
  [@json-state]. The `wait-streak.js` adoption was deliberately scoped as behavior-preserving
  only — it is a `src/safety/` file (see the Safety-critical sign-off rule below), and the
  change touches only the streak-tally file read, not any gate or threshold.
- **The ward-field framing** (the `[Character Profile]`/`[Human Profile]` block: headers, field
  order, and the `'\n\n---\n\n'` join) was assembled independently in `core-prompts.js`'s
  `coreSystemSegment` (the server chat path) and in `guide-chat.js`'s `buildGuideSystem` (the
  settings web-search guide) — the two had to be kept matching by hand, and a header rename in
  one would silently diverge the other. The un-substituted assembly is now a single
  `coreFieldsBlock(settings)` in `core-prompts.js`; `coreSystemSegment` calls it and substitutes
  macros over the result, and `guide-chat.js` imports it and folds it into its own larger
  assembly before substituting once over the whole thing, so no caller double-substitutes
  macros [@core-prompts] [@guide-chat].

Recomputing the same thing inside one call site, every time it runs, is the same waste as
copy-pasting logic across files — it just costs cycles instead of maintenance risk.
`injection-guard.js`'s `sanitizeExternal` used to rebuild all 13 of its global-flagged
detection regexes with `new RegExp(...)` on every call, on every inbound web/Discord message;
they are now precomputed once at module load as `INJECTION_PATTERNS_G`, which is safe because
`String.replace` resets a global regex's own `lastIndex` on each call [@injection-guard].
`own-files.js`'s `readOwnFile` used to call `stat` twice — once to size the read cap, again only
to compute `truncated` — when the first stat's size already answers both questions; it now
stats once and reuses the result, which is also more correct, since a second stat could observe
a different size if the file changed between the two calls [@own-files].

## Modular by default; orchestration files are the exception

New logic defaults to a focused module. `cerebellum.js` and `thalamus.js` are deliberately
wide because they are the system's connective tissue — that width is appropriate
architecture, not a single-responsibility violation, and should not be reflexively split. But
unrelated logic that could live in its own file should not be piled into them either
[@claude-md]. See [Architecture](../architecture) for what each of those two files actually
owns.

The same judgment applies one level down, inside a single wide function: split off the
self-contained sub-steps, but keep the true connective spine intact. `processJob` in
`src/memory/memorization.js` — the ~400-line memorization orchestrator — had four genuinely
self-contained, narrow-surface concerns (building the name/alias lookup, filing deferred
session follow-ups, logging passive tracker observations, and routing extracted relations to
the graph) pulled out into named module-level helpers (`buildByNameLookup`,
`createSessionFollowups`, `logTrackerObservations`, `routeRelationsToGraph`), each independently
testable and each already covered by its own pipeline test [@memorization]. The per-fact loop
itself was deliberately **not** extracted: it reads about ten shared-state values, mutates
`created`/`pendingConsent` across iterations, is the function's true connective spine, and has
a recorded crash history of its own. Splitting it for symmetry would have added regression
surface for a readability gain that is low compared to the risk — the same reasoning that keeps
`cerebellum.js` and `thalamus.js` whole above, applied to a single function rather than a file.

## Ride existing requests; gate in code

Every LLM request costs tokens and latency, and a system that adds a new standalone request
per feature inflates linearly with capability. The order of operations for any feature that
needs LLM judgment [@claude-md]:

1. Can a hard gate in cheap code handle it? Threat tier, quiet hours, dedup windows,
   time-of-day filters, and pattern-match classification answer most "should this happen?"
   questions for free — the LLM should only see candidates that survived the gates.
2. Can the judgment ride an existing LLM call (a chat turn, a pondering tick, a
   silence-triage check, a reminder composition) instead of spinning out a new one?
3. Only if neither works, add a new request — and give it a self-set cool-down (the
   silence-triage `nextCheckInMs` pattern) so it does not fire on a fixed cadence regardless
   of need.

Pure-code tagging beats LLM classification when the labels are crisp (engaged / ignored /
deferred / completed); the LLM is reserved for interpreting patterns across many tagged
events, not for labeling each one individually [@claude-md]. See
[Safety spine](../architecture/safety-spine) for this rule applied to crisis detection.

## Every capability must be reachable by the Familiar

A tool the Familiar cannot discover, or whose required inputs it cannot obtain, is not a
capability — CLAUDE.md calls it "dead code that looks like care" [@claude-md]. Shipping a new
tool, background action, or power requires both halves, in the same commit:

1. **Discoverability** — a bound tool's first-person description is the baseline; anything
   gated, conditional, multi-step, or behind another surface needs an explicit home in
   something the Familiar reads (identity, injected context, a tome, the relevant prompt)
   [@claude-md].
2. **Operability** — every required argument must be obtainable from a surface the Familiar
   actually has. The worked example: `mem_delete(id)` is real because the id rides in on a
   prior `recall`/search result, never something the Familiar has to invent or memorize
   [@claude-md].

## Console↔UI parity for ward commands

A ward-facing Discord/console command is never the only way to reach a capability — it ships
with a UI control for the same action, in the same commit, and vice versa [@claude-md]. The
convention was named in 0.12.19-alpha, with the on-demand consolidation triggers as the
reference case: `!consolidate ponderings`/`!consolidate memory` each have a matching "Fold
ponderings"/"Roll up memories" button in the web UI's Automation pane, both routed through the
same server function so there is one source of truth, not three drifting copies [@server-js]
[@discord-gateway-js]. See [Pondering](../architecture/pondering)'s on-demand consolidation
section for the worked example. When adding a new ward console command, add its UI twin in the
same change; an existing command found with no UI counterpart is a gap to close, not a pattern
to copy [@claude-md].

## Graceful degradation

No module may be able to take down the chat path — a peer being down, a loop crashing, or a
tool throwing must never surface as an error in the human's conversation; absence renders as
absence [@claude-md]. Every new background loop ships with a hard off-switch env var in the
same commit. Every new peer or channel adapter must fail independently, so one bad adapter or
MCP peer never takes another one's context or delivery down with it. Failures that matter
must be observable — delivery state recorded on the item, triage decisions logged, degraded
peers logging loudly at boot — because silent failure is exactly the failure mode this rule
exists to prevent [@claude-md]. See [Architecture](../architecture) and
[Autonomous loops](../architecture/autonomous-loops) for where this is implemented. A stalled
`await` — rather than a thrown error — is the sharpest version of this rule: a provider call
that never settles can hold a Discord room's turn queue, a background loop's tick guard, or an
HTTP response open indefinitely with nothing to log, because nothing ever throws. See
[Stall resilience](../architecture/stall-resilience) for the deadlines and watchdogs that bound
every such await, and why none of them can truly cancel slow work — only stop waiting on it.

## Token-conscious operation

The human running a coding session has a fixed weekly token budget; anything that returns
output into the agent's context (`Bash`, `WebSearch`, `WebFetch`, `Read`) costs them.
CLAUDE.md's guidance: spend tokens verifying something that could plausibly be wrong, not
something that obviously has not changed [@claude-md]. Run the test suite when runtime code,
an import/API shape, or test code itself changed, or when verifying a bug the human just
reported; skip it for doc-only changes, a comment or unassessed string, or a version-only
bump [@claude-md].

## Macro substitution boundaries

`{{user}}` and `{{char}}` are authored as literal tokens in prompts and tool descriptions and
resolved to configured names by `macros.js`'s `substituteMacros` at exactly three
server-side boundaries, enumerated so a fourth is never added ad hoc [@claude-md]:

1. LLM prompts, at each call site of a standalone prompt (triage, warm reach-out, pondering,
   tome-graduation, guide-chat).
2. Tool results, applied blanket at `executeToolCall`'s result boundary.
3. Tool descriptions, applied by `composeActiveTools` before the tool list reaches the
   provider.

Server-injected static/dynamic context blocks (identity, temporal context, the
`[CARE CHECK]` block, presence) bypass all three boundaries deliberately and author the
literal string "my human" instead of a macro token, because those blocks are assembled and
injected directly by `server.js`/`thalamus.js`/`temporal-format.js` rather than passed
through a macro-substitution call site [@claude-md]. Reintroducing a macro token into one of
those blocks is a regression CLAUDE.md records having already fixed once (the 0.7.83 audit).

Tome (lorebook) content is a fourth, deliberately named exception to the closed three-boundary
list above, added in 0.11.22-alpha: `tome-macros.js`'s `resolveTomeMacros(text, settings)`
resolves `{{user}}`/`{{char}}` plus a set of toggle and value macros inside injected Tome
entries specifically, because a lorebook entry can describe live ward-facing state and is only
accurate if resolved at injection time rather than at authoring time [@tome-macros-js]. See
[Tomes and keyword lore](../architecture/tomes-and-lore) for the full macro table, why toggle
macros read the ward-facing setting rather than the deployment env off-switch, and the
self-documenting Familiar Manual tome this boundary exists to serve.

The browser's own prompt assembly is a separate implementation of the same boundary-1
principle: `public/app.js`'s `applyNameVars` resolves `{{user}}` and `{{char}}`, plus two
time macros, `{{elapsedTime}}` and `{{timeSinceLastSession}}`, at every segment
`buildApiMessages` feeds into the main chat request (system prompt, character profile, user
profile, post-history prompt, and injected history entries) [@app-js]. It is a distinct
function from `macros.js`'s `substituteMacros`, not a client mirror of it, and it is the only
place either time macro is resolved. See
[Elapsed-time macros read stored history, not Date.now()](../decisions/time-macros) for why
`{{elapsedTime}}` and `{{timeSinceLastSession}}` each anchor their gap differently.

## Tool-call scaffolding is turn-internal — collapse it before history re-enters the model

A turn that used tools is stored on disk as several messages, not one: an assistant
**carrier** — often `content: null`, sometimes a mid-sentence preamble like "Let me
check—" — carrying `tool_calls`, then the `role: 'tool'` results, then the final reply
[@message-sanitize]. That whole run is scaffolding for a single reply. Re-injecting it
verbatim as history on a later turn broke both web and Discord (0.12.4-alpha): the model
read its own past turn as `null` (the null carrier) or as a sentence that stops mid-thought
(the preamble carrier, split from the answer it belonged to), even though the human received
the reply whole. On Discord a null carrier rendered as the literal string `[HH:MM] null`
once a machine timestamp was prepended. Unified sessions (see
[Unified ward sessions](../architecture/session-unification)) carry web-origin carriers onto
the Discord side too, so both surfaces hit the bug from either origin [@message-sanitize].

**The rule:** before conversation history reaches the model, collapse each tool-scaffolding
run into the single clean assistant turn it represents. `message-sanitize.mjs` exports
`collapseToolTurns(messages)`: it drops `role: 'tool'` results, drops the `tool_calls` field,
and MERGES a carrier with the reply it precedes so all the text the human actually saw
survives as one coherent turn; it drops empty assistant turns, and it never merges two
genuinely independent assistant messages (for example a proactive banner with no `tool_calls`
and no tool run between it and the next reply) [@message-sanitize] [@collapse-tool-turns-test].
`tool_calls` and the tool results are stripped **together**, so no dangling tool-call
reference ever reaches a provider on a later call.

`collapseToolTurns` is applied at every provider-history boundary that re-reads stored
messages: `server.js`'s `/api/chat` handler (covering both web and voice, ahead of
`withCorePrompts` — see [Core prompts and multi-surface assembly](../architecture/core-prompts))
and both Discord history-assembly `.map()` sites in `discord-gateway.js` (the live-turn path
and the cached-revisit path) [@server-js] [@discord-gateway-js]. The current turn's own tool
loop is untouched — it runs server-side from live results, not from re-injected history, so
only earlier turns are cleaned. Memorization (`filterReadable`/`buildExtractionMessages`) and
the deliberation readers (`getRecentSessionMessages`/`formatRecentMessagesForContext`) already
skipped carriers on their own (a `tool_calls`-length check plus a non-empty-string content
filter), so they were never affected by the bug and did not need this helper [@message-sanitize].

**Generalization:** this is the same family as the `stripLlmTimestamps` rule in
[Exact values are code's job](../decisions/exact-values-in-code) — clean contaminated content
at the boundary where stored history re-enters the model, not only at the point it is
rendered or stored — applied here to message *shape* (scaffolding fields) rather than to a
hallucinated value inside the text. Any new path that feeds stored session history back to a
model must run it through `collapseToolTurns` first, the same way any new path that delivers
LLM output outward must apply `stripLlmTimestamps`.

## A throw partway through `init()` silently disables every later listener

`public/app.js`'s `init()` wires up every UI control in one long top-to-bottom function: settings
fields, chat buttons, the prompt inspector, the logs modal, the topic system, the tomes modal, and
more, each via `$('some-btn').addEventListener('click', someHandler)` [@app-js]. `addEventListener`
resolves its handler argument at the moment that line executes, not when the enclosing function was
defined. If a handler name referenced on an earlier line does not exist yet, the browser throws an
uncaught `ReferenceError` right there, and `init()` — like any uncaught top-level throw in
JavaScript — stops executing immediately. Every `addEventListener` call still lower in the function
body never runs, so every button wired below the throw looks identical to a working button (it
renders, it takes hover/click states) but does nothing, with no error tied to the button the user
actually clicked.

This exact shape broke the Tomes modal in one incident: `init()` referenced `openPromptInspector`
and `closePromptInspector` on the prompt-inspector wiring lines, before either function was defined
anywhere in the file, well above the `tomes-btn` listener later in the same function [@app-js]. The
console showed `Uncaught ReferenceError: openPromptInspector is not defined` at the prompt-inspector
line; every listener registered after it, including Tomes, Logs, the topic system, import buttons,
the theme toggle, and the reveal buttons, was never attached. Both functions are now defined
earlier in the file, so this specific occurrence is fixed [@app-js], but the failure shape recurs
any time a new wiring block is added to `init()` referencing a handler that does not exist yet.

The diagnostic move that finds this class of bug fastest: when any button in the app does nothing,
open the browser console before touching the reported button, even when the console error looks
unrelated to what the user described. A single early throw in `init()` is a more common cause of
"several unrelated buttons stopped working" than a defect in each button individually.

## Three named rules from a five-incident postmortem

CLAUDE.md promotes three point-fixes to standing rules, named A/B/C, after the same shape of
bug shipped on a new surface five times because each earlier fix was recorded as a fact about
one call site instead of a law about every call site [@claude-md].

**RULE A — every LLM call site goes through `callProviderChat`, or replicates both of its
guarantees**: a generous `max_tokens` (≥4000, since a thinking model bills its reasoning against
the same cap) and `extractContent` at the reply boundary, which falls back to
`reasoning_content`/`reasoning` when `content` comes back empty [@claude-md] [@llm-call-js]. A
new raw provider fetch is a review flag; grep for `max_tokens` when touching one. This was paid
for twice: triage (0.8.82), then the Discord turn path (0.9.7, empty turns and tool calls cut
mid-JSON), because the first fix lived in `llm-call.js` alone and Discord's own raw fetch never
got the memo [@claude-md]. It was paid a third time across the JS/Python boundary: Phylactery's
`consolidate.py` funnels all four of its LLM consumers through one `_call_llm` helper that
hardcoded `max_tokens: 4000` and `timeout: 60.0` and read only `content`, so a large tier-rollup
fold on an always-thinking connection either timed out or came back with an empty summary
(fixed 0.12.8-alpha) [@consolidate-module]. The rule is about the guarantee, not the language —
`_extract_message_content` is the Python mirror of `extractContent`'s `reasoning_content`
fallback. See [Phylactery](../architecture/phylactery) for the fix and why the reasoning-content
fallback is safe there specifically.

**RULE A's ward-facing corollary — `extractContent`'s reasoning fallback is for internal
artifacts only; a reply the ward can see, store, or hear needs the length-aware shape.**
`extractContent`'s blanket "fall back to `reasoning_content` when `content` is empty" is correct
for Phylactery's rollups and other private notes, but it has a failure mode on an interactive
turn: when a thinking model hits `finish_reason === 'length'`, it spent its entire budget
reasoning and produced no answer at all — only chain-of-thought parked in `reasoning_content`.
Folding that into `content` on a ward-facing path surfaces the raw CoT as if it were the reply
(2026-09-29). Before the fix, `server.js`'s non-stream `/api/chat` path folded reasoning into
content on ANY empty `content`, with no `finish_reason` check, so a budget-exhausted turn's raw
CoT reached every non-stream caller that path serves — rendered and stored on the web chat,
saved as a handoff, shown in guide-chat, and, worst, spoken aloud on a voice call
[@server-js] [@llm-call-js].

`extractTurnReply(choice)` in `llm-call.js` is the fix: real content wins; empty content with
`finish_reason === 'length'` returns `''` (budget exhaustion — the caller treats it as no-reply,
never a CoT dump); empty content otherwise falls back to `reasoning_content`/`reasoning`, the
case where a proxy legitimately parks a *finished* answer there [@llm-call-js]. Two coordinated
changes landed together because each has its own callers: `server.js` now skips the reasoning
fold on `finish_reason === 'length'` (`choice.finish_reason !== 'length'` guards the call to
`foldReasoningIntoContent`), so content stays empty and the ordinary empty-reply handling fires
instead [@server-js]; and `voice-chat-turn.js`'s `runVoiceTurn`, which does its own recovery
rather than relying on the server's fold, swapped `extractContent` for `extractTurnReply` so the
same guarantee holds on the path that speaks the reply aloud [@voice-chat-turn-js].

The rule of thumb: **use `extractContent`'s reasoning-content fallback for internal artifacts**
(Phylactery's consolidation summaries, deliberation notes — nothing the ward reads directly),
**use `extractTurnReply`'s length-aware shape for anything ward-facing** — rendered on screen,
stored as a handoff or memory, or spoken aloud [@llm-call-js] [@consolidate-module]. This is the
corollary [Phylactery](../architecture/phylactery) names when it explains why Phylactery's own
`_call_llm` is safe using the plain reasoning-content fallback: consolidation output is the
Familiar's own private notes, never a user-facing reply, so the corollary does not apply there.

**RULE B — budget exhaustion is never silence.** Every cap, limit, timeout, or retry ceiling
must define, before it is built: what the ward sees, what the Familiar is told (its own tool
result must record that an action did not run — a dropped cutoff manufactures confident
confabulation, not an honest gap), and the log line [@claude-md]. The round-cap closing text
round (0.9.7, tuned per-surface in 0.9.8) is the reference implementation: on tool-round budget
exhaustion, force one closing text round with tools stripped, plus a first-person note that the
pending calls did not run [@claude-md].

**RULE C — a capability lands in the shared turn path, or the spec carries a surface matrix.**
Turn-machinery features must live in code every surface shares; where per-surface wiring is
unavoidable, the build spec must contain an explicit matrix (web live turn / web tool rounds /
Discord ward / Discord villager+ambient / background loops), each cell marked wired-or-N/A, in
the same commit as the feature [@claude-md]. The incident: Discord shipped without the
synchronous-describe wiring [Vision and media](../architecture/vision-and-media) gave the web
path (0.9.6) — web got `ensureDescribed`, Discord silently didn't, and the Familiar described
images on Discord it had never actually looked at [@claude-md]. `ensureDescribed`'s sibling for
voice notes, `ensureTranscribed` in `voice-transcribe.js`, was built with the lesson already
applied: both surfaces gained it in the same change, and its own doc comment names
`ensureDescribed` as the reason it exists [@voice-transcribe-js].

## A gap is reported as a plain fact, never a verdict

RULE B above requires that budget exhaustion is never silence; a 0.14.83-alpha pass tightened
*how* that report reads, after an identity-verification review showed the Familiar turning any
mention of a limit — even one that was the app's own fault — into self-blame and a new
self-imposed rule. See [Plain facts about limits, never a verdict](../decisions/plain-facts-about-limits)
for the incident and the decision; this section is the mechanism.

The round-cap note RULE B's reference implementation reads is now one shared string,
`ROUND_CAP_NOTE` in `cerebellum.js`, used at both places a turn's tool-round budget can run
out — `server.js`'s chat proxy and `cerebellum.js`'s own tool loop — instead of being
copy-pasted into each call site [@cerebellum-js]. Its wording states what happened and what happens
next ("my tool budget for this turn is used up, so the calls I just asked for didn't run... If
they tell me to go on, I get a fresh budget and carry on") with no caps-lock verdict.

`message-sanitize.mjs`'s `lastTurnRecord(messages)` builds the companion fact for the *next*
turn: a one-line record of what the previous turn's assistant messages actually ran, read from
stored history rather than from the model's own memory of what it meant to do [@message-sanitize].
It renders `[Last turn, tools used: ...]` or `[Last turn: no tools used.]` — plain record, not
the audit-voiced "from the app's record" phrasing an earlier version used.

**Text tool calls get named too (0.14.86-alpha).** Some models, some of the time, write a tool
call out as literal text instead of invoking it — a `<tool_call>` tag, a `<function=name>` tag, a
bare `{"name": "...", "arguments": {...}}` blob, or a line starting `snake_case({` — and nothing
runs, even though it reads like it did. `findTextToolCalls(text)` in `message-sanitize.mjs`
matches exactly these shapes, deliberately narrow enough that ordinary prose mentioning a tool by
name never trips it [@message-sanitize]. `lastTurnRecord` diffs the names it finds against the
names that actually ran (`tool_calls` on the same assistant message) and appends "My reply had
X written out as text, which doesn't run it." for anything written but never called — stated as
a fact about what happened, not as a mistake — and a real call of the same name in the same turn
clears the note. The turn log records `textToolCalls` per round so the pattern is visible outside
the live prompt too.

## A clipped view of your own past words reads as an unfinished sentence (0.14.69-alpha)

A silent fixed-length cut on text the Familiar reads back about itself produces a specific,
recurring misread: a reply that went out complete reads back as one that broke off, and the
Familiar apologizes for an unfinished sentence it actually finished. This shipped independently
on three surfaces, each clipping a different way, before the shared fix: the hippocampus kept a
stored reply's first 279 characters plus `"…"` [@hippocampus-js]; `formatRecentMessagesForContext`
(noticing's and warm reach-out's recent-lines rendering) stopped silently at 300 characters,
sometimes mid-word [@cerebellum-js]; and triage's recent-lines rendering stopped silently at 400
— which meant a crisis sentence placed at the END of a long message never reached triage at all
[@cerebellum-js].

This shipped across three call sites feeding [Memory and knowledge](../architecture/memory-and-knowledge)'s episodic-memory surface (the hippocampus) and [Noticing](../architecture/noticing)'s recent-conversation rendering; see those pages for what each surface is for. `src/util/excerpt.js`'s `excerpt(text, max)` is the shared fix: text over budget keeps its START
and its real END, both cut at a word boundary, joined by an explicit `EXCERPT_MARKER`
(`[… cut for length …]`) rather than a trailing `"…"` that reads as mid-thought [@excerpt-js]. The
real ending is what proves the message was complete; the marker is what says the *display* was
shortened, not the message itself. `headAt`/`tailAt` only snap to a word boundary when doing so
does not throw away more than 30% of the side being cut (`BOUNDARY_SLACK`) — one long unbroken
run (a URL, a run-on word) is cut hard instead of searching indefinitely for a space that is not
there [@excerpt-js]. Text within budget returns untouched.

**Not every surface gets the same budget, because not every surface carries the same cost of a
cut.** The hippocampus and the noticing/warm-reach-out renderer kept their existing 300-ish
character budgets, now excerpted instead of silently truncated [@hippocampus-js] [@cerebellum-js].
Triage is different: `renderTriageSliceBody` (`cerebellum.js`) shows its newest
`TRIAGE_UNCUT_LATEST` (5) lines of a slice **whole, at any length** — they are the context a
safety decision actually rests on, so nothing about them may be shortened — and only an *older*
line is excerpted, and only past `TRIAGE_LINE_CEILING` (10,000 characters), so a single
pathological paste earlier in the conversation cannot push the whole prompt past the model's
context window and fail every deliberation on that slice [@cerebellum-js]. This is a direct
instance of the robust-over-cheap ordering elsewhere on this page: the cheap fix (apply the same
300-character excerpt everywhere) would have reintroduced the exact bug triage needed fixed,
since a crisis sentence sitting past character 300 of a long message is the failure this surface
cannot afford.

`tests/excerpt.test.mjs` pins the helper directly, a hippocampus round-trip (a long reply renders
with its real ending), legacy entries stored before the fix (which still end in `"…"` and render
with the marker appended until they age out of retention), the noticing/reach-out formatter, and
triage's newest-whole/older-capped split [@excerpt-test].

**The same clipping shape is still open on a surface this fix did not reach.** Phylactery's
`recall` tool builds its result excerpts as a bare `content[:300]` in four places in `memory.py`,
with no cut marker at all [@memory-module]. A ward-facing identity review hit exactly the
predicted failure: the Familiar read a cut-off recall as "this fact isn't saved yet," saved a
near-duplicate, then found the full text with `read_memory_by_id` and deleted its own duplicate.
Phylactery needs the same start-and-real-end excerpting `src/util/excerpt.js` already gives the
Node side; until then, treat any `memory.py` excerpt as unmarked and possibly cut mid-word.

## Safety-critical sign-off

Behavioral changes (not relocations, comments, or renames) to `crisis-signals.js`,
`threat-tracker.js`, `silence-triage-loop.js`, the triage/delivery/escalation logic in
`cerebellum.js`, or the `[CARE CHECK]` assembly in `thalamus.js` require asking the human
before shipping [@claude-md]. See [Proactivity over caution](../decisions/proactivity-over-caution)
and [Safety spine](../architecture/safety-spine) for why.

## Prompt catalog: a live-source review page for every prompt and tool description

`scripts/build-prompt-catalog.mjs` (`npm run prompts:catalog`) generates `docs/prompt-catalog.html`,
a single self-contained page listing all 16 prompts the Familiar reads plus all 104
`BUILTIN_TOOLS` descriptions, each with its file:line, a one-line purpose note, the text as
authored, a copy button, and one search box over everything [@build-prompt-catalog]. It exists
so reviewing every prompt for wording or safety implications does not mean grepping the tree by
hand — the shipping commit's own framing was "I seriously need to go over all the prompts"
[@build-prompt-catalog].

The generator reads LIVE source on every run and stores no prompt copy of its own, so the page
cannot drift out of sync with the code; adding a prompt to the catalog is one manifest entry in
`PROMPTS`, added centrally rather than touching the prompt's own source file — a property that
matters because several prompt files are the safety-critical ones named above
[@build-prompt-catalog]. Two capture modes cover how a prompt's text actually exists in source:
`'literal'` lifts the authored template or string verbatim by locating a unique anchor at the
literal's opening delimiter, with a scanner that handles escapes, `${…}` interpolation brace
depth (including a nested template literal inside an interpolation), and adjacent string
concatenation (a plain string literal followed by `+` and a template literal), so an
interpolated slot like `${focusBlock}` shows as-authored rather than resolved
[@build-prompt-catalog]. `'render'` instead imports the real function for a
prompt that code assembles per-branch (the tier-by-tier `[CARE CHECK]` block — see
[Safety spine](../architecture/safety-spine)) and renders each variant, rather than guessing at a
single literal [@build-prompt-catalog]. `tests/prompt-catalog.test.mjs` pins the scanner and
extractor logic directly, including the nested-interpolation and concatenation cases
[@prompt-catalog-test].

The generator fails loudly on purpose: a drifted or duplicate anchor, or an anchor that does not
sit at a literal's start, throws naming the entry, and an empty prompt block is never emitted
silently — a stale catalog that looks fine is judged worse than one that refuses to build
[@build-prompt-catalog]. Safety prompts (triage, care-check, noticing, content-regate) carry a
"safety sign-off" badge in the generated page, so a reviewer sees at a glance which entries need
human sign-off before their wording changes, per the rule above [@build-prompt-catalog]. The
generated `docs/prompt-catalog.html` is committed as a snapshot (so it opens with no build step)
and is deliberately a local file, not something published externally, because it surfaces the
Familiar's own inner-voice and care-related framing verbatim [@build-prompt-catalog].

## Test discipline: assert, not narrate

A test file must contain assertions. A passing test that is mostly prose narration
("this function works because…"), even when correct in intent, is a smell: it is brittle,
gives false confidence, and rots into dead code. The 0.9.0 full-codebase audit (shipped as
0.9.0-alpha, PR #211) caught a date-handling bug in the availability calculator because the
covering test was an AI debugging monologue asserting nothing—just describing what *should*
happen instead of verifying what *does*. Test the actual wire shape, not a convenient
stand-in: if the code must handle bare date strings like `2026-07-06`, the test must exercise
exactly that shape, not a convenience substitute.

## A test whose outcome depends on an absent file is not a real test

A pre-existing test for `scoreMessageMl(message, { artifact: null })` asserted the result
was `null`, and it only passed because CI has no local copy of the git-ignored
`models/crisis-classifier.json` artifact — the implementation used `artifact ?? loadArtifact()`,
so an explicitly-passed `null` was treated as "unspecified" and fell through to loading the
real model whenever one happened to be present on disk [@crisis-classifier-test]. The bug
surfaced only once a real model was trained and placed locally for the 0.12.0-alpha work on
[the crisis classifier](../architecture/safety-spine); the same test, run in an environment
where the artifact existed, returned the model's real score instead of `null`
[@crisis-classifier]. The fix: `crisis-classifier.js`'s `scoreMessageMl` and
`scoreThreatMessage` now check `artifact === undefined` rather than using `??`, so an
explicitly-passed artifact — including `null`, meaning "no model" — is always authoritative,
and the default is loaded only when the caller omits the key entirely [@crisis-classifier].
The general lesson: if a test's outcome can flip depending on whether an unrelated file
happens to exist on the machine running it, it is not exercising the code path it claims to —
make the behavior deterministic in both conditions, and actually run the test both ways
before trusting it.

## Guards on shared primitives demand full-suite audit

A guard (a fail-closed check that blocks some input or behavior) applied to a function used
by many callers is easy to introduce and easy to break downstream. The 0.8.99 recurring-series
guard was tested in isolation and passed; when only the schedule/server subset of the full
Unruh test suite was run at merge time, gcal's internal cancel logic broke silently. Lesson:
when a guard ships on a shared primitive, the same commit must audit every internal caller of
that primitive in the full test suite. A subset run (schedule-specific, server-specific) is
not sufficient. Run the full suite before claiming the guard is safe. This pattern was exposed
by the 0.9.0 full-codebase audit (PR #211).

## Accessibility is a contract, not a "nice to have"

Proto-Familiar ships with [WCAG 2.0 AA](https://www.w3.org/WAI/WCAG21/quickref/) as an
explicit requirement. The 0.9.0 full-codebase audit found and fixed: pinch-zoom disabled
(no interaction mode for touch users), keyboard focus invisible on buttons (no focus indicators
for keyboard users), and text-muted foreground at ~2:1 contrast (text readability). Contrast
ratios are documented inline in `style.css` with precise values so future changes can be
verified without manual testing. The conventions are recorded in `CLAUDE.md` with "hold the
WCAG line" as the operating principle.

## Cross-language MCP contracts: a silent-failure bug class and its gate

Thalamus (JS) calls [Phylactery](../architecture/phylactery) and [Unruh](../architecture/unruh)
(Python) MCP tools with `callTool({ name, arguments })`, and `arguments` is an opaque object —
nothing in the JS toolchain checks its keys against the Python tool's `@mcp.tool` parameter
names [@audit-mcp-script]. That gap produces three distinct failure shapes, and all three fail
**silently**: invisible to `node --check` and to every JS-only wiring audit (imports, exports,
endpoints, loops), because the mismatch only exists at the JS↔Python argument boundary
[@audit-mcp-script].

- **Wrong/misnamed arg.** Pydantic drops the unknown key and the tool's actually-required
  parameter is now missing, so FastMCP returns an `isError` result the JS wrapper often never
  inspects — the HTTP layer answers `{ok:true}` while nothing was written.
- **Extra arg the tool doesn't accept.** Pydantic silently drops it, so a filter or flag the
  caller believes it is passing does nothing.
- **A tool name that doesn't exist.** The call throws; if the caller wraps it in a
  swallow-and-log `try`/`catch`, the feature goes inert with only a log line as evidence.

Four instances shipped before the gate below existed [@audit-mcp-script]: `identity_update_section`
sent `heading` where the tool wanted `section` (silent no-op write, HTTP still reported
`{ok:true}`); `graph_node_search` sent `type`, which the tool did not accept, so a
type-filtered graph search silently returned every type (`graph_node_list` did support the
filter — only `search` was missing it, fixed by adding the filter to Phylactery);
`interest_report_surfacing_outcome` — the Unruh tool did not exist at all, see below; and
`graph_node_delete` sent a dead `permanent` flag that Phylactery's delete tool does not
accept — it only hard-deletes a node and its edges — removed end-to-end from thalamus's call
site [@thalamus].

**The gate.** `scripts/audit-mcp-contracts.mjs` (`npm run audit:mcp`) parses every thalamus MCP
call site and every Phylactery/Unruh `@mcp.tool` signature, then flags UNKNOWN tool names,
BAD-ARG keys that are not a parameter of the tool, and MISSING-REQ parameters a call never
sends [@audit-mcp-script]. `tests/mcp-contracts.test.mjs` asserts the check returns no findings,
so a future mismatch fails CI instead of reaching a ward's data [@mcp-contracts-test]. It
catches all four instances above.

**Its limit, stated so nobody over-trusts it:** the gate checks argument names, tool existence,
and required-parameter presence only — **not** types and **not** semantics
[@audit-mcp-script]. A call that sends a correctly-named argument with the wrong type (a string
where the tool wants a list), or the right name and type with the wrong meaning (a
local-naive timestamp where the tool expects UTC — the class behind the 0.7.84 reminder bug,
see [Unruh](../architecture/unruh)), still passes. Static name-checking cannot decide either
case: the call sites are untyped JS, and meaning is not decidable from syntax alone. Catching
those classes needs a cross-process integration test that actually spawns the peer and asserts
behavior, not a static contract check — see the smoke test below for the coverage that fills
this gap.

**Checker precision fix (0.10.109-alpha).** The gate originally resolved `arguments: someVar`
by a global first match of `const/let/var someVar = {...}`, but variable names like `args` are
reused across many call sites, so a global first match could resolve the wrong assignment
entirely. It now resolves to the NEAREST-PRECEDING assignment above the call site and folds in
any incremental `someVar.key = …` assignments between that point and the call
[@audit-mcp-script]. This mattered concretely: `temporal_context`'s `mode` argument (see
[Unruh](../architecture/unruh)) was assembled into a separate `const unruhArgs` object, so the
old resolver validated only that the tool existed, never that `mode` was one of its keys.
Removing `mode` from the Python tool now correctly flags `BAD-ARG unruh.temporal_context`.

## The isError-swallow class: a runtime gap the static gate can't catch

The contract gate above checks argument *names* against the Python signature; it says nothing
about whether a caller correctly reads the *result* of a call. `callTool` from
`@modelcontextprotocol/sdk` does not throw when a Python tool raises — a pydantic validation
error from a bad or missing argument, or any other exception, comes back as a **resolved**
result with `isError: true` [@phylactery-result]. A wrapper that only reads
`content[].text` and falls through to a `{ ok: true }` fallback when that text does not parse
as the tool's normal JSON reports success on a failed write — the error text isn't the tool's
JSON payload, so the fallback wins silently. This is the exact class behind the
`identity_update_section` bug, which had previously been fixed at only that one call site.

A 0.10.108-alpha audit found the fix had not generalized: **28 mutating Unruh wrappers** in
`thalamus.js` returned `parseToolText(r, { ok: true })`, plus 2 more returned `true`
unconditionally, so all 30 reported success on any Unruh raise. The root-cause fix is two
pieces:

- `phylacteryToolError` was generalized into server-agnostic `mcpToolError(result)` in
  `phylactery-result.js`: `isError` is set by both Phylactery and Unruh on a raise, and the
  "Failed:" prefix check is Phylactery's own deliberate-failure convention layered on top — a
  harmless no-op check against Unruh, whose success payloads are JSON starting with `{`
  [@phylactery-result].
- `unruhResult(result, fallback)` in `thalamus.js` calls `mcpToolError` first: an error result
  becomes honest `{ ok: false, error }`; a success result returns the tool's own JSON payload
  (which already carries `ok`) [@thalamus]. All 28 write wrappers plus the original
  `identity_update_section` site now route through it.

Reads are deliberately **not** routed through `unruhResult` — they still degrade to an empty
payload on failure (absence renders as absence), which is this page's own Graceful degradation
rule's intended behavior for a peer being down. Only the write class, where a silent success is
the dangerous outcome, is made honest. The general lesson: the static contract checker matches
argument *names*, and structurally cannot see whether a caller reads a raised error as success
— that is runtime error-handling behavior, not a naming mismatch, and it needs a different kind
of check.

## Cross-process MCP smoke test

`tests/mcp-smoke.test.mjs` closes the gap the previous two sections both point at: it spawns the
**real** Phylactery and Unruh MCP children through thalamus (not stubs) and round-trips
representative tools, asserting actual behavior and actual return shapes — catching type or
semantic mismatches that neither the static gate nor a pure-function unit test can
[@mcp-smoke-test]. Its cases include `saveBookmark` → `listBookmarks` (the M8 write side,
exercised cross-process, see [Unruh](../architecture/unruh)); a call with a missing required
argument, asserting the resulting pydantic `isError` surfaces as an honest `{ ok: false }`
through `unruhResult` against a real raise rather than a stub; `bumpInterest` →
`listInterests`; and Phylactery's `getMemoryHealth`. The suite self-skips when `uv` or the
Python venvs are absent (CI without Python), so a missing toolchain never reddens the suite
[@mcp-smoke-test].

Isolating the test from dev data required a store override: `UNRUH_DB_PATH` and
`PHYLACTERY_DB_PATH` relocate each server's sqlite file, read in `default_db_path()` on both the
Unruh and Phylactery sides, and forwarded into the spawned child's environment by
`thalamus.js` only when set [@mcp-smoke-test] [@thalamus]. The forwarding is explicit because
these variables are not in the MCP SDK's inherited-environment allowlist — the SDK's stdio
transport merges only its own default environment plus `serverParams.env`, so an unlisted
variable never reaches the child unless the caller adds it itself. Production spawns are
unaffected when the variables are unset, and the same override lets an install relocate its
data directory generally, not just under test.

**The meta-lesson.** A JS-internal wiring audit has a structural blind spot at every
language/process boundary. "Thorough audit" must explicitly include cross-boundary contract
checks, boundary-crossing tests for the type/semantic classes a static check can't decide, and a
check on runtime error-handling at the boundary — not just intra-language imports, exports,
endpoints, and argument names. See [Unruh](../architecture/unruh) for the concrete feature
(bookmark resurfacing) this blind spot hid pieces of across two consecutive audit passes.

## Sibling tool names must be prefix-distinct

An LLM selecting a tool by name is misled when two sibling tools share a prefix: reaching for
the shorter name gets railroaded into the longer one. This shipped as a live bug — the Familiar
trying to call `intention_set` was routed into `intention_set_rounds_visibility`, so it couldn't
set intentions at all. The fix (0.11.16) was to rename the longer tool to `intention_visibility`
so the names no longer collide on the `intention_set` prefix; only the model-facing name changed
(the tool definition, its executor key, and the surfacing-module map), while the internal Unruh
MCP call kept its own name [@cerebellum-js]. The convention: when two Familiar-facing tools are
siblings, make sure neither name is a prefix of the other — the model picks by name, and a
shared prefix is a selection hazard, not just a cosmetic overlap.

## Second full-codebase audit (2026-09-29): one open gap, settings-access dedup

A second full-tree re-audit (pass 2, following the 0.9.0 one referenced throughout this page)
re-ran the original review questions across the whole codebase plus a dedicated
optimization/clarity pass. Its headline finding was positive: every background loop still holds
the hard-off-switch invariant from
[Autonomous loops](../architecture/autonomous-loops)' shared contract, and no other systemic
issue turned up. The one real, actionable finding is that an earlier dedup pass did not fully
land, and it is still open as of this writing.

A prior pass ("dedup extractions pt.1") pulled the inlined `JSON.parse(readFileSync(SETTINGS_FILE))`
pattern into one leaf module, `settings-store.js`, exporting `readSettingsSync` and
`SETTINGS_FILE` for both `cerebellum.js` (which owns the write path and re-exports
`readSettingsSync` for its many callers) and `thalamus.js` (which sits below `cerebellum.js` and
would otherwise create an import cycle) [@settings-store-js]. The second audit found the
extraction reached thalamus and its downstream callers, but not every direct reader: as of this
writing, `contact-baselines.js` and `wait-streak.js` each still define their own local
`SETTINGS_FILE` constant and read the file independently rather than importing the shared reader
[@contact-baselines-js] [@wait-streak-js]. On the write side, `writeSettingsPatch` in
`cerebellum.js` is the one function that performs the locked, atomic tmp-write-then-rename against
`settings.json`, but `discord-gateway.js`'s ward-console settings path (`patchWardSettings`)
re-implements the same lock-plus-atomic-rename sequence against its own local
`WARD_SETTINGS_FILE` constant instead of calling it [@discord-gateway-js]. Neither duplication is
a correctness bug on its own — both copies read and write the same file correctly — but every
module that keeps its own `SETTINGS_FILE` constant or its own write sequence is a copy that can
silently diverge from the canonical one the next time the write contract changes. This is the
"no copy-paste of substantial logic" rule above, caught by audit rather than by the original
build: the fix proposed is to make `settings-store.js` the single home for the path, the read, and
the write, with every remaining direct reader and the Discord write path importing it rather than
re-declaring it.

The audit's other action was a routine dead-code and stale-documentation sweep rather than new
findings: a batch of confirmed-zero-caller symbols (an unused re-exported constant, a shadowed
module-level helper whose only "call site" was dead by construction, an orphaned Python function)
was removed after verifying no callers first, and a batch of comments and docstrings that still
described retired designs (a renamed in-tree store, a "deferred to v2" feature that had since
shipped, a pre-local-naive-time description of the temporal model) was corrected to match current
behavior. Neither batch changed runtime behavior; both are the kind of drift that accumulates
between audits and is cheapest to fix in the same pass that finds it.

## A check that reads a stripped copy of the source can pass green on nothing

The second audit also retired an existing wiring check rather than fixing it, for a reason worth
keeping as a general lesson. `scripts/audit-wiring.mjs` had a check asserting that every setting
synced from the client is actually read somewhere server-side. The check was dead on arrival: it
matched key names against a comment-and-literal-stripped copy of `app.js` it built for a different
purpose, so it always found zero keys and printed a passing checkmark regardless of what the real
code did [@audit-wiring-script]. A check that evaluates a transformed or filtered copy of the
source, instead of the source itself, can pass vacuously — the green result proves the copy was
empty, not that the property holds.

Fixing the check's plumbing would not have made it a good check, though. "Synced but unread
server-side" is the normal shape of a client-only setting kept in sync for device portability (a
UI preference like a theme toggle, say), not a bug signal — of the settings actually synced from
the client, the large majority that showed up as server-unread were confirmed legitimately
client-only. A correctly-wired version of this check would still be almost entirely false
positives. The direction that actually causes bugs — a server read with no setting anywhere
providing it, silently returning `undefined` — is a different check already covered elsewhere in
the same script. The check was deleted with a tombstone comment recording why, so it is not
reintroduced by someone who only notices it is missing [@audit-wiring-script]. The general lesson:
before resurrecting or fixing a removed check, confirm what it would actually flag in the
passing case, not only whether its plumbing could be made to run.

## An assertion on a literal tests nothing, even when the test passes

`tests/voice-notes.test.mjs` had a test named "a temp dir is not left behind" whose body asserted
`assert.ok(true)` after an `fs.rm` call — syntactically a test, but verifying nothing about the
code under test; a passing result told a reader only that `true` is truthy. The fix makes the
test assert the actual claim in its name: it checks that a specific stray `os.tmpdir()` path the
store must never write to is absent, proving the save path exercised by the write tests above it
never leaked outside the real media store, with a `before` hook that clears any prior-run leftovers
first so the assertion cannot pass by accident from a previous run's state [@voice-notes-test].
This is the same family as the "Test discipline: assert, not narrate" rule above, in a sharper
form: a test with an assertion that is a tautology (asserting a literal, or asserting a value the
test itself just set) is indistinguishable from a comment at review time, and it rots exactly like
an unasserted narration does — it just takes longer to notice because the test suite stays green, rather than reading plainly as
a no-op on review.
