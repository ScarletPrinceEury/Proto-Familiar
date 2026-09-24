/**
 * Offer-a-tracker cue (trackers build spec §5.4) — care-first, ward-worded.
 *
 * A pure-code detector over the needs-fulfilment ledger: a lapse CLASS (a need
 * my human keeps missing) that has come up ≥ MIN_LAPSES times in the last
 * WINDOW_DAYS, with NO tracker already covering it, earns ONE gentle offer to
 * start tracking it together — then rests for COOLDOWN_DAYS so the same offer
 * never comes round twice in a month.
 *
 * Care-first, not deficit-framed: the offer names a recurring snag and puts the
 * choice to track with my human; the choice is theirs, the offer is mine. A
 * sensitive-health concern (menses / compulsion / urge) is NEVER offered — those
 * ledgers are opt-in only (suggested:false), never suggested by me.
 *
 * Gate in code, ride the turn: the miss counts come FREE from the recurring
 * anchors enrich already fetched; the one tracker read only happens when a fresh
 * candidate actually survives the cooldown. No new LLM call.
 *
 * State (per-class last-offered stamp) lives in tomes/.offer-tracker.json via the
 * shared json-state helper, mirroring the tracker-cue aging store.
 *
 * NOTE — the §5.4 spec also names "readiness misses" as a second lapse source.
 * Readiness (stewardship.js) is an EPHEMERAL flag on an approaching event with an
 * open prerequisite — it keeps no durable per-item miss ledger to count over 30
 * days, so this pass draws only on the needs ledger (which does). The detector is
 * kept source-agnostic (`lapseClassesFromNeeds` → generic classes → the picker)
 * so a durable readiness-lapse ledger can feed it later without reshaping this.
 */

import path from 'path';
import { REPO_ROOT } from '../../repo-root.js';
import { readJsonState, writeJsonState } from '../util/json-state.js';
import { isNeedWindow } from '../schedule/needs-tracking.js';

const DEFAULT_TOMES_DIR = path.join(REPO_ROOT, 'tomes');
const FILENAME = '.offer-tracker.json';
const DAY = 24 * 3600 * 1000;

// A class must lapse this many times in the window before it's worth offering.
export const MIN_LAPSES = 3;
// The lapse-counting window, in days.
export const WINDOW_DAYS = 30;
// After an offer surfaces, that class rests this many days before it may again.
export const COOLDOWN_DAYS = 30;

// Concerns that are opt-in only and must never be offered (suggested:false).
const SENSITIVE_CLASS_RE = /\b(menses|menstrual|period|cycle|erp|compuls\w*|ritual|urge)\b/i;

