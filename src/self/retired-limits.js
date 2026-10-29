/**
 * retired-limits.js — telling me once when the app stops needing a workaround
 * (known-issues A5).
 *
 * After the first identity review, an inventory of my own rules (standing
 * facts I filed about myself, mostly right after something went wrong) showed
 * several that only covered for the app: "check where a duplicate came from
 * before retiring it", "an ok from update_identity means something was added
 * somewhere". When the app fixes the limit, nothing tells me, so the rule
 * outlives its cause.
 *
 * So the app keeps this short list of limits it has fixed, and shows me each
 * one ONCE, as a plain app note on my next live turn in my own conversation
 * with my human (it rides that turn's context, no new request). Whether a rule
 * of mine is still needed is mine to decide; the app never touches my rules.
 *
 * A fresh install never had these limits, so on first run with no
 * conversation older than a day, everything is marked seen and only limits
 * added after that show up.
 *
 * ADDING ONE: when a fix retires a limit a Familiar may have a rule about, add
 * an entry here in the same commit: a stable id, the version, and one plain
 * sentence in my voice saying what the app does now. Plain facts, no verdicts
 * (CLAUDE.md prompt error #6).
 */

import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import { REPO_ROOT } from '../../repo-root.js';
import { readJsonState, writeJsonState } from '../util/json-state.js';

export const RETIRED_LIMITS = Object.freeze([
  { id: 'schedule-provenance', version: '0.14.84', text: 'Calendar-synced items show 📅, and the app won\'t let me delete one (the next sync would only bring it back).' },
  { id: 'model-signal', version: '0.14.85', text: 'My [Now] block says which model is answering, and when that changed.' },
  { id: 'text-tool-calls', version: '0.14.86', text: 'If I write a tool call out as text instead of making it, the next turn\'s line tells me it didn\'t run.' },
  { id: 'pantry-use-up', version: '0.14.108', text: 'I can take used-up food off the pantry (tracker_remove_item), and the pantry says how long ago each item was noted.' },
  { id: 'identity-read', version: '0.14.112', text: 'I can read an identity file as it is right now (read_identity_file), and every identity edit says what it did and where.' },
  { id: 'write-results', version: '0.14.113', text: 'A write\'s result says what it did ("ok: …"), not just "ok".' },
  { id: 'recall-excerpts', version: '0.14.114', text: 'A long memory in recall shows its start and its real end with [… cut for length …] between. A cut memory isn\'t a missing one; read_memory_by_id shows all of it.' },
  { id: 'tome-edits', version: '0.14.116', text: 'I can fix or take out my own tome entries (edit_tome_entry, delete_tome_entry).' },
  { id: 'claimed-actions', version: '0.14.118', text: 'If my reply says I filed or saved something and no tool ran, the app tells me in the same turn and I get one more go.' },
]);

// Under `node --test` (the runner sets NODE_TEST_CONTEXT in every test
// process), the store is a throwaway file: tests run enrich() as a live turn,
// and a test run on a live install must not use up my notes before I see them.
const UNDER_TEST = Boolean(process.env.NODE_TEST_CONTEXT);
const DEFAULT_FILE = UNDER_TEST
  ? path.join(os.tmpdir(), `pf-retired-limits-${process.pid}.json`)
  : path.join(REPO_ROOT, 'tomes', '.retired-limits-seen.json');
const DEFAULT_LOGS = UNDER_TEST ? path.join(os.tmpdir(), `pf-retired-limits-logs-${process.pid}`) : path.join(REPO_ROOT, 'logs');
const DAY_MS = 24 * 3600_000;

let _paths = { file: DEFAULT_FILE, logsDir: DEFAULT_LOGS };
/** Tests point the store somewhere else. */
export function __setRetiredLimitsPathsForTest(p) { _paths = p ? { ..._paths, ...p } : { file: DEFAULT_FILE, logsDir: DEFAULT_LOGS }; }

// Does this install have a conversation older than a day? Then it's been
// running long enough to have rules about these limits.
async function hasHistory(logsDir, now) {
  let names;
  try { names = await fsp.readdir(logsDir); } catch { return false; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { if ((await fsp.stat(path.join(logsDir, n))).mtimeMs < now - DAY_MS) return true; } catch { /* skip */ }
  }
  return false;
}

/** The app note for these limits, or '' for none. */
export function retiredLimitsNote(items) {
  if (!Array.isArray(items) || !items.length) return '';
  return `[App note (just this once): the app handles these now. If I keep a rule only to work around one of them, I can let it go.\n${items.map(i => `· ${i.text}`).join('\n')}]`;
}

/**
 * The note for limits I haven't been told about yet, marking them told. ''
 * when there are none. Never throws (a failure means no note this turn).
 */
export async function takeRetiredLimitsNote({ limits = RETIRED_LIMITS, file = _paths.file, logsDir = _paths.logsDir, now = Date.now() } = {}) {
  try {
    const state = await readJsonState(file, null);
    const seen = state && typeof state.seen === 'object' && state.seen ? { ...state.seen } : null;
    const stamp = new Date(now).toISOString();
    if (!seen) {
      // First run. A fresh install never had these limits: mark them all told.
      if (!(await hasHistory(logsDir, now))) {
        await writeJsonState(file, { seen: Object.fromEntries(limits.map(l => [l.id, stamp])) });
        return '';
      }
    }
    const fresh = limits.filter(l => !seen?.[l.id]);
    if (!fresh.length) return '';
    const next = { ...(seen ?? {}) };
    for (const l of fresh) next[l.id] = stamp;
    await writeJsonState(file, { seen: next });
    return retiredLimitsNote(fresh);
  } catch (err) {
    console.warn('[retired-limits] no note this turn:', err?.message ?? err);
    return '';
  }
}
