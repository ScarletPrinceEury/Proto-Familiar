# Tome format sample (`tome-format-sample.json`)

`tome-format-sample.json` (moved here from the repo-root `Research/` folder in
the audit-fixes pass) is a **reference export of the Tome / world-info format** —
a real SillyTavern-style lorebook export kept as ground truth to compare
existing tomes against. It is NOT loaded by the app; it's documentation.

Use it when touching anything that reads, writes, imports, or migrates tome
entries (`server.js` tome endpoints, `memorization.js` entry shape,
`docs/sillytavern-worldinfo-architecture.md`) to confirm the field set and
per-entry structure (`entries[uid]` with `key`/`keysecondary`/`content`/
`comment`/`position`/`depth`/`probability`/… ) matches what the ecosystem
expects.
