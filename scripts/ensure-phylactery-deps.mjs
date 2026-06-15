/**
 * Pre-start hook: make sure Phylactery's Python venv is ready before
 * server.js boots. Idempotent and fast in the steady state (uv sync
 * with no changes is sub-second), so safe to run on every `npm start`
 * / `npm run dev` via the prestart / predev npm script hooks.
 *
 * Behavior:
 *   - No phylactery/ in this checkout → exit silently.
 *   - phylactery/.venv/ already present → just `uv sync` to pick up
 *     any uv.lock changes from a recent `git pull`.
 *   - phylactery/.venv/ missing → loud "first-run setup" message, then sync.
 *   - uv not installed → clear pointer to install.sh / install.bat
 *     (which DO auto-install uv), exit 0 so the server still boots
 *     and degrades gracefully. We deliberately do NOT auto-install uv
 *     from here: prestart is the wrong layer for a network install,
 *     and `npm start` shouldn't surprise a dev with a 30-second download.
 *
 * Exits 0 on every non-catastrophic path so the server boot continues
 * even when Phylactery setup fails — thalamus.js already degrades
 * gracefully when Phylactery is unavailable.
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname        = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT        = path.resolve(__dirname, '..');
const PHYLACTERY_ROOT  = path.join(REPO_ROOT, 'phylactery');
const PHYLACTERY_PYPROJECT = path.join(PHYLACTERY_ROOT, 'pyproject.toml');
const PHYLACTERY_VENV  = path.join(PHYLACTERY_ROOT, '.venv');

function say(msg)  { process.stdout.write(`[ensure-phylactery] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[ensure-phylactery] ${msg}\n`); }

function resolveUv() {
  if (process.env.UV_BIN && existsSync(process.env.UV_BIN)) return process.env.UV_BIN;
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? [
        path.join(home, '.local', 'bin', 'uv.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'uv', 'bin', 'uv.exe'),
        path.join(home, '.cargo', 'bin', 'uv.exe'),
      ]
    : [
        path.join(home, '.local', 'bin', 'uv'),
        path.join(home, '.cargo', 'bin', 'uv'),
        '/usr/local/bin/uv',
        '/opt/homebrew/bin/uv',
      ];
  for (const c of candidates) { if (c && existsSync(c)) return c; }
  return isWin ? 'uv.exe' : 'uv';
}

if (!existsSync(PHYLACTERY_PYPROJECT)) process.exit(0); // no Phylactery in this checkout
const uv = resolveUv();
const venvExists = existsSync(PHYLACTERY_VENV);

const probe = spawnSync(uv, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
if (probe.status !== 0) {
  if (!venvExists) {
    warn('uv is not installed — Phylactery (identity layer) will be disabled.');
    warn('Run `install.bat` (Windows) or `./install.sh` (macOS/Linux) once to install uv + sync Phylactery.');
  }
  process.exit(0);
}

if (!venvExists) {
  say('First-run setup: materialising Phylactery\'s Python venv (one-time, ~30s)…');
}
const sync = spawnSync(uv, ['sync', '--quiet'], {
  cwd: PHYLACTERY_ROOT,
  stdio: 'inherit',
});
if (sync.status === 0) {
  if (!venvExists) say('Phylactery dependencies ready.');
} else {
  warn(`uv sync exited with status ${sync.status} — Phylactery may not work this boot.`);
}

// ── Auto-migrate from entity-core (first-run only) ───────────────────────────
// If entity-core exists as a sibling directory and migration hasn't run yet,
// migrate identity, memories, and graph into Phylactery automatically.
// Runs here (before server boot) so Phylactery isn't running yet and there's
// no SQLite concurrency. The marker file prevents re-running on every boot.
const EC_MARKER = path.join(PHYLACTERY_ROOT, 'data', '.ec-migrated');

function looksLikeEcDataDir(p) {
  return existsSync(path.join(p, 'self'))
      || existsSync(path.join(p, 'memories'))
      || existsSync(path.join(p, 'graph.db'));
}

if (!existsSync(EC_MARKER) && existsSync(PHYLACTERY_VENV)) {
  const ecCandidates = [
    path.resolve(REPO_ROOT, '..', 'entity-core'),
    path.resolve(REPO_ROOT, '..', 'entity-core-alpha'),
  ];
  let sourceDataDir = null;
  for (const ec of ecCandidates) {
    if (!existsSync(ec)) continue;
    // Prefer the data/ subdirectory; fall back to the dir itself if it looks
    // like a raw data directory (e.g. a custom ENTITY_CORE_DATA_DIR path).
    const sub = path.join(ec, 'data');
    if (existsSync(sub) && looksLikeEcDataDir(sub)) { sourceDataDir = sub; break; }
    if (looksLikeEcDataDir(ec)) { sourceDataDir = ec; break; }
  }

  if (sourceDataDir) {
    say('Found entity-core data — migrating identity, memories, and graph into Phylactery (one-time)…');
    const mig = spawnSync(
      uv,
      ['run', 'python', '-m', 'phylactery.migrate_from_entity_core', '--source', sourceDataDir],
      { cwd: PHYLACTERY_ROOT, stdio: 'inherit' },
    );
    if (mig.status === 0) {
      try {
        mkdirSync(path.dirname(EC_MARKER), { recursive: true });
        writeFileSync(EC_MARKER, new Date().toISOString() + '\n');
      } catch { /* non-fatal — will retry next boot */ }
      say('Migration complete — identity, memories, and graph imported.');
    } else {
      warn(`Migration exited with status ${mig.status ?? 'unknown'}.`);
      warn(`If this persists, run manually: npm run import-entity -- --from "${path.dirname(sourceDataDir)}"`);
    }
  }
}

process.exit(0);
