// surface-events.js
//
// The Familiar's record of surface offers and their outcomes. Slice
// 2's heart: every time the consumer pipeline offers a candidate, an
// event is appended; later (next chat turn, or at reflection time)
// the outcome tagger reads the current schedule state and classifies
// what happened. The reflection-mode pondering loop reads tagged
// outcomes to learn patterns for `what_lapses_cost.md`.
//
// Storage lives at `tomes/.surface-events.json` — per-embodiment, like
// ponderings. The derived insights (lifted to entity-core's identity
// layer) belong to the human's continuity; the raw behavioural stream
// belongs to this instance.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EVENTS_PATH = path.resolve(__dirname, 'tomes', '.surface-events.json');

// Retention bounds — prune events whose age and outcome no longer
// have analytical value. Reflection looks at the tail; ancient events
// were either tagged long ago or never will be.
const EVENT_RETENTION_MS = 30 * 24 * 3600 * 1000;
const EVENT_HARD_CAP     = 500;

// How long to wait before declaring a task "unresponded" if no
// resolution arrived. Longer than the dedup window so we don't tag
// "ignored" on a task that's about to surface again to the same
// person who was just asleep.
const UNRESPONDED_THRESHOLD_MS = 24 * 3600 * 1000;

// Outcome class constants — keep these exported so the reflection
// prompt can list them and tests can assert against the same set.
export const OUTCOMES = Object.freeze({
  ENGAGED_AND_COMPLETED: 'engaged_and_completed',
  CANCELLED:             'cancelled',
  DEFERRED:              'deferred',
  FIRED:                 'fired',
  UNRESPONDED:           'unresponded',
});

// ── File I/O ─────────────────────────────────────────────────────

const EMPTY_STORE = { version: 2, last_reflection_at: null, events: [] };

export async function loadSurfaceEvents() {
  try {
    const raw = await fs.readFile(EVENTS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.events)) {
      return {
        version: parsed.version ?? 2,
        last_reflection_at: parsed.last_reflection_at ?? null,
        events: parsed.events,
      };
    }
  } catch { /* missing or malformed → empty store */ }
  return { ...EMPTY_STORE, events: [] };
}

async function saveSurfaceEvents(store) {
  try {
    const pruned = pruneEvents(store);
    await fs.writeFile(EVENTS_PATH, JSON.stringify(pruned, null, 2), 'utf8');
  } catch (err) {
    console.error('[surface-events] save failed:', err?.message ?? err);
  }
}

function pruneEvents(store) {
  const now = Date.now();
  const cutoff = now - EVENT_RETENTION_MS;
  const kept = (store.events ?? []).filter(e =>
    typeof e?.offered_at === 'number' && e.offered_at >= cutoff
  );
  // If still over hard cap, keep the most-recent N. Sorted ascending
  // by offered_at; slice from the tail.
  kept.sort((a, b) => a.offered_at - b.offered_at);
  const capped = kept.length > EVENT_HARD_CAP
    ? kept.slice(kept.length - EVENT_HARD_CAP)
    : kept;
  return { ...store, events: capped };
}

// ── Recording offers ─────────────────────────────────────────────

/**
 * Append a surface-offer event for each candidate the pipeline
 * decided to expose this turn. State-snapshot is what I knew when
 * I offered — used later by reflection to correlate state with
 * outcome.
 *
 * @param {Array<object>} candidates — output of selectSurfaceCandidates()
 * @param {object} stateSnapshot     — { threat_tier, routine_phase, ... }
 * @param {number} [nowMs]
 */
export async function recordSurfaceOffers(candidates, stateSnapshot = {}, nowMs = Date.now()) {
  if (!Array.isArray(candidates) || candidates.length === 0) return;
  const store = await loadSurfaceEvents();
  for (const c of candidates) {
    if (!c?.id) continue;
    store.events.push({
      id:             randomUUID(),
      task_id:        c.id,
      task_label:     c.label,
      task_type:      c.type,
      stakes_tier:    c.stakesTier,
      confidence:     c.confidence,
      offered_at:     nowMs,
      state_snapshot: { ...stateSnapshot },
      outcome:        null,
      outcome_at:     null,
    });
  }
  await saveSurfaceEvents(store);
}

