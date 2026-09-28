# Codebase audit — 2026-09 (fine-tooth-comb, full per-function read)

Scope: the whole tree, read function-by-function — the four big Node files
(`cerebellum.js`, `thalamus.js`, `server.js`, `discord-gateway.js`), the WebUI
(`public/app.js` in three slices + `index.html`/`style.css`), the safety/
proactivity cluster, all remaining Node modules + root utils, and **inside both
Python MCP services** (Phylactery, Unruh). Divided across 11 parallel review
agents plus direct reads (village.js, the 117-tool census, the WebUI markup).

Lens: orphaned/stale · wordy commentary · disconnected wiring · copy-paste that
wants centralizing · **anything eroding the Familiar's autonomy / personality /
good time in the harness.** Findings rated **[confidence]** and severity.

---

## Coverage (this pass is the real read, not just pattern sweeps)

| Area | Depth |
|---|---|
| `cerebellum.js`, `thalamus.js`, `server.js`, `discord-gateway.js` | full per-function read |
| `public/app.js` (15,470 ln) | full, 3 slices |
| `index.html` / `style.css` | markup/WCAG read |
| `village.js` | full read |
| all 117 tools | census: executor + reachability verified |
| `src/safety`, `src/schedule`, `src/warmth`, `src/pondering`, `src/tracker` | core full read; derivation files grep-swept |
| `src/memory`, `src/vision`, `src/weather`, 16 root utils | full read |
| `src/voice` (35 files), `src/browser` (14) | high-risk files full; rest signature-swept |
| Phylactery `*.py` (17 files) | full read |
| Unruh `*.py` (16 files) | full read |

**Residual gaps (honest):** the lower-risk `src/voice/*` (transcribe/speech/
generation/models/catalogue/clips) and `src/browser/*` (cdp-arm/lens/reader-*)
files were signature-swept, not line-read; the Unruh/safety *derivation* files
(temporal-format, stewardship, event-alerts, recurrence, tracker-projection…)
were grepped for philosophy/bias, not exhaustively logic-read. No risk-pattern
hits in the swept set.

---

## Progress (fixes landed since the audit)

- **Unruh — DONE (0.14.33 + 0.14.34):** Theme 1's Unruh half (the ward-clock
  time-model campaign — `db.now_local`/`to_naive_local`/`local_to_utc` + every
  derived signal + the `.ics` export), the dead `date`-field validation, the
  `handoff` UUID→slug (Theme 3), the dead `list_gcal_nodes` (A2/dead-code), the
  `db_snapshot` VACUUM quote-escaping, and the `resolve_occurrence` date-format
  guard. Deliberately NOT changed: `predict_windows`' `now` param (kept for the
  uniform derived-signal signature; prediction is correct without it) and the
  measure-zero `gauge_level` grace-boundary `<`/`<=` (gauge band logic is a
  ward-sign-off path). Unruh is now closed out.
- **Still open:** the Node/WebUI halves of Themes 1–3, the RULE A/B/C server-side
  gaps, the privacy/logic items, and the ward-sign-off prompt items below.

## Headline

The codebase is in **strong** shape. The safety/proactivity layer is genuinely
sound (threat math verified, no catastrophic-passivity gate, anti-patterns
regression-tested), the philosophy convention holds everywhere (zero second-person
imposed framing, zero "the user" in Familiar-voice text), wiring is clean, and
there is **no dead or duplicated code in the load-bearing orchestration files**.

The real payoff is **three cross-cutting themes** that multiple independent
reviewers converged on — each a case of a *documented, already-paid-for fix that
wasn't fully propagated* to every surface. That's exactly the "recorded mistake
comes back on a new surface" pattern CLAUDE.md warns about, and it's why this
audit was worth doing.

---

## ★ THEME 1 — Ward-local-vs-server/UTC time is systemic (and partly safety-adjacent)

