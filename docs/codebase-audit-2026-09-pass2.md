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

---

## Coverage log

Files/areas line-read this pass (✓ = done, ◐ = partial, ☐ = not yet):

- ☐ root Node: server.js, thalamus.js, cerebellum.js, relative-time.js, tool-surfacing.js, macros.js, message-sanitize.mjs, providers.js, llm-call.js, organs.js, own-files.js, slug-ids.js, settings-store.js, mcp-reconnector.js, phylactery-result.js, name-field.js, updater.js
- ☐ src/safety, src/memory, src/pondering, src/schedule, src/village, src/vision, src/voice, src/weather, src/search, src/browser, src/gcal, src/sessions, src/discord, src/server
- ☐ phylactery/src/phylactery/*.py
- ☐ unruh/src/unruh/*.py
- ☐ public/ (app.js, graph-map.js, voice-call.js, index.html, style.css)
- ☐ scripts/
