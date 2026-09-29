/**
 * resolve-uv.mjs — find the `uv` binary across the locations Astral's installer
 * uses, so we locate it even when uv is installed but the current PATH hasn't
 * picked it up yet (common on Windows right after the Astral installer, or in a
 * non-login terminal).
 *
 * Extracted from three byte-identical copies — ensure-phylactery-deps.mjs,
 * ensure-unruh-deps.mjs, and thalamus.js's `resolveUvBinary()` — per the
 * no-copy-paste rule, so a new install location (or a fix) is remembered once
 * instead of in triplicate. `UV_BIN` overrides everything; the final return is a
 * bare name so a plain PATH lookup still gets a shot when no known path matched.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveUv() {
  if (process.env.UV_BIN && existsSync(process.env.UV_BIN)) return process.env.UV_BIN;
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? [
        path.join(home, '.local', 'bin', 'uv.exe'),                       // Astral's current default
        path.join(process.env.LOCALAPPDATA ?? '', 'uv', 'bin', 'uv.exe'), // older default
        path.join(home, '.cargo', 'bin', 'uv.exe'),
      ]
    : [
        path.join(home, '.local', 'bin', 'uv'),                           // Astral's current default
        path.join(home, '.cargo', 'bin', 'uv'),
        '/usr/local/bin/uv',
        '/opt/homebrew/bin/uv',
      ];
  for (const c of candidates) { if (c && existsSync(c)) return c; }
  return isWin ? 'uv.exe' : 'uv'; // last-resort PATH lookup
}
