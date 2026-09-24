/**
 * Tracker cues (trackers build spec §5.3) — the gentle "this ledger's gone
 * quiet" nudge.
 *
 * Same shape as the gcal projection cue (aging state per id, prune-on-arrival,
 * a hard render cap, a per-turn cap), with one tracker-specific gate: each
 * tracker's own `ask_cap_per_day` decides how often its cue may re-appear —
 * 0 means never (an ERP log is never nudged, structurally). Candidates are the
 * currently-stale trackers from Unruh (`tracker_cues`); this module owns the
 * pacing and the block text.
 *
 * Three exits, all code-driven (no acknowledgement call):
 *   - Cleared on data arrival: the moment my human logs an entry the tracker
 *     stops being stale, so Unruh drops it from candidates and its aging state
 *     is pruned here — it vanishes by derivation.
 *   - Per-day cap: a tracker is re-offered at most `ask_cap_per_day` times in a
 *     ward-local day.
 *   - Aged out: after MAX_RENDERS total nudges it goes quiet whether or not it
 *     was logged — a cue is an offer, never a nag that never stops.
 *
 * Pure selection + block text; the persistent aging state lives in
 * tomes/.tracker-cue.json (read/written via the shared json-state helper).
 */

import path from 'path';
import { REPO_ROOT } from '../../repo-root.js';
import { readJsonState, writeJsonState } from '../util/json-state.js';

const DEFAULT_TOMES_DIR = path.join(REPO_ROOT, 'tomes');
const FILENAME = '.tracker-cue.json';

// A cue goes quiet after this many total nudges, however long apart.
export const MAX_RENDERS = 3;
// At most this many cue lines in one turn (spec §5.3: capped at 2 lines).
export const MAX_PER_TURN = 2;
// When a tracker doesn't set ask_cap_per_day, assume once a day.
export const DEFAULT_ASK_CAP = 1;

/**
 * Choose which stale trackers to cue this turn and advance the aging state.
 * Pure — no I/O.
 *
 * @param {object} p
 * @param {Array<{id,label,hours_since,ask_cap_per_day}>} p.candidates  Unruh's
 *        `tracker_cues.stale` (currently past staleness_hours)
 * @param {object} p.state    { [id]: { firstSeenTs, totalRenders, lastShownDay, shownToday } }
 * @param {string} p.todayKey ward-local YYYY-MM-DD (the ask_cap window unit)
 * @param {number} [p.now]
 * @returns {{ items: Array, nextState: object }}
 */
export function selectTrackerCues({ candidates = [], state = {}, todayKey, now = Date.now() }) {
  const list = Array.isArray(candidates) ? candidates.filter(c => c && c.id) : [];
  const liveIds = new Set(list.map(c => c.id));

  // Prune state for trackers no longer stale — a fresh entry cleared them.
  const nextState = {};
  for (const [id, entry] of Object.entries(state)) {
    if (liveIds.has(id)) nextState[id] = { ...entry };
  }

  const capOf = (c) => (Number.isFinite(c.ask_cap_per_day) ? c.ask_cap_per_day : DEFAULT_ASK_CAP);

  const eligible = list.filter(c => {
    const cap = capOf(c);
    if (cap <= 0) return false;                 // opt-out (erp) → never cued
    const e = nextState[c.id];
    if (!e) return true;                        // never nudged → eligible
    if (e.totalRenders >= MAX_RENDERS) return false;             // nagged enough
    if (e.lastShownDay === todayKey && e.shownToday >= cap) return false; // window used up today
    return true;
  });
  const items = eligible.slice(0, MAX_PER_TURN);

  for (const c of items) {
    const e = nextState[c.id] || { firstSeenTs: now, totalRenders: 0, lastShownDay: null, shownToday: 0 };
    const sameDay = e.lastShownDay === todayKey;
    nextState[c.id] = {
      firstSeenTs: e.firstSeenTs,
      totalRenders: e.totalRenders + 1,
      lastShownDay: todayKey,
      shownToday: sameDay ? e.shownToday + 1 : 1,
    };
  }

  return { items, nextState };
}

// Plain "X hours / Y days ago" — code owns the number; the model never computes it.
function sinceText(hours) {
  if (!Number.isFinite(hours)) return '';
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * The first-person cue block — server-injected context. Names what the cue is
 * for plainly, and makes clear it's an offer I won't keep re-raising (no
 * bias-toward-quiet language, no over-nagging). Carries a {{user}} token by
 * design: thalamus resolves it to my human's configured name at the injection
 * point (the narrow ward-asked exception to the "injected blocks are literal"
 * rule) — don't rewrite it to "my human" here. Returns '' for an empty set.
 */
export function buildTrackerCueBlock(items) {
  if (!Array.isArray(items) || !items.length) return '';
  const lines = items.map(it => {
    const since = sinceText(it.hours_since);
    // A gauge candidate carries a `band` (low/overdue, §10.5) → a decaying-upkeep
    // nudge, gentle then firmer. Everything else is a "gone quiet" stale ledger.
    if (it.band === 'low' || it.band === 'overdue') {
      const sinceTxt = since ? ` (last ~${since} ago)` : '';
      const state = it.band === 'overdue' ? 'overdue' : 'getting low';
      return `  — ${it.label ?? it.id}: ${state}${sinceTxt}  [id: ${it.id}]`;
    }
    const sinceText2 = since ? ` — last logged ${since} ago` : '';
    return `  — ${it.label ?? it.id}${sinceText2}  [id: ${it.id}]`;
  });
  return [
    '[Tracker cues]',
    ...lines,
    'Some of the things I track for {{user}}. I should check on the worrisome ones, and log any info from the conversation that is relevant to these in them, if any. Also refill gauges if appropriate.',
  ].join('\n');
}

// ── Persistent aging state (tomes/.tracker-cue.json) ──────────────────────────

function file(tomesDir) { return path.join(tomesDir, FILENAME); }

export async function readTrackerCueState({ tomesDir = DEFAULT_TOMES_DIR } = {}) {
  return readJsonState(file(tomesDir), {});
}

export async function writeTrackerCueState(state, { tomesDir = DEFAULT_TOMES_DIR } = {}) {
  return writeJsonState(file(tomesDir), state);
}

/**
 * One-call convenience for the chat path: read state, select this turn's cues,
 * persist the advanced state, return the rendered block. `advance` false selects
 * without mutating state (previews / static turns don't burn a cue's budget).
 */
export async function nextTrackerCue({ candidates, todayKey, now = Date.now(), advance = true, tomesDir = DEFAULT_TOMES_DIR } = {}) {
  if (!Array.isArray(candidates) || !candidates.length) return '';
  const state = await readTrackerCueState({ tomesDir });
  const { items, nextState } = selectTrackerCues({ candidates, state, todayKey, now });
  if (advance) await writeTrackerCueState(nextState, { tomesDir });
  return buildTrackerCueBlock(items);
}
