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

### Cross-cutting sweeps (whole tree)

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
