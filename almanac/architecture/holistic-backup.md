---
title: Holistic Backup
topics: [architecture, backup, phylactery]
sources:
  - id: architecture-doc
    type: file
    path: docs/architecture.md
  - id: holistic-backup-js
    type: file
    path: src/backup/holistic-backup.js
  - id: server-js
    type: file
    path: server.js
  - id: thalamus-js
    type: file
    path: thalamus.js
  - id: phylactery-server-py
    type: file
    path: phylactery/src/phylactery/server.py
  - id: unruh-server-py
    type: file
    path: unruh/src/unruh/server.py
  - id: app-js
    type: file
    path: public/app.js
  - id: index-html
    type: file
    path: public/index.html
  - id: holistic-backup-test
    type: file
    path: tests/holistic-backup.test.mjs
  - id: holistic-restore-test
    type: file
    path: tests/holistic-restore.test.mjs
  - id: export-commit
    type: commit
    ref: "14b9d1b"
    note: "Holistic backup, Stage 1 (export): the whole Familiar in one encrypted file (0.12.23-alpha)"
  - id: import-commit
    type: commit
    ref: "d84ebaf"
    note: "Holistic backup, Stage 2 (import/restore): safe overwrite of a live install (0.12.24-alpha)"
---

# Holistic Backup

Holistic backup bundles the whole Familiar — Phylactery's identity and memory store, Unruh's
temporal store, every tome, and `settings.json` — into one passphrase-encrypted `.pfbackup` file
a ward can keep for disaster recovery or carry to new hardware [@architecture-doc]. It shipped in
two stages: export (0.12.23-alpha) built the file, and import/restore (0.12.24-alpha) added the
dangerous half, overwriting a live install from one [@export-commit] [@import-commit]. The
feature exists because [Phylactery](phylactery) already had its own encrypted backup, but nothing
covered tomes, Unruh, or settings together — the exact gap that let the pondering
consolidation data-loss incident happen with a "backup" already in hand. See
[Archive before destructive autonomous writes](../decisions/archive-before-destructive-autonomous-writes)
for that incident; holistic backup is the structural answer to the backstop it found missing.

## Why a second backup mechanism

Phylactery's own `backup.py` (`POST /api/entity/backup/{export,restore}`) is older and narrower:
it `VACUUM INTO`s a consistent copy of Phylactery's own database, encrypts it with a
passphrase-derived key (PBKDF2-HMAC-SHA256 → Fernet/AES), and writes one `.phylactery` file
[@architecture-doc]. It never touches tomes, Unruh, or `settings.json`. When a pondering
consolidation fold hard-deleted months of the Familiar's own ponderings, a ward holding a
Phylactery backup still had no way to get that writing back, because ponderings live in a tome
file, not in Phylactery's database. Holistic backup is a separate, later mechanism that closes
that gap for the whole self at once, rather than an upgrade to `backup.py`; both mechanisms ship
side by side today, and both surfaces sit in the same Knowledge editor → Snapshots tab
[@index-html].

## The `.pfbackup` format

