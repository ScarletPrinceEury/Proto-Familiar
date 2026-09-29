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

### Settings access — centralization is incomplete (headline finding)

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

- ☐ root Node: server.js, thalamus.js, cerebellum.js, relative-time.js, tool-surfacing.js, macros.js, message-sanitize.mjs, providers.js, llm-call.js, organs.js, own-files.js, slug-ids.js, settings-store.js, mcp-reconnector.js, phylactery-result.js, name-field.js, updater.js
- ☐ src/safety, src/memory, src/pondering, src/schedule, src/village, src/vision, src/voice, src/weather, src/search, src/browser, src/gcal, src/sessions, src/discord, src/server
- ☐ phylactery/src/phylactery/*.py
- ☐ unruh/src/unruh/*.py
- ☐ public/ (app.js, graph-map.js, voice-call.js, index.html, style.css)
- ☐ scripts/
