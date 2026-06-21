/**
 * Per-day memory-coverage ledger.
 *
 * Records, for each local calendar date, how much of each session's
 * messages-on-that-date has been run through the memorization pipeline — so we
 * can tell a fully-memorized day from one with gaps or one that's uncertain
 * (a shared-room session, a failed extraction). See
 * docs/day-anchoring-build-spec.md.
 *
 * The ledger stores only what's been MEMORIZED (per session: memorizedThrough +
 * flag); what EXISTS is read live from the session logs at compute time. Status
 * is derived by comparing the two, so the active day shows "partial" the moment
 * new messages land, and a past day reads "complete" once its slice is done.
 *
 * Proto-Familiar-local (sessions are per-embodiment, like ponderings). Degrades
 * like every tome file: unreadable/missing → treated as empty, never throws.
 *
 * Path params (logsDir/ledgerFile) default to the real dirs; tests override them.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, promises as fsp } from 'fs';
import { segmentByDay } from './day-segments.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOMES_DIR = path.join(__dirname, 'tomes');
export const DEFAULT_LOGS_DIR = path.join(__dirname, 'logs');
export const DEFAULT_LEDGER_FILE = path.join(TOMES_DIR, '.memory-coverage.json');
const LEDGER_VERSION = 1;

mkdirSync(TOMES_DIR, { recursive: true });

// Local timezone the dates are computed in (machine time), stamped for the
// record so a future configurable-tz change isn't ambiguous.
function localTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; }
  catch { return 'local'; }
}

async function load(ledgerFile) {
  try {
    const data = JSON.parse(await fsp.readFile(ledgerFile, 'utf8'));
    if (data && typeof data === 'object') {
      data.days ??= {};
      data.tz ??= localTz();
      data.version ??= LEDGER_VERSION;
      return data;
    }
  } catch { /* missing/corrupt → fresh */ }
  return { version: LEDGER_VERSION, tz: localTz(), days: {} };
}

async function persist(ledgerFile, ledger) {
  const tmp = ledgerFile + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(ledger, null, 2), 'utf8');
  await fsp.rename(tmp, ledgerFile);
}

/**
 * Mark a (date, session) slice as memorized through `throughCount` messages.
 * `flag` ('shared-room' | 'extract-failed' | null) is sticky once set, so a day
 * touched by a shared room stays "uncertain" until reviewed. Never throws.
 */
export async function recordSegmentRun({ date, sessionId, throughCount = 0, facts = 0, flag = null }, { ledgerFile = DEFAULT_LEDGER_FILE } = {}) {
  if (!date || !sessionId) return;
  try {
    const ledger = await load(ledgerFile);
    ledger.days[date] ??= { segments: {}, updatedAt: null };
    const seg = ledger.days[date].segments[sessionId] ?? { memorizedThrough: 0, facts: 0, flag: null };
    seg.memorizedThrough = Math.max(seg.memorizedThrough ?? 0, throughCount);
    seg.facts = (seg.facts ?? 0) + (facts ?? 0);
    seg.flag = flag ?? seg.flag ?? null;
    seg.lastRun = new Date().toISOString();
    ledger.days[date].segments[sessionId] = seg;
    ledger.days[date].updatedAt = seg.lastRun;
    await persist(ledgerFile, ledger);
  } catch (err) {
    console.warn('[coverage] recordSegmentRun failed:', err?.message ?? err);
  }
}

/** Has this (session, date) slice already been memorized to at least `count`? */
export async function isSegmentMemorized(sessionId, date, count, { ledgerFile = DEFAULT_LEDGER_FILE } = {}) {
  try {
    const ledger = await load(ledgerFile);
    const seg = ledger.days?.[date]?.segments?.[sessionId];
    return !!seg && (seg.memorizedThrough ?? 0) >= count;
  } catch { return false; }
}

export function deriveStatus(sessions) {
  if (sessions.length === 0) return 'empty';
  if (!sessions.every(s => s.memorized >= s.total)) return 'partial';
  return sessions.some(s => s.flag) ? 'uncertain' : 'complete';
}

/**
 * Live coverage: scan the session logs, derive day-segments, and compare what
 * EXISTS against what the ledger says is MEMORIZED. Returns per-date status for
 * the calendar and the sweep. Only slices with ≥2 readable messages count (a
 * stub exchange is never "missing"). Read-only; never throws.
 */
export async function computeCoverage({ logsDir = DEFAULT_LOGS_DIR, ledgerFile = DEFAULT_LEDGER_FILE } = {}) {
  const ledger = await load(ledgerFile);
  const days = {}; // date -> { sessions: {sessionId:{memorized,total,flag}}, facts }

  let files = [];
  try {
    files = (await fsp.readdir(logsDir)).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  } catch { files = []; }

  for (const f of files) {
    let log;
    try { log = JSON.parse(await fsp.readFile(path.join(logsDir, f), 'utf8')); }
    catch { continue; }
    const sessionId = log?.sessionId ?? f.replace(/\.json$/, '');
    const messages = Array.isArray(log?.messages) ? log.messages : [];
    if (messages.length === 0) continue;

    for (const seg of segmentByDay(messages)) {
      if (seg.readableCount < 2) continue;
      const led = ledger.days?.[seg.date]?.segments?.[sessionId];
      (days[seg.date] ??= { sessions: {}, facts: 0 }).sessions[sessionId] = {
        memorized: led?.memorizedThrough ?? 0,
        total: seg.count,
        flag: led?.flag ?? null,
      };
      days[seg.date].facts += led?.facts ?? 0;
    }
  }

  const out = {};
  for (const [date, d] of Object.entries(days)) {
    const sessions = Object.entries(d.sessions).map(([sessionId, s]) => ({ sessionId, ...s }));
    out[date] = {
      status: deriveStatus(sessions),
      facts: d.facts,
      flags: [...new Set(sessions.map(s => s.flag).filter(Boolean))],
      sessions,
    };
  }
  return { tz: ledger.tz, days: out };
}

/** Dates with un-memorized slices (status 'partial') — what the sweep feeds. */
export async function incompleteDates(opts = {}) {
  const { days } = await computeCoverage(opts);
  return Object.entries(days).filter(([, d]) => d.status === 'partial').map(([date]) => date);
}
