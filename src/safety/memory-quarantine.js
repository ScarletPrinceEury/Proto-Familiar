/**
 * memory-quarantine.js — the reversible holding pen for suspect memories.
 *
 * When the memory-integrity scan (`memory-integrity.js`) flags a candidate fact
 * from an untrusted source, that fact is NOT written to Phylactery — it's held
 * here instead. This is the archive-before-destructive-writes rule (the ponderings
 * data-loss lesson) applied to memory: a suspect fact is set ASIDE, never silently
 * destroyed, and my human can release it (a false positive → one click to keep it)
 * or discard it (a real injection → confirmed drop, still kept in the audit trail).
 *
 * This module is PURE STORAGE — it never touches Phylactery. On release it marks
 * the record and hands the stored `memoryArgs` back to the caller (server.js),
 * which performs the `createMemoryFull` write. That keeps this module free of a
 * thalamus/Phylactery import and therefore free of a cycle.
 *
 * The store is `tomes/.memory-quarantine.json` — a dotfile, never a tome
 * (isTomeFile skips it), never injected into a prompt. Atomic tmp+rename writes,
 * mirroring the pondering-consolidation archive. A parallel JSONL audit log
 * (`logs/memory-quarantine-events.jsonl`) makes every hold/release/discard
 * observable (the graceful-degradation "failures that matter are observable" rule).
 */

import path from 'path';
import { promises as fsp, mkdirSync } from 'fs';

import { REPO_ROOT } from '../../repo-root.js';
import { meaningSlugId } from '../../slug-ids.js';

const DEFAULT_TOMES_DIR = path.join(REPO_ROOT, 'tomes');
const LOGS_DIR = path.join(REPO_ROOT, 'logs');
const STORE_NAME = '.memory-quarantine.json';
const LOG_FILE = path.join(LOGS_DIR, 'memory-quarantine-events.jsonl');

const storePath = (tomesDir) => path.join(tomesDir, STORE_NAME);

async function readStore(tomesDir) {
  try {
    const raw = await fsp.readFile(storePath(tomesDir), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.records) ? data : { records: [] };
  } catch { return { records: [] }; }
}

// Atomic tmp+rename, like the pondering archive. Throws on failure so a caller
// that must not lose the record (a quarantine) can refuse to proceed on a bad write.
async function writeStore(tomesDir, data) {
  const file = storePath(tomesDir);
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function appendAudit(entry) {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    await fsp.appendFile(LOG_FILE, JSON.stringify({ ...entry, loggedAt: new Date().toISOString() }) + '\n', 'utf8');
  } catch { /* audit is best-effort — never blocks the store write */ }
}

// The Familiar's own first-person account of a hold — so a set-aside memory reads
// as its own act of care, not a silent system deletion. Written in the literal
// "my human" voice (this is model-facing-adjacent text, not a macro boundary).
function holdNote(provenance) {
  const src = provenance?.wardPrivate
    ? 'something my human said to me directly'
    : `something from ${provenance?.sourceLabel || 'a shared room'}`;
  return `I set aside ${src} that looked like it was trying to plant an instruction in me. It's in my quarantine for my human to look at — I didn't write it into my memory.`;
}

/**
 * Hold a suspect fact instead of writing it to Phylactery. Returns the record.
 *
 * @param {object} opts
 * @param {string} opts.factText     the memory content (for my human to read)
 * @param {object} opts.memoryArgs   the exact createMemoryFull args to replay on release
 * @param {string[]} opts.patterns   matched scan-pattern labels
 * @param {object} opts.provenance   { wardPrivate, audienceTag, sessionRef, sourceLabel }
 * @param {'held'|'flagged'} [opts.disposition='held']
 *   'held'    → NOT written (untrusted source); release re-writes it.
 *   'flagged' → my human's own words, WRITTEN normally but recorded here so they
 *               can review; a flagged record has nothing to release.
 * @param {string} [opts.tomesDir]
 */
export async function quarantineFact({ factText, memoryArgs, patterns = [], provenance = {}, disposition = 'held', tomesDir = DEFAULT_TOMES_DIR }) {
  const data = await readStore(tomesDir);
  const id = meaningSlugId(String(factText || ''), { fallbackKind: 'quar' });
  const record = {
    id,
    factText: String(factText || ''),
    memoryArgs: memoryArgs ?? null,
    patterns: [...new Set(patterns)],
    provenance,
    note: holdNote(provenance),
    disposition,               // 'held' | 'flagged' (later: 'released' | 'discarded')
    heldAt: new Date().toISOString(),
    settledAt: null,
  };
  data.records.push(record);
  await writeStore(tomesDir, data);
  await appendAudit({ event: disposition === 'flagged' ? 'flag' : 'hold', id, patterns: record.patterns, provenance });
  return record;
}

/**
 * List quarantine records, newest first. By default only the live ones (still
 * held — the ones my human can act on); pass includeSettled for the full audit view.
 */
export async function listQuarantine({ includeSettled = false, tomesDir = DEFAULT_TOMES_DIR } = {}) {
  const data = await readStore(tomesDir);
  const rows = [...data.records].reverse();
  return includeSettled ? rows : rows.filter(r => r.disposition === 'held');
}

/**
 * Mark a held record RELEASED and return its stored memoryArgs so the caller can
 * write it to Phylactery. Returns null if the id is unknown or not currently held
 * (a flagged/released/discarded record has nothing to release). Idempotent-ish: a
 * second release of the same id returns null.
 */
export async function releaseQuarantine(id, { tomesDir = DEFAULT_TOMES_DIR } = {}) {
  const data = await readStore(tomesDir);
  const rec = data.records.find(r => r.id === id && r.disposition === 'held');
  if (!rec) return null;
  rec.disposition = 'released';
  rec.settledAt = new Date().toISOString();
  await writeStore(tomesDir, data);
  await appendAudit({ event: 'release', id });
  return { memoryArgs: rec.memoryArgs, factText: rec.factText };
}

/**
 * Mark a held record DISCARDED — a confirmed injection, permanently not kept. The
 * row stays in the store for the audit trail (never hard-deleted). Returns the id
 * on success, null if unknown/not-held.
 */
export async function discardQuarantine(id, { tomesDir = DEFAULT_TOMES_DIR } = {}) {
  const data = await readStore(tomesDir);
  const rec = data.records.find(r => r.id === id && r.disposition === 'held');
  if (!rec) return null;
  rec.disposition = 'discarded';
  rec.settledAt = new Date().toISOString();
  await writeStore(tomesDir, data);
  await appendAudit({ event: 'discard', id });
  return id;
}
