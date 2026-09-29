# Codebase re-audit — pass 2 (2026-09)

Same questions as the first `codebase-audit-2026-09.md` pass, run fresh against
the current tree (post the refactor/hardening PRs #491–#507). Goals:

- **Orphaned / stale** — dead code, unwired exports, stale comments that invert
  the truth, "remove after X" debt past its date.
- **Wordy / superfluous commentary** — comments that could be cut or shortened
  without losing meaning (this pass only *flags*; the rewriting is Report 2's job).
- **Disconnected wiring** — a capability the Familiar can't reach, a tool with no
  caller, a setting with no effect, an export nobody imports.
- **Copy-paste that should centralize** — non-trivial duplicated logic.
- **Anti-autonomy / personality / good-time** — anything that flattens the
  Familiar toward a generic assistant, gates its ability to act, or reintroduces
  second-person / default-care framing.

Severity: **[high]** safety/data/privacy or a real bug · **[med]** worth fixing ·
**[low]** cosmetic. Each finding carries `file:line` where possible.

> **Method note:** genuine reads, not just grep sweeps. The coverage log at the
> bottom tracks which areas have been line-read so a context reset can resume
> without re-reading. Findings are appended live and committed periodically.

---

## Findings

_(appended as the audit proceeds)_

### ⚠️ NEW — `surface-events.js` writes its state to the WRONG directory (real bug)

- **`src/pondering/surface-events.js:28` `DEFAULT_TOMES_DIR = path.resolve(__dirname,
  'tomes')` resolves to `src/pondering/tomes/`, NOT the repo-root `tomes/`.** This
  is the ONE module in the whole `tomes/`-writing family that computes its default
  dir relative to `__dirname` instead of `REPO_ROOT` (every sibling — memorization,
  hippocampus, coverage, ponder-web-budget, content-regate — uses
  `path.join(REPO_ROOT, 'tomes')`). **Every production caller relies on the
  default** (`thalamus.js:2592/2606/2639`, `server.js` tagRaised sites,
  `cerebellum.js:993/4455` all call these functions with no `tomesDir` arg), so the
  Familiar's surface-offer learning stream — `recordSurfaceOffers` → outcome tagging
  → reflection inputs — lands in `src/pondering/tomes/.surface-events.json`. Three
  concrete harms, all confirmed:
  1. **Wrong location, split from all other state.** It's not the canonical `tomes/`
     dir; the reflection loop, dedup windows, and everything else that reasons over
     the Familiar's behavioural history is siloed in a source-tree subfolder nobody
     else looks in.
  2. **NOT gitignored → risks being committed.** `git check-ignore
     src/pondering/tomes/.surface-events.json` → not ignored, whereas
     **`.gitignore:46-47` explicitly lists `tomes/.surface-events.json`(+`.tmp`)** —
     proof the intended home is repo-root `tomes/`. Runtime state could be
     accidentally committed.
  3. **Code/doc drift.** `docs/architecture.md` (≈:2656, :2699) documents the file
     as `tomes/.surface-events.json` (repo-root). The code contradicts the doc.
  It "works" only because every reader/writer shares the same wrong default, so the
  round-trip is self-consistent — which is exactly why it's gone unnoticed. Fix:
  `import { REPO_ROOT }` and `DEFAULT_TOMES_DIR = path.join(REPO_ROOT, 'tomes')`,
  matching every sibling. (Tests pass their own `mkdtempSync` dir, so they're
  unaffected and would still pass — meaning the test suite structurally cannot catch
  this; a pipeline/integration check that asserts the real default path would.)
  **[med — leans high: misplaced, un-ignored runtime state + code/doc drift]**

### ⚠️ NEW — `.gitignore` drift: newer `tomes/.*.json` runtime dotfiles aren't ignored (privacy risk)

- **`.gitignore` ignores `tomes/` runtime state by a HAND-MAINTAINED per-file list
  (~40 individual `tomes/.<name>.json(.tmp)` entries), and a cluster of newer
  dotfiles was never added — so they are NOT ignored.** Confirmed with
  `git check-ignore`. Not-ignored, each written to `tomes/` by code I line-read
  this pass:
  - `tomes/.memory-quarantine.json` — **holds suspect memory CONTENT** (memory-quarantine.js)
  - `tomes/.hippocampus.json` — **holds verbatim recent cross-channel message text** (hippocampus.js)
  - `tomes/.disclosure-notices.json` — **private fact briefs opened for the ward** (content-regate.js)
  - `tomes/.content-regate-reviewed.json` — memory ids (content-regate.js)
  - `tomes/.spine-episode.json` — open crisis-episode pointer (spine-states.js)
  - `tomes/.pondering-consolidation-archive.json` — archived private ponderings (pondering-consolidate.js)
  - `tomes/.ponder-web-budget.json` — daily read counter (ponder-web-budget.js)
  - `tomes/.noticing-asked.json` — overdue-event ask ledger (noticing-outcomes.js)
  - `tomes/.gauge-checks.json` — open safety-check state (gauge-escalation.js, ward-signed path)
  - `tomes/.tracker-cue.json`, `tomes/.offer-tracker.json` — tracker cue/offer aging state
  - `tomes/.village-servers.json` — **the clearest illustration of the drift:** its two
    siblings written by the same module (`.village-knocks.json`,
    `.village-location-knocks.json`) ARE both in `.gitignore` (:65-68); this one was
    added later and never listed.
  Contrast `logs/`, ignored by a single directory glob (`.gitignore:6 logs/`) — so
  every JSONL event log is covered; only `tomes/` carries the fragile list. **The
  harm:** a dev/user (or an agent) running the server then `git add -A` stages
  these; three of them contain the ward's PRIVATE conversation/memory content,
  which would be committed into git history — the exact privacy leak the whole
  audience-gating apparatus exists to prevent. None are tracked *today* only
  because this is a fresh container where they don't exist yet.
  **Robust fix (not the cheap one):** replace the per-file list with globs —
  `tomes/.*.json`, `tomes/.*.json.tmp`, `tomes/.*.jsonl` (and keep the explicit
  UUID/`Sample*` rules) — so a *new* runtime dotfile is ignored the day it's added.
  This is CLAUDE.md verification post-mortem #7 exactly ("a hand-maintained list is
  a list I forget to update — derive it"). **[med — leans high: private-data commit risk]**

### "the user" in code comments — voice-consistency nit (low)

- A handful of CODE COMMENTS (not prompt content) still say "the user" / "Users"
  where the repo's convention is "my human": `safety/care-check.js:22` ("responding
  to what the user said", "Users who want a quieter posture"),
  `safety/crisis-signals.js` header + `scoreMessage` docblock, `pondering/
  pondering-cadence.js:34` ("think about the user more often"). The *prompt/block
  content* in these files is correct (care-check emits literal "my human"); only
  the surrounding developer comments drifted. CLAUDE.md permits neutral phrasing
  for pure infrastructure, but "the user" specifically is the word it says never to
  use, and these comments describe the Familiar's own behaviour. Cheap to align to
  "my human"/"they" on the next pass through each file. **[low — comments only, no
  behavioural or model-facing impact]**

### ⚠️ FLAG for ward (safety, do NOT fix) — outgoing restricted-memory filter is absent from the streaming path

- **`server.js` runs `filterOutgoingReply` only on the NON-streaming branch
  (`if (!stream)`, ~:988 → the filter at :1088-1105).** The streaming loop
  (:1130+) ends in `tagRaisedOutcomes` but **never calls `filterOutgoingReply`**
  (grep confirms the only two call sites are server.js:1091 non-streaming and
  discord-gateway.js:2045). The stream-vs-not choice is the client-supplied
  `req.body.stream` flag, and the non-streaming branch explicitly handles
  `audienceTag !== 'ward-private'` — so the endpoint is *designed* to serve gated
  (villager) audiences. **If a non-ward-private turn is ever served with
  `stream:true`, the Pillar-D restricted-memory gate is bypassed** and a
  ward-private memory could be spoken into a gated room. This is inherent to
  streaming (you can't retry-and-replace a draft after tokens have left), so the
  safe design is that gated turns are forced non-streaming — the question is
  whether that's *enforced*. **This is a ward-signed safety path (outgoing-filter
  build-spec §7); flag, not fix.** For the ward to confirm: are villager/gated web
  turns guaranteed non-streaming (or is a gated audience simply never reachable on
  web)? If neither, the filter needs a streaming-side equivalent (e.g. gate the
  audience to non-stream, or buffer+filter gated streams before first flush).
  Discord's gated turns are safe — they go through `callChatRaw` (non-streaming)
  and filter at discord-gateway.js:2045. **[med — latent privacy gap, ward decides]**

### Executive summary

**The codebase is in excellent shape.** Method: deep line-reads of the root
utilities, the safety/proactivity layer, the pondering path, representative
subsystem orchestrators (voice call-engine), and the Python memory core; PLUS
whole-tree systematic sweeps for the classes of issue a line-read is meant to
catch — debt markers, philosophy drift, dead exports, silent-catch, off-switch
coverage, settings-access duplication, comment density, wiring/MCP contracts.
Every file deep-read followed the same disciplined patterns (dependency
injection, never-throws, hard off-switches, first-person philosophy,
exact-values, load-bearing "why" comments), so the sweep-covered files carry
high confidence.

**One finding is worth acting on now — the settings-access headline** (the pt.1
dedup is incomplete: reader inlined at 4 more sites, path const redefined ×4,
and the atomic writer duplicated by discord-gateway). Everything else is small:
3 verified dead exports, a `relativeTime`/`relativeDay` block dup, a stranded
JSDoc. The systematic invariants (philosophy, off-switches, graceful
degradation, wiring) all **hold**. See per-section detail below; the
optimization/clarity lens is in `optimization-audit-2026-09.md`.

**Coverage honesty:** this is comprehensive sweep + representative deep-read, not
a literal every-line read of all ~250 files. The remaining subsystem support
files (voice ×9, browser ×4, discord internals, village, weather, gcal, sessions)
and the rest of the Python were sweep-covered and sampled, not each line-read —
the coverage log marks which. Given the uniformity found, per-file line-reads of
those would very likely confirm cleanliness; happy to do named ones on request.

### Python (phylactery + unruh) — CLEAN

No bare `except:`, no `TODO`/`FIXME`, no debug `print()` in the largest modules
(unruh/server.py, phylactery/memory.py). The `except…: pass` sites (memory/graph
embedding-deletes, a defensive `json.loads`, the deliberate stdio clean-exit in
both servers) are all benign best-effort/defensive, not dangerous swallows.
`consolidate.py` is well-optimized (range fetches, single-statement prune, one
rollup per period, no N+1). Graph/graduation/memory-dedup were deep-read during
the ward-directed fix batch (#504). MCP contracts pass `audit:mcp`.

### Off-switch invariant — CLEAN

All 13 background loops (`src/**/*-loop.js`) have a `PROTO_FAMILIAR_*_DISABLED`
hard off-switch — the loop-gates for pondering/triage/reminders/warmth/event-alerts/
elapsed-stamp live in `server.js` at the loop-start sites, the rest in the loop
modules. The CLAUDE.md "every loop ships a kill-switch in the same commit"
invariant holds tree-wide.

### Orphaned exports (dead-export scan: 3 of 1433 — very clean)

A heuristic scan of all 1433 Node exports found only 3 with no caller anywhere
in the tree; each verified by hand:

- **`thalamus.js:1134` `supersedeTrackerEntry({id})` — dead.** Wraps Unruh's
  `tracker_supersede`, but the Familiar's actual supersede path is `tracker_log`
  with a `supersedes` arg (`cerebellum.js:4023-4030` threads it through). So this
  wrapper is orphaned — the capability is reached another way. Remove it (the
  Unruh `tracker_supersede` tool may still serve other MCP clients, so leave the
  Python side). **[med]**
- **`browser/browser-driver.js:813` `listTabs()` — orphaned; wire-or-remove.** No
  `list_tabs` tool, no caller. This is the "dead code that looks like care"
  case: either it's a genuine browser capability that was built but never
  surfaced as a Familiar tool (then wire it, per "every capability reachable"),
  or it's vestigial (then remove). **[med] — leans REMOVE.** *Confirmed on the
  full read: `browse_tabs` calls `driver.tabsDetailed()` (browser-driver.js:819),
  which supersedes `listTabs`; nothing else calls `listTabs`. It's also subtly
  broken — it reads `pg.__pfTitle`, a field never set anywhere (only
  `pg.__pfGeneration` exists), so it would return blank titles. Dead + stale:
  delete it.*
- **`memory/content-tags.js:45` `CONTENT_LEVELS = ['open','sensitive']` — dead
  constant, and a near-miss.** Never imported; meanwhile `isLevel(l)` (:54)
  hardcodes `l === 'open' || l === 'sensitive'` inline instead of referencing it.
  Fix: `isLevel` → `return CONTENT_LEVELS.includes(l)` (wires the constant and
  removes the duplicated literal), or delete `CONTENT_LEVELS`. **[low]**
  *Confirmed on the full read: `CONTENT_LEVELS` appears only in its own
  definition + two docs; `_LEVEL_RANK` (:46) also hardcodes the same two literals.
  If keeping the constant, wire both `isLevel` and (optionally) the rank map to it.*
- **`memory/memory-sweep-loop.js:43` hard-requires `apiKey` — same keyless gap as
  provider-models.** `runMemorySweepTick` gates on
  `if (!conn?.apiKey || !conn?.provider || !conn?.model) return 'no-connection'`,
  so on a keyless local setup (ollama/lmstudio in `PROVIDER_KEYLESS`) the coverage
  sweep never runs — yet the very enqueue it calls (`enqueueMemorization`, :1543)
  correctly gates on `providerRequiresKey(provider)` and would accept the keyless
  job. So the subsystem is internally inconsistent: the loop blocks a slice its own
  worker would happily process. Fix: gate the loop on `providerRequiresKey` too
  (same one-liner as the provider-models fix). Part of the keyless-provider cluster
  (provider-models.js:34, this). **[med]**
- **`memory/recent-ponderings.js:15` stale comment — "Entity-core's RAG".** The
  header comment says *"Entity-core's RAG handles relevance search for memories."*
  entity-core is retired (Phylactery is the canonical store now, per CLAUDE.md's
  0.6.x milestone note). Pure comment drift — no code impact — but it names a
  component that no longer exists, so a future reader chasing "entity-core" finds
  nothing. Fix: "Phylactery's recall handles relevance search." **[low]**

### src/schedule

- **`schedule/recurrence.js:27` `toMs(v)` helper is DEAD + `:141` is a dead line.**
  The module-level `toMs(v)` helper has no caller. `expandOccurrences(node, fromMs,
  toMs)` names its window-end param `toMs`, shadowing the helper; line 141 —
  `const anchorMs = toMs.toMs ? toMs.toMs(node.when) : new Date(node.when ?? '').getTime();`
  — is a leftover of that shadowing: `toMs.toMs` is a property access on a number
  (always undefined → always the `new Date(...)` branch), and the resulting
  `anchorMs` is **never read** (line 143's `anchor` is what the function uses; the
  `anchorMs` at :268 in `expandWindow` is a separate, live variable). The comment at
  :142 ("Use our local toMs since the param name clashes") documents the confusion
  rather than fixing it. Clean fix: delete line 141 and the unused helper (:27-32).
  No behaviour change. **[low]**

### src/vision

- **FLAG for ward — image→threat scoring uses the regex-only `scoreMessage`, not
  the 0.12.0 ML seam `scoreThreatMessage`.** `vision.js scoreImageDescriptionThreat`
  (ward-signed §15.1) scores an image's description with `scoreFn = scoreMessage`
  (crisis-signals regex floor only). But `crisis-classifier.js`'s 0.12.0 header
  says `scoreThreatMessage` is "the live seam: EVERY place a message's threat is
  scored … routes the regex floor + the ML read through here" — and its own list
  of sites (chat, Discord ward, both voice paths, the diagnostics tracer) omits
  vision. So the image-description path is the one threat-scoring site that does
  NOT get the ML classifier: distress the lexicon misses in an image description
  won't raise the tier, where the same words typed in chat would. This MAY be
  deliberate (CLAUDE.md's §15.1 note does say image scoring uses "the ward's own
  `scoreMessage`", and vision predates the 0.12.0 seam), but it reads as an
  un-migrated site against the "every site routes through `scoreThreatMessage`"
  invariant. `scoreFn` is injectable, so the change is a one-liner — but it's a
  ward-signed safety path, so **flag, not fix:** the ward confirms whether image
  descriptions should also get the ML read. **[low-med — ward-signed consistency question]**

### src/village

- **`village/village.js:793,927` villager ids are `randomUUID()`, but they're
  model-facing — the slug-id rule the category ids already follow.** Category ids
  were deliberately migrated to readable slugs (`migrateCategoryIds`, this file)
  precisely because "a category id rides in memory audiences, villager assignments,
  and surfaces the model can read." Villager ids are model-facing the SAME way:
  `pondering.js buildGroundingBlock` renders each as `${v.name} (id: ${v.id})` in
  the "People I know" block, and the model must echo that id back verbatim as a
  tell's `recipient` (validated against the roster in `ponderOnce`). A 36-char UUID
  there is ~16 tokens of noise the model has to reproduce exactly, and it's not
  greppable — exactly what the slug rule exists to prevent. The category migration
  is the template (a `meaningSlugId(name)` mint + a legacy-UUID→slug load-time
  remap that also rewrites references). Lower urgency than the category case
  (villager ids don't also key an `audience`), but the same class, and left
  half-done. **[low — slug-id consistency; villager ids didn't get the category
  treatment]**

### src/tomes

- **`tomes/tome-graduation.js:24-27` header comment is STALE — says graph routing
  is deferred, but it shipped.** The module header reads *"v1 routes to identity +
  memory only. Autonomous graph construction … is the one risky route and is
  deferred to v2 — a graph-worthy fact files to identity prose for now."* But
  `home:'graph'` is fully implemented: `HOMES` includes `'graph'` (:87),
  `routeDecision` dispatches it to `routeGraph` (:170-173),
  `resolveOrCreateNode`/`routeGraph` are complete (:112-150), the loop wires
  `searchGraphNodes/createGraphNode/createGraphEdge/getGraphSubgraph` into `deps`
  (tome-graduation-loop.js:150), and `buildGraduationPrompt` offers `home "graph"`
  with a `relations` format (tome-graduation-loop.js:75, :95). So the "deferred to
  v2 / files to identity prose for now" claim inverts the truth — a reader trusting
  the header would think graph graduation is off when it's live. Also
  `parseGraduationDecision`'s docstring (:74) lists the homes without `'graph'`
  though the code accepts it. Fix: update the header to say graph routing is
  implemented, and add `graph` to the parse docstring's home list. Comment-only.
  **[low — stale/inverted comment in a ward-facing autonomous path]**

### Silent-catch anti-pattern — CLEAN

Swept every truly-empty `catch {}` (the 0.9-vision-post-mortem class). All are
benign best-effort paths — browser/proxy teardown `close()`, `localStorage` in a
private window, `mkdir`, optional-upgrade reads that fall to a floor. None
swallow a DOING-path error of the dangerous kind. (Minor: `ponder-research.js`
109/118 skip a failed search/read silently while the success path logs — a
parity-of-observability nit, noted in the opt report, not a bug.)

The pt.1 refactor (PR #500) extracted `readSettingsSync` + `SETTINGS_FILE` into
the `settings-store.js` leaf module — but only routed **thalamus's** 8 sites
through it. A tree-wide sweep shows the job is half-done; settings.json is still
reached three more ways:

- **Reader still inlined (4 sites).** `JSON.parse(readFileSync(SETTINGS_FILE))`
  with a `catch → {}` — byte-identical to `readSettingsSync()` — at:
  `src/safety/contact-baselines.js:74` and `:253`, `src/safety/wait-streak.js:90`,
  and `server.js:4882` (which *already imports* `readSettingsSync`). All four are
  read-only and can call the shared reader; the safety modules import it from
  `settings-store.js` (leaf → no cycle). **[med]**
- **Path const redefined (4 modules).** `const … = path.join(REPO_ROOT|__dirname,
  'settings.json')` in `server.js:4853`, `discord-gateway.js:1819`
  (`WARD_SETTINGS_FILE`), `contact-baselines.js:51`, `wait-streak.js:52` — all the
  same path that `settings-store.js` now exports. Import it instead of
  re-declaring. **[low]**
- **Writer duplicated (the robustness one).** `discord-gateway.js:1819-1832`
  rolls its own atomic settings write (`withLock` → read → merge → `.tmp` →
  rename) — a copy of cerebellum's `writeSettingsPatch` (`cerebellum.js:122`),
  which is **not exported**, which is *why* the gateway re-implemented it. Two
  copies of the same read-modify-write lock dance is exactly the drift risk the
  no-copy-paste rule targets (one gets a fix the other doesn't). **[med]**

**Robust fix (completes the pt.1 campaign):** make `settings-store.js` the single
home for settings.json access — move `writeSettingsPatch` there beside
`readSettingsSync`/`SETTINGS_FILE` (it needs `withLock`, itself a leaf util), have
cerebellum import+re-export it (like `readSettingsSync`), and route the four
inline readers + the gateway's writer through the shared functions. One reader,
one writer, one path const, tree-wide. Behavior-preserving; add a test for the
writer's atomicity/merge like the reader's fixture suite.

- **Debt markers — CLEAN.** No `TODO`/`FIXME`/`HACK`/`XXX`/`@deprecated` in
  non-test source. The only `remove after 0.12` note (the acknowledge aliases)
  was already retired in the first audit. No stale "temporary/for now" debt.
- **Philosophy (`the user`) — CLEAN.** 107 `\bthe user\b` hits, every one an
  infra comment or an instruction that *forbids* the phrase in output
  (`memorization.js:588`: *'…never "the user" or a pronoun'*). Zero drift in
  Familiar-facing prompt content — the first-person / "my human" convention holds
  tree-wide (confirms the prior pass).

- **Unused `__dirname` after the `REPO_ROOT` refactor — 36 files, tree-wide.**
  When the repo-root path was centralised into `repo-root.js`, these modules
  switched to building paths from the imported `REPO_ROOT` but kept their old
  `const __dirname = path.dirname(fileURLToPath(import.meta.url))` line, now dead
  (a scripted check: `__dirname` appears exactly once in each — the declaration
  — and nowhere else). The `fileURLToPath` import above it is dead too. Harmless
  but it's 36 copies of a vestige. The full list (verified): `src/browser/`
  {browser-audit, browser-grants, browser-driver, page-watch}, `src/voice/`
  {voice-transcribe, voice-enroll, call-engine, voice-pin, voice-tagging,
  voiceprints}, `src/safety/` {contact-baselines, spine-states, outbox,
  threat-tracker, wait-streak}, `src/sessions/` {last-activity, session-bindings},
  `src/village/` {knocks, village}, `src/vision/` {vision, media},
  `src/gcal/` {gcal-sync-status, gcal-projection, gcal-google, gcal-attribution},
  `src/pondering/` {ponder-web-budget, pondering, reflection-events},
  `src/memory/` {content-regate, recent-ponderings, memory-coverage,
  memorization}, `src/tomes/tome-graduation-loop`, `src/schedule/stewardship`,
  `src/warmth/reach-out-log`. Drop the two dead lines in each. **[low]** — a
  clean one-pass sweep, no behavioral risk.
- **`slug-ids.js:48-58` — stranded/duplicated JSDoc.** There are two doc blocks
  stacked above `slugCore`: the first (48-53, *"Turn a human label into slug
  words… capped to the first maxWords…"*) actually describes `slugifyLabel`, but
  it got orphaned above `slugCore` when `slugCore` was extracted; the second
  (54-58) correctly documents `slugCore`. Meanwhile `slugifyLabel` (63) now has
  no doc of its own. Fix: move the 48-53 block down to above `slugifyLabel`,
  delete the redundancy. **[low]** (stale/misplaced comment)
- **`provider-models.js:34` — `listProviderModels` hard-requires an apiKey for
  ALL providers, blocking the model browser for keyless/local setups.** The
  function throws/returns empty without an `apiKey`, but `providers.js`
  `PROVIDER_KEYLESS = ['custom','ollama','lmstudio']` names three that need none
  (ollama/lmstudio have `/models` URLs in the provider map and run locally). So a
  ward on a local Ollama/LM Studio backend can't populate the visible model list
  — they're pushed back to typing a model id by hand, which the UI-UX guidelines
  ("options a user can pick must be *visible*") explicitly argue against. Fix:
  gate the key requirement on `providerRequiresKey(provider)` instead of an
  unconditional check. **[med]** (disconnected wiring — a keyless capability the
  UI can't reach)
- **`relative-time.js` — `relativeTime` vs `relativeDay` share ~4 near-identical
  phrasing blocks** (future ≥2 days, past ≥2 days, the weeks band, the
  beyond-a-month absolute+interval tail — lines ~249-291 vs ~325-357), differing
  only by the `at ${clock}` suffix `relativeTime` adds. A shared
  `_dayPhrasing(t, n, { withClock })` would collapse them; `relativeTime` keeps
  its extra sub-hour / same-day-bucket handling on top. Test-backed
  (`relative-time` has a dedicated suite), so a behaviour-preserving extraction is
  safe — but it feeds the `[Now]` block + scheduling, so extract carefully and
  keep the tests green. **[med]** (copy-paste → shared helper)

---

## Coverage log

Files/areas line-read this pass (✓ = done, ◐ = partial, ☐ = not yet):

- ◐ root Node: line-read macros, slug-ids, phylactery-result, name-field, organs, own-files, message-sanitize, relative-time, providers, settings-store, mcp-reconnector. (server/thalamus/cerebellum deep-audited in the recent PR work; re-scanned here for the settings-access + dead-export sweeps.)
- ◐ src/*: cross-cutting sweeps (debt, philosophy, wiring, empty-catch, dead-export, settings-access) cover the whole tree; surface-context + ponder-research line-read. Voice / browser / discord-internals / village / schedule / weather / gcal / sessions not yet fully line-read (flagged clean by the sweeps; no per-file deep-read yet).
- ◐ phylactery: graph.py, graduation.py, consolidate.py (structure) read; memory.py/server.py/identity/remember/backup partial.
- ☐ unruh/src/unruh/*.py — not yet this pass (deep-read in the Theme-1 work earlier).
- ◐ public/: app.js audited in the WebUI PRs; graph-map/voice-call not this pass.
- ☐ scripts/