function normalizeKey(label) {
  return String(label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Content tokens of a label (≥3 chars) — the unit for "is a tracker already
// covering this concern?" so "dinner" matches a "Dinner log" tracker.
function tokens(s) {
  return normalizeKey(s).split(' ').filter(t => t.length >= 3);
}

/**
 * Lapse classes from the needs ledger: per need-window anchor, the count of
 * `missed` occurrences within the window. Returns those at/over MIN_LAPSES,
 * most-missed first, merged by normalized label. Pure — no I/O.
 * @param {Array} needAnchors  recurring anchors (need-windows and others)
 * @param {{now?:number, windowDays?:number}} [opts]
 */
export function lapseClassesFromNeeds(needAnchors, { now = Date.now(), windowDays = WINDOW_DAYS } = {}) {
  const cutoff = now - windowDays * DAY;
  const byKey = new Map();
  for (const n of (Array.isArray(needAnchors) ? needAnchors : [])) {
    if (!isNeedWindow(n)) continue;
    const res = n.payload?.resolutions || {};
    let count = 0;
    for (const [d, r] of Object.entries(res)) {
      const t = Date.parse(d);
      if (r === 'missed' && Number.isFinite(t) && t >= cutoff) count += 1;
    }
    if (count < MIN_LAPSES) continue;
    const key = normalizeKey(n.label);
    if (!key) continue;
    const cur = byKey.get(key);
    if (cur) cur.count += count;
    else byKey.set(key, { key, label: n.label, count, source: 'need' });
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

/**
 * Drop classes that are sensitive (never offered) or still inside their
 * per-class cooldown. Cheap + pure — runs BEFORE the tracker read so the read
 * only happens when a fresh candidate survives.
 */
export function pruneOfferClasses(classes, state = {}, { now = Date.now(), cooldownDays = COOLDOWN_DAYS } = {}) {
  return (Array.isArray(classes) ? classes : []).filter(c => {
    if (SENSITIVE_CLASS_RE.test(c.label ?? '')) return false;
    const last = state?.[c.key]?.lastOfferedTs;
    if (Number.isFinite(last) && (now - last) < cooldownDays * DAY) return false;
    return true;
  });
}

// Is some existing tracker already covering this concern? (token overlap)
function hasAttachedTracker(classKey, trackerLabels) {
  const ct = new Set(tokens(classKey));
  if (!ct.size) return false;
  for (const lbl of (Array.isArray(trackerLabels) ? trackerLabels : [])) {
    if (tokens(lbl).some(t => ct.has(t))) return true;
  }
  return false;
}

/**
 * Pick ONE class to offer (the most-missed with no tracker attached) and stamp
 * its cooldown. Pure — returns the chosen cue (or null) and the next state.
 */
export function pickOfferCue({ classes = [], trackerLabels = [], state = {}, now = Date.now() }) {
  for (const c of classes) {
    if (hasAttachedTracker(c.key, trackerLabels)) continue;
    return { cue: c, state: { ...state, [c.key]: { lastOfferedTs: now } } };
  }
  return { cue: null, state };
}

/**
 * The first-person offer block — server-injected context, so literal "my human",
 * plain and care-first. Names the recurring snag without deficit-framing, names
 * the intent (offer to track it — no "if it fits" hedge on the raising), and
 * keeps the CHOICE with my human. DRAFT wording — ward-reviewed at merge.
 */
export function buildOfferTrackerBlock(cue) {
  if (!cue || !cue.label) return '';
  return [
    '[Might be worth offering to track]',
    `  — ${cue.label}: a recurring snag for my human this month (${cue.count} times I've noticed), and there's no ledger for it yet.`,
    'A good one to offer to track together — so we can watch for a pattern worth getting ahead of. Whether to track is theirs to choose; making the offer is mine. I\'ve noted it and won\'t raise the same one again for a while.',
  ].join('\n');
}

// ── Persistent per-class cooldown state (tomes/.offer-tracker.json) ───────────

function file(tomesDir) { return path.join(tomesDir, FILENAME); }

export async function readOfferState({ tomesDir = DEFAULT_TOMES_DIR } = {}) {
  return readJsonState(file(tomesDir), {});
}

export async function writeOfferState(state, { tomesDir = DEFAULT_TOMES_DIR } = {}) {
  return writeJsonState(file(tomesDir), state);
}

/**
 * One-call convenience for the chat path. Computes lapse classes from the need
 * anchors (free), prunes by cooldown/sensitivity, and ONLY THEN calls
 * `getTrackerLabels()` (the one tracker read) if a fresh candidate survives —
 * picks one, stamps its cooldown, and returns the rendered block (or '').
 * `advance` false selects without mutating state.
 *
 * @param {object} p
 * @param {Array} p.needAnchors            recurring anchors (from enrich's listRecurring)
 * @param {() => Promise<string[]>} p.getTrackerLabels  lazy tracker-label read
 */
export async function nextOfferCue({ needAnchors, getTrackerLabels, now = Date.now(), advance = true, tomesDir = DEFAULT_TOMES_DIR } = {}) {
  const classes = lapseClassesFromNeeds(needAnchors, { now });
  if (!classes.length) return '';
  const state = await readOfferState({ tomesDir });
  const live = pruneOfferClasses(classes, state, { now });
  if (!live.length) return '';
  const trackerLabels = (typeof getTrackerLabels === 'function') ? (await getTrackerLabels()) : [];
  const { cue, state: nextState } = pickOfferCue({ classes: live, trackerLabels, state, now });
  if (!cue) return '';
  if (advance) await writeOfferState(nextState, { tomesDir });
  return buildOfferTrackerBlock(cue);
}