The `0.7.84`/`0.7.86` "compute *now* on the ward's clock" fix (`wardLocalNowISO`,
Unruh's `db._local_zone()`/`TZ=wardTimeZone`) landed on the Node chat path but was
**not propagated** to a whole set of surfaces. On any install where the container
timezone ≠ the ward's (WSL/Docker/hosted — the case CLAUDE.md names), these
silently compute against the wrong clock:

- **Unruh, all derived signals** — `tracker.py` `gauge_level` (:252, **feeds the
  gauge escalation safety-ladder**), `stale_trackers` (:574), `expiring_items`
  (:671, pantry), `entry_rate_flag` (:721); `interest.py` `effective_weight`
  (:116); `schedule.py` `stamp_elapsed` (:527, ward-signed), `get_window` (:781);
  `server.py` `_window_base` (:70). All fall back to bare `datetime.now()` and
  `server.py` **never passes `now=`**. **[high]** Fix: add `db.now_local()` and
  default every one to it.
- **Unruh `icalwrite.py`** (:36/44/94) — bare `.astimezone()` on the outbound
  `.ics`/Google export → Windows exports events DST-shifted. **[high]**
- **`thalamus.js:2710`** — `enrich()` hand-builds a **second, redundant, server-TZ
  `[Now]` block**, duplicating `buildTimeAnchorBlock` that `server.js:650` already
  appends correctly with the ward's zone. Live reintroduction of the 0.7.86 bug.
  **[high]** Fix: delete the inline block, rely on server.js's.
- **`thalamus.js:3028/3072`** — `createMemory`/`createMemoryFull` default a
  memory's `date` to the **UTC** calendar day; reachable via `save_memory` and
  tome-graduation → near-midnight, a memory files under the wrong day. **[high]**
- **`cerebellum.js:3202`** + **`server.js:4111/4294`** — `save_memory`
  confirmation key uses UTC date → a later update/delete-by-key can miss. **[low]**
- **`server.js:7195` (safety-review)** — `gatherNoticingWakeInputs` parses
  ward-local-naive `when_ts`/`end_ts` with `Date.parse` (server-local) vs
  `Date.now()` epoch → "is this event overdue" is off by the zone offset, and this
  feeds the **no-stand-down noticing loop**. Ward review. **[high]**
- **`server.js:5290`** — recurring-window bounds parsed server-local; self-
  consistent with `recurrence.js` today but a fragile undocumented coincidence.
  **[med]**

**One fix campaign** — a ward-TZ seam on each side (`db.now_local()` in Python,
route Node date-derivation through `wardLocalNowISO`) — closes all of these. The
`server.js:7195` piece is safety-adjacent → ward sign-off before landing.

## ★ THEME 2 — RULE A/B/C (thinking-model safety) not fully propagated

The `0.9.7`/`0.11.20` fixes (≥4000 cap + `extractContent`/reasoning-content fold,
never silence on budget exhaustion) missed several call sites. On an always-on-
thinking model (GLM-5.3 etc.) these return empty/garbled or dump chain-of-thought:

- **`server.js:5512` `/api/guide-chat`** — raw `fetch`, no `max_tokens`, no
  `extractContent` → empty reply on a thinking model. The in-file comment at 1368
  *claims* guide-chat is covered; it never routes through `/api/chat`. **[high]**
- **`server.js:1209` streaming tool-loop** — SSE accumulates only `delta.content`,
  never `delta.reasoning_content` → answer parked in reasoning ends the turn with
  `''`, silently. Non-stream path got the fold; streaming didn't. **[high]**
- **`server.js:6884` page-watch** — passes `maxTokens: 2000` (below the 4000
  floor). **[high]**
- **`src/vision/zai-vision.js:217`** — `describeViaZaiVision` never checks
  `result.isError` → an MCP error's text is **cached as the image description
  permanently**. **[high]** Use `mcpToolError`.
- **`src/vision/gemini-file-api.js` `extractGeminiText`** — joins all parts
  including Gemini `thought:true` reasoning parts → thinking-dump. **[med]** Filter
  `!p.thought`.
- Sub-4000 caps (handled/graceful, but below floor → thinking connections fail
  systematically): `content-regate-loop.js:67` (3000), `voice-discord-server.js:246`
  (2000), `vision.js:565` describeAsset (700). **[low]**

## ★ THEME 3 — Slug-id rule not fully propagated

Model-facing ids still minted as UUID/random/timestamp instead of the shared
meaning-bearing helper (`slug-ids.js` / `db.slug_id`), which already exists:

- **`village.js:793/927` villager id** — `randomUUID`, surfaced by `village_lookup`
  (`cerebellum.js:4771`) and read back into `village_upsert`. **[high, med effort]**
  Migration must chase references (memory subjects, `graphNodeId`) like the
  category-audience remap.
- **`handoff.py:74`** — `set_handoff` mints uuid4 hex; live via `temporal_context`
  → `session_mark_handoff_consumed`. Only Unruh id-table holdout. **[med]**
- **`memorization.js:1276`** — mints `fact-${Date.now()}-${rand}`, *overriding*
  Phylactery's content-derived slug. **[med]** Omit it / use `meaningSlugId`.
- **`browser-driver.js:717`** confirmId `cf-${rand}`, spoken to model. **[med]**
- **`page-watch.js:111` `mintId`** — base64url, can contain 0/O/1/l/I. **[med]**

---

## Safety-review items (ward sign-off — I did NOT change these)

- **`cerebellum.js:1043,1047` — the triage deliberation prompt still stages
  equal-weighting.** It reads *"I know both paths have real costs, and I weigh them
  equally"* + *"Not from a default posture in either direction."* CLAUDE.md
  proactivity **Rule 2 was explicitly rewritten to forbid this** ("hold both at
  equal weight reads to it as *find reasons to wait*"). Cost-of-silence IS named
  (good), but the symmetric framing is the corrected-away pattern, on the single
  most safety-critical prompt. **[high] — your call; this is the class of edit that
  caused the 1.5-hour silence.**
- **`care-check.js:36` (MILD) "unless it fits"** and **`:46` (MODERATE) "If it
  would feel intrusive… I stay steady"** — the flagged micro-hedge / un-named
  cost-of-silence, but at the lowest tiers on an *active* turn (human present, not
  silent), so materially lower-stakes than the triage one. Same theme as ↑.
- **`cerebellum.js:1058`** — `nextCheckInMs` guidance "picking too long is much
  cheaper than too short" biases the crisis re-check cadence toward waiting
  (tension with Rule 5 "tune toward action"). Bounded by tier defaults.
- **`silence-triage-loop.js:168`** — a failed deliberation is logged identically to
  a genuine `wait` (inflates the wait-streak; 15-min severe re-check still fires,
  so no passivity — pure observability).
- **`noticing.js:392`** — a threat-*read* failure silently runs noticing at the
  `calm` register (still runs — good — but loses the elevated line); log loudly.

These bundle naturally: the triage/care prompts carry a small set of residual
hedge/equal-weight phrasings that predate the Rule-2 correction. Worth one
deliberate ward pass.

---

## Privacy / gating (verify or decide)

- **`graph.py:343` `_resolve_node`** — label match ignores audience → a villager
  saying "Mom"/"Sam" in a gated room can resolve to a pre-existing **ward-private**
  node and attach an edge under the narrower audience (correlation leak). The
  hygiene pass already treats this as ambiguous; the write path doesn't. **[med]**
- **`graph.py` `list_nodes`/`get_full_graph`** — no `audiences` param (unlike
  `search_nodes`). Safe today (ward-only endpoints) but no defense-in-depth for the
  multi-embodiment surface. **[med]** Add the optional param.
- **`discord-gateway.js:1641` `!consent` menu** — fetches a villager's memories with
  no audience/topic filter → could show a ward-authored sensitive note *to* that
  villager. May be intentional subject-transparency — **your decision**. **[low-med]**
- **`discord-gateway.js:3454` `/update`** — gated on `isWard` only, not `ward-dm` (unlike
  its siblings) → posts repo/branch/version into a public guild. **[low-med]**

## Logic bugs (non-safety)

- **`graduation.py:250-291`** — a failed `memory_create` isn't distinguished before
  the identity file is trimmed → graduated detail can be **silently, permanently
  lost** (contradicts "graduated facts aren't deleted"). Latent today. **[med]**
- **`memory.py:556` `_dedup_merge_pending`** — additive-but-non-identical pending
  facts (sim 0.70–0.85) are silently dropped like exact restatements → new detail
  ("need Earl Grey") vanishes. Tension with "never silently discard." **[med]**
- **`tracker.py:137-141`** — the `date` field validation is **dead**: `to_local_naive`
  returns unparseable input unchanged, so `'banana'` stores as a valid date.
  Contradicts the "malformed dropped" contract. **[med]**
- **`app.js:8306`** — `scanLoreEntries` gates on `state.generationMode`, which is
  never reassigned → the ported generation-mode trigger is permanently inert. **[med]**

## Duplication (extract a shared helper)

- `app.js:1396/1505` — duplicate `baseUrl` key in two connection literals
  (duplicate-object-key class; harmless, same value). **[med]**
- `app.js:5182/5222` — `memorizeSessionToTome`/`memorizeViaBeacon` build identical
  payloads → `buildMemorizePayload`. **[med]**
- `app.js:7373/7925/8074` — "skip tool plumbing" filter copy-pasted 3× →
  `collectSummarizableRange`. **[med]**
- `app.js:12270` — `teEscapeHtml` duplicates `esc()` → make `esc` null-safe. **[med]**
- `thalamus.js` — 8× `JSON.parse(readFileSync(SETTINGS_FILE))` (6 in `enrich()`
  alone) → `readSettingsLocal()`. **[med]**
- `thalamus.js:3276/3298` — snapshot/restore reimplement `unruhResult()`. **[low]**
- `thalamus.js` `schedulePhylacteryReconnect`/`scheduleUnruhReconnect` (self-
  acknowledged) + `reconnectUnruh` lacks the in-flight mutex `reconnectPhylactery`
  has. **[med]**
- `cerebellum.js:922` vs `432` — `renderSliceBody` duplicates
  `formatRecentMessagesForContext`. **[med]**
- `discord-gateway.js:357` vs `2689` — history-building block verbatim →
  `buildHistoryForPrompt`. **[med]**
- `server.js:954/1355` — `thalamusEnvelope` construction copy-pasted. **[med]**
- Unruh: strip-tzinfo pattern reimplemented 4× (→ one ward-TZ helper — also fixes
  Theme 1). **[low-med]**

## Dead code / stale

- `memory.py:90 _row_to_thin`, `graph.py:231 find_nodes`, `cerebellum.js:1183
  UUID_RE`, `gcal.py:152 list_gcal_nodes`, `tracker.py:740 predict_windows(now)`
  (unused param), `backup.py:69 crypto_status` (never wired to a tool),
  `server.js:141/110/184` (unused imports). **[low]** — all safe to delete/wire.
- `cerebellum.js:3318/3333` — `graduation_acknowledge`/`disclosure_acknowledge`
  aliases marked "remove after 0.12"; now 0.14.32 → **stale by their own contract.**
- **Stale comments that invert the truth (dangerous):** `app.js:13264/13333/13367/
  13702` say schedule storage is "UTC" — it's local-naive; the code is correct but
  a future editor could "fix" it and reintroduce the timezone bug. `cerebellum.js:
  1189` names retired "Entity-core." `server.py:1-63` docstring "stable contract"
  omits 22 of 62 MCP tools. **[med for the UTC ones, low others]**

## WCAG (WebUI)

- Icon-only buttons with `title` but no `aria-label`: `index.html:226/1113/1115`,
  `app.js:8630` (lore delete), `app.js:12149` (weather place delete). **[low]**
- `app.js:9743` voice-preview button — `aria-label` not updated on play/stop
  toggle. **[low]**
- Form labels not associated (`<label>`/`<div>` sibling, no `for=`) across the
  Knowledge-editor + Village editor panes → follow the `keFieldRow` pattern already
  in the file. **[med]**

---

## What's clean (verified, not merely absent)

- **Safety math** — crisis-classifier (RAISE-only, caps below severe, threshold
  from the artifact, regex-floor degrades *toward* sensitive), threat-tracker
  (boundaries, decay, `FLAG_FLOOR=8`, 90s dedup, reset-when-disabled), mood-threat
  (ceiling 3.5, hourly cap, clamp) — all sound.
- **Proactivity** — no bias-toward-quiet in any when-to-act prompt (except the
  ward-review hedges above); `surface-context` GREEN/RED framing is exemplary;
  regression tests pin the anti-patterns.
- **Philosophy** — first-person + "my human" throughout; every "the user" is an
  infra comment; injected context blocks author literal "my human", not macros.
- **Wiring** — `audit:wiring` 0/422, `audit:mcp` clean, all 117 tools executable +
  reachable, no dead internal helpers in the orchestration files, no orphaned
  modules.
- **Degradation** — no route/loop/tool can 500 the chat turn; loops carry
  off-switches; the audio-worker duplicate-key regression has NOT recurred; the
  Discord audience gate is fail-closed; SSRF/secret handling in `browser/` is
  correct; `search_restricted` fail-open is the documented, signed tradeoff.
- **Fail-closed privacy** — the two-axis content gate (Phylactery + Node) is
  consistently fail-closed apart from the two graph gaps above.

---

## Suggested fix plan

**Batch A — the three themes (highest value, do as campaigns):**
1. Time-model seam (Theme 1) — `db.now_local()` + route Node dating through
   `wardLocalNowISO`; **`server.js:7195` needs ward sign-off** (safety loop).
2. RULE A/B/C sweep (Theme 2) — fix guide-chat, streaming SSE reasoning fold,
   the sub-4000 caps, and the zai-vision `isError` check.
3. Slug-id campaign (Theme 3) — route the five id sites through the shared helper;
   villager-id is the big one (reference-chasing migration).

**Batch B — trivial wins:** delete the dead code/imports and stale aliases; fix
the "UTC" stale comments; the aria-label/`for=` WCAG nits.

**Batch C — extractions:** the duplication list (buildMemorizePayload,
readSettingsLocal, buildThalamusEnvelope, buildHistoryForPrompt, the reconnect
factory, etc.) — behavior-preserving, add tests.

**Ward decisions (no code change until you say):** the triage/care-check
equal-weight & hedge phrasings; the two graph privacy gaps; the `!consent`/`/update`
gating; the graduation & dedup silent-loss behaviors.

None of Batches A–C are safety-behavioral except the two flagged sign-off points.
Everything ships as behavior-preserving fixes with tests, per the graceful-
degradation rule.
