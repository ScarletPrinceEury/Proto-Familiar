/**
 * settings-store — the one low-level reader for settings.json.
 *
 * settings.json is the centralised user-preference store (see the
 * /api/settings routes in server.js). This module is a LEAF: it imports
 * only node builtins, so both cerebellum.js (which owns the write path and
 * re-exports readSettingsSync for its many consumers) and thalamus.js (the
 * lower-level perception module cerebellum imports, so it can't import back
 * from cerebellum without a cycle) can share ONE reader implementation
 * instead of each inlining `JSON.parse(readFileSync(SETTINGS_FILE))`.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// The synchronous read every "peek at a setting" site uses. Any failure
// (missing file on a fresh install, a torn write, bad JSON) yields {} — so
// callers read their field off the result with their own default and never
// have to guard the parse themselves. The path is injectable for tests; every
// production caller uses the default, so the one canonical store is unchanged.
export function readSettingsSync(file = SETTINGS_FILE) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return {}; }
}
