---
title: Installer And Launcher
topics: [architecture, installer]
sources:
  - id: getting-started
    type: file
    path: docs/getting-started.md
  - id: install-sh
    type: file
    path: install.sh
  - id: install-bat
    type: file
    path: install.bat
  - id: win-install-ps1
    type: file
    path: scripts/win/install.ps1
  - id: win-tray-ps1
    type: file
    path: scripts/win/tray.ps1
  - id: vbs-launcher
    type: file
    path: Proto-Familiar.vbs
  - id: ensure-port-free
    type: file
    path: scripts/ensure-port-free.mjs
  - id: engineering-conventions
    type: file
    path: CLAUDE.md
  - id: macos-launcher
    type: file
    path: Proto-Familiar.command
  - id: stop-sh
    type: file
    path: stop.sh
  - id: start-bat
    type: file
    path: start.bat
  - id: pid-file
    type: file
    path: src/server/pid-file.js
  - id: server-js
    type: file
    path: server.js
---

# Installer And Launcher

Proto-Familiar ships a one-click installer and launcher for each platform, so
"clone, `npm install`, `npm start`" is no longer the primary onboarding path —
it still works as an explicit advanced-user fallback, but the double-click
path is what `docs/getting-started.md` leads with [@getting-started]. On
Windows, `Proto-Familiar.vbs` runs `scripts/win/install.ps1` on first launch
and then `scripts/win/tray.ps1`, a PowerShell + WinForms system-tray app
[@vbs-launcher] [@win-tray-ps1]. On macOS, `Proto-Familiar.command` is a
double-clickable Finder entry point that runs `install.sh` and then
`node server.js` in the foreground. On Linux, `install.sh` registers a
`.desktop` entry under `~/.local/share/applications/`, and `start.sh` /
`stop.sh` stay the primary CLI [@install-sh]. `install.bat` / `start.bat` /
`stop.bat` are plain-CLI fallbacks for machines where PowerShell execution is
locked down [@install-bat].

This subsystem carries several invariants that were each the fix for a real
bug found while building it. A future change here should preserve all of
them, not just the happy path.

## Install and update share one idempotent script

`install.sh` and `scripts/win/install.ps1` (and the `install.bat` fallback)
each do double duty as both the fresh-install path and the update path. Mode
is detected by whether `node_modules/` already exists — update mode adds
`git pull --ff-only` and skips straight to the dependency-sync steps
[@install-sh] [@win-install-ps1]. Every step in both modes is idempotent,
including shortcut and desktop-entry creation: shortcut creation used to be
gated on "fresh install only," which silently broke restore and
manual-cleanup scenarios where update mode ran but no shortcut had ever been
created. It now checks for the shortcut's existence directly and creates it
in either mode [@install-sh] [@win-install-ps1].

This matters because the installer is meant to be safely re-run causally —
for example by double-clicking the launcher a second time — without risk to
identity data. Before any git operation in update mode, the script takes a
defensive copy of the at-risk directories (`tomes/`, `logs/`,
`phylactery/data/`, plus `.proto-familiar-config.json` and `settings.json` on
Windows) into `.pf-backups/<timestamp>/` [@install-sh] [@win-install-ps1].
This backup is independent of git's own protections (untracked files being
left alone, `--ff-only` refusing a dirty-conflict merge) — it exists so that
re-running the installer never carries a "did I just lose my memories" risk,
even if git's protections were somehow insufficient.

## uv materializes the Phylactery and Unruh environments

The installer never calls `pip`/`venv` directly for the in-tree Python
services. `uv sync`, run once in `phylactery/` and once in `unruh/` against
each module's `uv.lock`, is what creates their environments
[@install-sh] [@win-install-ps1]. See [Phylactery](phylactery) and
[Unruh](unruh) for what each service owns. If `uv` itself is missing, the
installer auto-installs it via Astral's official one-line installer, which
writes to `~/.local/bin` (or `%USERPROFILE%\.local\bin` on Windows); both
`install.sh` and the Windows installer pre-add that directory to `PATH` so
`uv sync` and the later MCP-child spawn work in the same process without
requiring a shell restart [@install-sh] [@win-install-ps1].

## Windows prerequisite install never hard-fails on one flaky package