A `.pfbackup` file is `"PFBKP1\n"` magic (7 bytes) + a version byte + a 16-byte salt + a 12-byte
IV + a 16-byte GCM auth tag + the AES-256-GCM ciphertext of a gzipped tar
[@holistic-backup-js]. The key is derived from the ward's passphrase with scrypt (`N=32768, r=8,
p=1`), tuned with a raised `maxmem` because the default cost parameters exceed Node's 32 MB
scrypt memory ceiling [@holistic-backup-js]. GCM's auth tag means a wrong passphrase or a
tampered file fails to decrypt rather than silently producing garbage — `decryptBundle` turns
that failure into "could not decrypt — wrong passphrase or the file is damaged" [@holistic-backup-js].

Inside the tar is a staging tree: `manifest.json`, `phylactery.db`, `unruh.db`, `tomes/`,
`settings.json`, and optionally `media/` and `logs/` [@holistic-backup-js]. The manifest — format
tag, backup version, the app version that created it, a timestamp, and the list of what was
actually included — lives inside the encrypted tar rather than in the clear, so listing a
backup's contents still requires the passphrase [@holistic-backup-js]. `encryptBundle` and
`decryptBundle` are the pure crypto seam the rest of the module is built on, tested independently
of the file-assembly and MCP-calling code around them [@holistic-backup-test].

## Stage 1: building and exporting a backup

`createHolisticBackup({ rootDir, outPath, passphrase, includeMedia, includeLogs, ... })` does the
work in a temp staging directory, cleaned up in a `finally` block whether it succeeds or throws
[@holistic-backup-js]:

1. **Clean database snapshots.** It calls injected `snapshotPhylactery`/`snapshotUnruh`
   functions, which in production are `thalamus.js`'s `snapshotPhylacteryDb`/`snapshotUnruhDb`
   [@thalamus-js]. Both route to a new `db_snapshot` MCP tool on each Python service that runs
   `VACUUM INTO` against a caller-owned temp path — a compacted, consistent single-file copy that
   is safe to take even while the service is live and WAL-mode is in use [@phylactery-server-py]
   [@unruh-server-py]. The snapshotters are injected specifically so `createHolisticBackup` is
   testable without a real MCP connection [@holistic-backup-js].
2. **File-store copies.** `tomes/` and `settings.json` are always copied into the staging tree;
   `media/` and `logs/` are copied only if the ward opts in, because both are bulky and default
   off to keep the ordinary backup small [@holistic-backup-js] [@index-html].
3. **Manifest, then tar, then encrypt.** A `manifest.json` records exactly what got included,
   the tree is gzip-tar'd, and the tar is passed through `encryptBundle` with the ward's
   passphrase to produce the final `.pfbackup` bytes [@holistic-backup-js].

`POST /api/backup/export` drives this to a temp file and streams it back as a download, deleting
the temp file once the response finishes or fails [@server-js]. The UI is the "Full backup" card
in the Knowledge editor's Snapshots tab: a passphrase field (minimum 4 characters), checkboxes
for including logs and media, and a "Download full backup" button that names the passphrase
requirement plainly — losing it makes the file unopenable, by design [@app-js] [@index-html].
Voice **model** files are deliberately excluded: they are large, re-downloadable, and the backup
instead preserves the *choice* of voice through the included `settings.json`
[@architecture-doc] [@index-html]. See [Voice](voice)'s licensing section for the sibling detail
that this exclusion leaves open — `belongsInIdentityBackup()` marks every voice as identity-critical
regardless of provenance, but nothing in this pipeline calls it, so a ward-supplied voice clip's
survival across a restore still depends on whether `includeMedia` was checked at export time, not
on that predicate.

## Stage 2: importing and restoring a backup

Stage 2 overwrites a live install, so it runs a safety spine in a fixed order rather than doing
the obvious thing (decrypt, then swap) [@server-js]:

1. **Validate before touching anything live.** `extractBackup(filePath, passphrase)` decrypts,
   untars into a fresh staging directory, and parses and checks the manifest's format tag — a
   wrong passphrase, a tampered file, or a manifest that does not say
   `proto-familiar-holistic-backup` throws before any live file or database is touched
   [@holistic-backup-js].
2. **Make a pre-restore safety backup of the current state.** Using the same
   `createHolisticBackup` path and the same passphrase, the server backs up whatever is currently
   live into `.pf-backups/pre-restore-<timestamp>.pfbackup` before changing anything. If that
   safety backup cannot be made, the restore refuses to proceed at all — the restore is only
   allowed to be destructive because it is also, structurally, undoable [@server-js].
3. **Lay down the file stores.** `layDownFileStores({ rootDir, stagingDir })` copies the backup's
   `tomes/`, `settings.json`, and any included `media/`/`logs/` over the live ones, but renames
   each current one aside to `<name>.pre-restore-<timestamp>` first rather than deleting it
   [@holistic-backup-js]. This step never touches either database.
4. **Swap and reconnect the databases.** For each database the manifest says it included, the
   server calls a new `db_restore_plain` MCP tool on the matching service. Each one sanity-checks
   the incoming file before clobbering anything — Phylactery requires a `memories` table,
   Unruh requires a `nodes` table — refusing a file that opens but is not actually that service's
   database shape, then removes the live db plus its WAL/SHM files and copies the snapshot in
   [@phylactery-server-py] [@unruh-server-py]. `thalamus.js`'s `restorePhylacteryDb` and
   `restoreUnruhDb` wrap the tool call and reconnect the MCP child afterward
   (`reconnectUnruh` was added specifically to mirror the existing `reconnectPhylactery`, since
   Unruh had no equivalent reconnect path before this feature) [@thalamus-js].

`POST /api/backup/import` accepts the raw `.pfbackup` bytes as an `application/octet-stream` body
(up to 512 MB) and reads the passphrase from an `X-Backup-Passphrase` header rather than the URL
or JSON body, so it never lands in a request log [@server-js]. The response reports per-database
results, which file stores were restored, where the pre-restore safety backup landed, and
`restartRecommended: true` — boot-time reads (most settings) only refresh on process restart, so
the ward still needs to restart the app for a restore to fully take effect [@server-js]. The UI
requires an explicit confirmation before running ("This overwrites everything ... a safety backup
of the current state is made first"), and surfaces the pre-restore backup's path in both the
success and failure messages, so a partially-failed restore still tells the ward exactly where
their prior state landed [@app-js] [@index-html].

## Failure handling

Every step that can leave the system in a bad state is designed to fail toward the safer side.
A wrong passphrase or corrupt upload is rejected in step 1, before anything live changes. A
failed pre-restore safety backup aborts the whole restore in step 2 — the server would rather do
nothing than proceed without an undo path. `layDownFileStores` never deletes a current file
store outright; it always renames it aside first, so an interrupted or partially wrong restore
still leaves the previous `tomes/`/`settings.json` recoverable on disk under a
`.pre-restore-<timestamp>` name. Database restores are reported per-service (`dbResults.phylactery`,
`dbResults.unruh`), so a failure on one database does not hide alongside a success on the other —
the response's `ok` flag is the logical AND of both, and the note field points the ward back at
the pre-restore backup if anything failed [@server-js]. Both stages are covered by dedicated test
suites: `holistic-backup.test.mjs` exercises the crypto round-trip, tamper and wrong-passphrase
rejection, and the full build-decrypt-untar-manifest round trip; `holistic-restore.test.mjs`
covers `extractBackup`'s validation and `layDownFileStores`'s aside-renaming into both empty and
already-populated roots [@holistic-backup-test] [@holistic-restore-test].

## Where to go next

- [Archive before destructive autonomous writes](../decisions/archive-before-destructive-autonomous-writes)
  — the pondering data-loss incident that exposed the gap this feature closes, and the general
  archive-before-delete rule it established for any future destructive autonomous operation.
- [Phylactery](phylactery) — the canonical identity/memory store whose own, narrower
  `backup.py` mechanism predates and still runs alongside holistic backup.
- [Voice](voice) — the `belongsInIdentityBackup()` / `mayLeaveTheMachine()` distinction for
  ward-supplied voice clips, and why the former still has no caller in this pipeline.
- [Engineering conventions](../reference/engineering-conventions) — the "Robust over cheap"
  priority order that motivates validating before mutating and backing up before overwriting.
