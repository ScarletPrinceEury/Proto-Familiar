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
  or it's vestigial (then remove). **Ward/design call which.** **[med]**
- **`memory/content-tags.js:45` `CONTENT_LEVELS = ['open','sensitive']` — dead
  constant, and a near-miss.** Never imported; meanwhile `isLevel(l)` (:54)
  hardcodes `l === 'open' || l === 'sensitive'` inline instead of referencing it.
  Fix: `isLevel` → `return CONTENT_LEVELS.includes(l)` (wires the constant and
  removes the duplicated literal), or delete `CONTENT_LEVELS`. **[low]**

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

- **`slug-ids.js:48-58` — stranded/duplicated JSDoc.** There are two doc blocks
  stacked above `slugCore`: the first (48-53, *"Turn a human label into slug
  words… capped to the first maxWords…"*) actually describes `slugifyLabel`, but
  it got orphaned above `slugCore` when `slugCore` was extracted; the second
  (54-58) correctly documents `slugCore`. Meanwhile `slugifyLabel` (63) now has
  no doc of its own. Fix: move the 48-53 block down to above `slugifyLabel`,
  delete the redundancy. **[low]** (stale/misplaced comment)
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