Windows prerequisite installation goes through `winget install --scope user`,
which needs no admin prompt [@win-install-ps1]. Every tool has an explicit
fallback if winget is unavailable or a specific package install fails: `uv`
falls back to its own PowerShell one-liner; Node and Git fall back to opening
the download page and waiting for the user to confirm the manual install
[@win-install-ps1]. This is a deliberate design choice — no single flaky
winget package should be able to hard-fail the whole install.

## Windows process-tree killing must walk the child tree

The tray app's Stop/Restart/Quit actions call
`taskkill /PID <id> /T /F`, not PowerShell's `Stop-Process -Force`
[@win-tray-ps1]. This was a real bug found while building the tray: Phylactery
and Unruh run as Python children spawned through `uv` as stdio MCP children of
`thalamus.js`, and `Stop-Process -Force` only terminates the parent Node
process, orphaning those Python children. The orphaned processes kept running
with the port released but their state directories locked, which could break
a subsequent `uv sync`. `taskkill`'s `/T` flag walks the whole parent-child
tree, so a Stop/Restart/Quit from the tray actually tears down everything
[@win-tray-ps1].

## The tray app trusts a PID file, not a command-line match

An earlier version of the tray app tried to identify "our" node process by
matching `Win32_Process.CommandLine` against the project root path. That
filter silently never matched, because Windows does not expose a process's
working directory in `CommandLine` — only in a separate WMI property — so
Quit/Stop/Restart never actually killed the tracked process
[@win-tray-ps1]. The fix is to trust the PID written to
`.proto-familiar.pid` at launch time as the canonical "this is the instance
the tray spawned" signal, with a secondary check of who is listening on the
port (`Get-NetTCPConnection`) as a fallback for orphans left over from before
this fix existed [@win-tray-ps1].

## Every launcher must write the same canonical process signal

Process detection broke when the macOS double-click launcher (`Proto-Familiar.command`)
did `exec node server.js` without writing `.proto-familiar.pid`, while `stop.sh`
fell back to brittle `pgrep "node .*server.js"` + working-directory guessing.
When that heuristic missed, a running Familiar read as "No Proto-Familiar process
found".

The fix unified process detection across all platforms:

1. `Proto-Familiar.command` now writes `echo $$ > .proto-familiar.pid` right before
   `exec` — the shell PID survives because `exec` replaces the shell process in-place,
   so `$$` still refers to node's PID [@macos-launcher].
2. `stop.sh` gained port-owner detection: `lsof -ti tcp:$PORT -sTCP:LISTEN`, then
   cwd-verified, as a first-class detection method. This works regardless of how the
   process was started and needs no PID file or command-name pattern match [@stop-sh].
3. `start.bat` fixed its PID write from `echo X > file` (which includes a trailing
   space, breaking the next re-read) to `(echo X)>file` [@start-bat].

The lesson generalizes: **every launch path must leave the same canonical marker
that every stopper reads.** Use port-owner detection as the first choice — it works
regardless of launch method and doesn't depend on fragile argv matching. Detection
logic is triplicated by necessity (bash / PowerShell-in-batch / Node), so keep the
approach identical across launchers and note where paths mirror each other in code
comments; divergence is how detection logic rots.

### The server, not the launcher, now owns the authoritative PID write

The per-launcher PID writes above were still each a shell/PowerShell *guess* at
node's pid, and one of them was wrong in a way none of the manual testing above
caught: `start.sh` backgrounded a `( cd "$SCRIPT_DIR" && … nohup node server.js … & )`
compound and captured `$!`, which is the pid of the backgrounded compound/subshell
(or of `nohup`), not of node — whether that collapses to node's real pid depends on
the shell's last-command exec optimisation, so it varied by shell and platform. When
the recorded pid was wrong, `stop.sh` killed the wrapper, node was reparented to
`init` and kept holding the port, and stopping looked like a no-op — intermittently,
per platform, which is why it read as "unreliable" rather than cleanly broken.

