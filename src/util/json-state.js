/**
 * Tiny persistent JSON-state helper — read-or-fallback + atomic write.
 *
 * Shared by the cue-aging stores (gcal projection, tracker cues, …): a plain
 * object persisted to one JSON file, read best-effort (missing/corrupt → the
 * fallback, never throws) and written atomically (tmp + rename) so a crash
 * mid-write can't leave a half-file. State that must be shared between viewers
 * or read back reliably belongs in a real store — this is for per-install
 * bookkeeping the code owns.
 */

import path from 'path';
import { promises as fsp } from 'fs';

export async function readJsonState(file, fallback = {}) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback; // missing/corrupt → start fresh
  }
}

export async function writeJsonState(file, state) {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(state ?? {}, null, 2), 'utf8');
    await fsp.rename(tmp, file); // atomic replace
  } catch (err) {
    console.error(`[json-state] failed to persist ${path.basename(file)}:`, err?.message ?? err);
  }
}
