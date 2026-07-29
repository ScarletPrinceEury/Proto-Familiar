/**
 * Does this Python peer actually start? — and repair it if not.
 *
 * `ensure-phylactery-deps` and `ensure-unruh-deps` both checked that a venv
 * DIRECTORY existed and that `uv sync` exited 0. Both signals are weak, and my
 * human hit all three ways they can lie in one morning:
 *
 *   cryptography  installed, but fernet.py and exceptions.py simply absent
 *   anyio         installed, but missing an internal module its own __init__
 *                 imports
 *   python-dotenv never installed at all, while sync reported success
 *
 * In every case the gate passed and the peer then died at import — so what
 * reached my human was a forty-line Python traceback in a console, for a
 * problem a reinstall fixes. For an app built for people with executive
 * dysfunction, that is the moment they stop.
 *
 * So: presence is not health. The only trustworthy check is running the thing.
 * `python -c "import <module>"` costs about a second and answers the question
 * the other two only gesture at.
 *
 * ── Repair once, then report plainly ────────────────────────────────────
 * A broken import gets ONE `uv sync --reinstall`, because the common causes
 * (an interrupted sync, a file locked by a still-running server, a stale
 * resolution) are all fixed by rebuilding. If it fails again, that is a real
 * problem and the message says what to run rather than leaving a traceback to
 * interpret.
 *
 * Never throws. A peer that cannot be repaired must degrade to "this feature
 * is off", never to a crashed boot.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';

/** The venv interpreter, whichever layout this platform made. */
export function venvPython(venvDir) {
  for (const rel of [['Scripts', 'python.exe'], ['bin', 'python3'], ['bin', 'python']]) {
    const candidate = path.join(venvDir, ...rel);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Import the peer's server module in its own venv.
 *
 * Importing the SERVER module rather than the package root on purpose: that is
 * what actually pulls in mcp, pydantic-settings and the rest, which is where
 * every one of these failures lived. Importing the bare package would have
 * passed in all three cases.
 */
export function peerImports({ venvDir, module: mod, cwd, timeoutMs = 60_000 }) {
  const python = venvPython(venvDir);
  if (!python) return { ok: false, reason: 'no-interpreter', detail: `no python found in ${venvDir}` };

  const r = spawnSync(python, ['-c', `import ${mod}`], {
    cwd,
    env: { ...process.env, PYTHONPATH: path.join(cwd, 'src') },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    windowsHide: true,
  });

  if (r.status === 0) return { ok: true };

  // The last line of a Python traceback is the part a person can act on.
  const err = String(r.stderr ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
  return { ok: false, reason: 'import-failed', detail: err || `exited ${r.status}` };
}

/**
 * Verify, and repair once if needed.
 *
 * Returns `{ ok, repaired, reason, detail }` — `repaired` so the caller can say
 * so out loud. A silent repair is indistinguishable from nothing being wrong,
 * and my human should know their environment needed rebuilding.
 */
export function verifyOrRepair({ uv, venvDir, module: mod, cwd, label, log = console.log, warn = console.warn }) {
  const first = peerImports({ venvDir, module: mod, cwd });
  if (first.ok) return { ok: true, repaired: false };

  warn(`[${label}] installed but cannot start: ${first.detail}`);
  warn(`[${label}] rebuilding its environment (this happens when a sync was interrupted)…`);

  const rebuild = spawnSync(uv, ['sync', '--reinstall', '--quiet'], {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (rebuild.status !== 0) {
    warn(`[${label}] rebuild failed (uv exited ${rebuild.status}).`);
    warn(`[${label}] stop the server, then run:  uv sync --reinstall --directory ${path.basename(cwd)}`);
    return { ok: false, repaired: false, reason: 'rebuild-failed', detail: first.detail };
  }

  const second = peerImports({ venvDir, module: mod, cwd });
  if (second.ok) {
    log(`[${label}] environment rebuilt — working again.`);
    return { ok: true, repaired: true };
  }

  warn(`[${label}] still cannot start after a rebuild: ${second.detail}`);
  warn(`[${label}] this needs a look. Stop the server first — on Windows a running`);
  warn(`[${label}] process can hold files open and make a sync silently incomplete.`);
  return { ok: false, repaired: false, reason: 'still-broken', detail: second.detail };
}