0.12.17 fixed this at the root instead of adding another shell heuristic: the new
`src/server/pid-file.js` module (`writePidFile` / `clearPidFile`) lets the server
write its **own** `process.pid` into `.proto-familiar.pid`, inside the `app.listen()`
success callback — so a failed bind never leaves a bogus pid — and clear it (only if
the file still names that same pid, so a fast stop-then-start never deletes a
successor instance's file) from the graceful-shutdown handler, `handleSignal`
[@pid-file] [@server-js]. This overwrites whatever placeholder pid the launcher wrote,
on every launch path (`start.sh`, `start.bat`, `Proto-Familiar.command`, the tray,
`npm start`, docker) and every OS — the server's own write is the one signal that
cannot be a wrapper/subshell/parent-process mismatch. `start.sh` was also fixed to
background `node` directly (no subshell), so its `echo $!` is now just the pre-boot
placeholder the server immediately overwrites once it is actually listening
[@pid-file].

Windows was never on the broken write path: `start.bat` already captured node's real
pid via `Start-Process -PassThru; $p.Id`, and `Proto-Familiar.command` already used
`exec node` so `$$` is node's own pid. `start.sh`'s backgrounded compound was the lone
broken launcher-write path [@start-bat] [@macos-launcher]. `stop.sh` / `stop.bat` keep
their cwd- and port-owner-based fallbacks described above unchanged — the server-owned
pid file strengthens the primary detection signal without removing that belt-and-suspenders.

The general lesson: a launcher's `echo $!` (or platform equivalent) taken after a
backgrounded compound or subshell can capture the wrong pid, and the fix is not a
better shell guess — it is having the process record its own pid, since that is the
one source that is authoritative by construction.

## Stale-instance recycling is shared, not copy-pasted per platform

Both the macOS/Linux launchers and the Windows tray app detect and kill a
previous Proto-Familiar instance still holding the port before starting a new
one, covering the case where a prior run was not shut down cleanly (window
force-closed, crash, kernel-panic recovery). This logic lives once in
`scripts/ensure-port-free.mjs` on the Node side, and `start.sh`, the macOS
launcher, and the npm `prestart` hook all call into it rather than each
reimplementing the check [@ensure-port-free]. This follows the repo's
"no copy-paste of substantial logic" convention — see
[Engineering conventions](../reference/engineering-conventions)
[@engineering-conventions]. `ensure-port-free.mjs` reads
`.proto-familiar.pid`, and only kills the process it identifies as a
previous Proto-Familiar rooted in this repo; it deliberately refuses to kill
an unrecognized process holding the port, surfacing a clear error instead,
because guessing at that layer is the wrong tradeoff [@ensure-port-free].

## The completion marker distinguishes "installed" from "node_modules exists"

Both platforms write a completion marker at the end of a successful install —
`.pf-install-complete` on Windows (containing the installed version, for
debugging) and an equivalent step on macOS/Linux — instead of relying on
`node_modules/` existing to decide whether the installer has actually run
[@install-sh] [@win-install-ps1] [@vbs-launcher]. A manual `npm install` can
leave `node_modules/` present without Phylactery/Unruh ever being set up or
shortcuts ever being created; the marker is what `Proto-Familiar.vbs` checks
before deciding whether to re-run the installer [@vbs-launcher]. Every install
run also appends to `.proto-familiar-install.log`, and on Windows a final
MessageBox reports the outcome and log path even if the console window is
closed immediately, so a closed console never means lost diagnostics
[@win-install-ps1].

## OneDrive is the single most common cause of failed Windows installs

Windows 11 backs up both `Documents\` and `Desktop\` to OneDrive by default.
OneDrive locks files mid-write while syncing them, which reliably breaks
`npm install`'s burst of small file writes. `docs/getting-started.md`
recommends installing to `%LOCALAPPDATA%\Proto-Familiar` instead, and the
installer detects an OneDrive-scoped install location and offers to relocate
it automatically [@win-install-ps1] [@getting-started].

## Naming and version drift to watch for

This installer work predates, and was later updated alongside, the
entity-core-to-Phylactery migration described in
[Phylactery](phylactery) and the in-tree Unruh module. The scripts now
reference `phylactery/` and `unruh/` (both `uv`-managed, in-tree Python
services), not the old sibling-clone `entity-core-alpha` path the original
version of this installer targeted. The default port is 8742, not 3000, and
the Node minimum is 22 — required for the native WebSocket the Discord
gateway uses — not 18 [@win-install-ps1] [@getting-started]. When editing
older docs or scripts that still assume the earlier numbers, treat them as
stale rather than authoritative.

## After installation: updates

Once Proto-Familiar is installed, the ward can update to the latest version without re-running
the installer. See [Update](update) for how the self-update subsystem works, including the two
update modes (git vs download-and-replace), web UI and Discord command interfaces, and the
design principle that updates are manual ceremonies, never automatic.