// ── Dedup lookup ─────────────────────────────────────────────────

/**
 * Return { taskId → most-recent offer ms } for the dedup gate.
 * Pulled from the same event stream so there's one source of truth.
 */
export async function getRecentOfferTimes() {
  const store = await loadSurfaceEvents();
  const map = {};
  for (const e of store.events ?? []) {
    if (!e?.task_id) continue;
    const t = e.offered_at;
    if (typeof t !== 'number') continue;
    if (map[e.task_id] == null || t > map[e.task_id]) map[e.task_id] = t;
  }
  return map;
}

// ── Outcome tagger ───────────────────────────────────────────────

/**
 * Map Unruh schedule resolution → my outcome enum. Resolutions are
 * the source of truth for "did this task close, and how."
 */
function resolutionToOutcome(resolution) {
  switch (String(resolution || '').toLowerCase()) {
    case 'done':            return OUTCOMES.ENGAGED_AND_COMPLETED;
    case 'cancelled':       return OUTCOMES.CANCELLED;
    case 'carried_forward': return OUTCOMES.DEFERRED;
    case 'fired':           return OUTCOMES.FIRED;
    default:                return null;
  }
}

/**
 * Classify any untagged events against the current schedule state.
 * Pure code — no LLM. The current schedule comes from the same
 * temporal_context payload the chat turn already loaded, so this
 * adds zero MCP calls.
 *
 * @param {object} opts
 * @param {Array}  opts.windowItems  — temporalPayload.schedule.window (open + resolved)
 * @param {number} [opts.now]
 * @returns {Promise<{ tagged: number, skipped: number }>}
 */
export async function tagOutcomes({ windowItems, now = Date.now() }) {
  const store = await loadSurfaceEvents();
  if (!store.events?.length) return { tagged: 0, skipped: 0 };

  const byId = new Map();
  for (const item of windowItems ?? []) {
    if (item?.id) byId.set(item.id, item);
  }

  let tagged = 0;
  let skipped = 0;
  let mutated = false;

  for (const ev of store.events) {
    if (ev.outcome) continue; // already tagged
    const item = byId.get(ev.task_id);
    let outcome = null;

    if (item && item.resolution) {
      outcome = resolutionToOutcome(item.resolution);
    } else if (now - ev.offered_at >= UNRESPONDED_THRESHOLD_MS) {
      // Old enough to give up waiting. The task may have aged out of
      // the window entirely (no resolution we can see) or still be
      // unresolved; either way, my surface didn't land in a
      // measurable way.
      outcome = OUTCOMES.UNRESPONDED;
    } else {
      skipped += 1;
      continue;
    }

    if (outcome) {
      ev.outcome    = outcome;
      ev.outcome_at = now;
      tagged += 1;
      mutated = true;
    } else {
      skipped += 1;
    }
  }

  if (mutated) await saveSurfaceEvents(store);
  return { tagged, skipped };
}

// ── Reflection inputs ────────────────────────────────────────────

/**
 * Return tagged outcomes whose outcome_at is after last_reflection_at.
 * The reflection loop reads these to look for patterns.
 */
export async function getNewOutcomesSinceLastReflection() {
  const store = await loadSurfaceEvents();
  const since = typeof store.last_reflection_at === 'number'
    ? store.last_reflection_at
    : 0;
  return (store.events ?? [])
    .filter(e => e.outcome && typeof e.outcome_at === 'number' && e.outcome_at > since)
    .sort((a, b) => a.outcome_at - b.outcome_at);
}

/**
 * Should the next pondering tick run in reflection mode? Returns
 * true once enough new outcomes have accumulated to make patterns
 * visible. Threshold is intentionally conservative — one or two
 * outcomes is noise; reflection on noise produces noise in
 * what_lapses_cost.md.
 */
export async function shouldReflectNow({ minOutcomes = 5 } = {}) {
  const fresh = await getNewOutcomesSinceLastReflection();
  return fresh.length >= minOutcomes;
}

/**
 * Mark a reflection as having happened — subsequent fresh-outcome
 * queries will only see events tagged AFTER this moment.
 */
export async function markReflected(nowMs = Date.now()) {
  const store = await loadSurfaceEvents();
  store.last_reflection_at = nowMs;
  await saveSurfaceEvents(store);
}
