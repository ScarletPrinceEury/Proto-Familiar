/**
 * Gauge safety ladder — G-C.1: the CHECK (§10.6 step 1).
 *
 * ⚠️ SAFETY-CRITICAL, ward-signed (2026-09). A gauge measures time since my
 * human last LOGGED the thing, not since they last DID it (they eat at a
 * friend's and never mention it). So an `extreme` band NEVER auto-escalates —
 * it opens a CHECK: a warm, direct "are you okay? has this been happening?"
 * A human-confirmable check stands between "my data looks alarming" and any
 * alarm. This is invariant G1.
 *
 * **This module owns ONLY the check** — open on extreme, close on
 * refill/recovery. It stays crisis-free BY DESIGN: there is no threat raise and
 * no contact anywhere in this file, and it imports no crisis module (a
 * structural pin holds this). The teeth (deadline → flag_distress → opt-in
 * contact, G-C.2) live in the sibling `gauge-crisis.js`, which reads the same
 * check state through `readCheckState`/`writeCheckState` below and can only
 * fire for a check THIS module already opened — so invariant G1 (check-first)
 * is structural on the check side and behavioural on the crisis side.
 *
 * Ward decisions baked in: extreme hydration 48h / meals 72h (the gauge
 * templates' own `extreme_hours`); escalation opt-in per gauge, off by default.
 * The check runs on the existing needs-tracking tick (reuse, don't add a loop)
 * and — unlike needs-marking — does NOT stand down at elevated threat: a
 * "have you eaten in 3 days?" check is exactly the care that matters most in a
 * rough stretch (the noticing-loop precedent). Off-switch:
 * PROTO_FAMILIAR_GAUGE_ESCALATION_DISABLED=1.
 */

import path from 'path';
import { REPO_ROOT } from '../../repo-root.js';
import { readJsonState, writeJsonState } from '../util/json-state.js';
import { enqueueOutbox } from '../safety/outbox.js';
import { gaugeEscalationCandidates } from '../../thalamus.js';

const DEFAULT_TOMES_DIR = path.join(REPO_ROOT, 'tomes');
const FILENAME = '.gauge-checks.json';

export function gaugeEscalationDisabled() {
  return process.env.PROTO_FAMILIAR_GAUGE_ESCALATION_DISABLED === '1'
      || process.env.PROTO_FAMILIAR_TRACKERS_DISABLED === '1';
}

/**
 * Decide check open/close from the current gauges + the open-check state. PURE.
 *   - band `extreme`, no open check  → OPEN (stamp checkOpenedAt).
 *   - band recovered (a refill dropped it below extreme) with a check open → CLOSE (G2).
 *   - band `extreme` with a check already open → nothing (the check stands; the
 *     deadline→crisis is G-C.2).
 * State for a gauge that dropped out (escalation turned off / archived / deleted)
 * is pruned. Returns {actions, nextState}.
 */
export function selectGaugeCheckActions({ candidates = [], checkState = {}, now = Date.now() }) {
  const next = { ...checkState };
  const actions = [];
  const liveIds = new Set();
  for (const c of (Array.isArray(candidates) ? candidates : [])) {
    if (!c || !c.id) continue;
    liveIds.add(c.id);
    const open = next[c.id];
    if (c.band === 'extreme') {
      if (!open) {
        actions.push({ kind: 'open', id: c.id, label: c.label, hours_since: c.hours_since, escalation: c.escalation });
        next[c.id] = { checkOpenedAt: now };
      }
    } else if (open) {
      actions.push({ kind: 'close', id: c.id, label: c.label });
      delete next[c.id];
    }
  }
  for (const id of Object.keys(next)) if (!liveIds.has(id)) delete next[id];
  return { actions, nextState: next };
}

function durationText(hours) {
  if (!Number.isFinite(hours)) return 'a while';
  if (hours < 48) return `about ${Math.round(hours)} hours`;
  return `about ${Math.round(hours / 24)} days`;
}

/**
 * The check reach-out — code-built (a safety check must fire even with the LLM
 * down), with the exact duration + label filled by code (exact-values rule).
 * DRAFT wording, ward-reviewed at merge. First-person, direct, addressed to my
 * human; no hedge. An optional per-gauge `escalation.check_phrase` ("eaten",
 * "had some water") makes the ask read naturally.
 */
export function buildGaugeCheckMessage({ label, hours_since, escalation } = {}) {
  const dur = durationText(hours_since);
  const phrase = (escalation && typeof escalation.check_phrase === 'string' && escalation.check_phrase.trim()) || '';
  const ask = phrase ? `Have you been able to ${phrase}?` : 'Has it been happening and just not making it into the log?';
  return {
    title: 'Just checking in',
    body: `I haven't seen ${label ?? 'this'} logged in ${dur} — that's long enough that I'd rather actually ask than guess. Are you okay? ${ask}`,
  };
}

function file(tomesDir) { return path.join(tomesDir, FILENAME); }

// The check state ({ [gaugeId]: { checkOpenedAt, escalatedAt? } }) is owned
// here — both this CHECK tick and the G-C.2 crisis tick (gauge-crisis.js) read
// and write it through these accessors, so there's one owner of the file and
// no path duplicated across the two modules. `escalatedAt` is stamped by the
// crisis tick and left intact by this module (an already-open check is never
// re-opened, so its stamp survives until the check closes on recovery).
export async function readCheckState({ tomesDir = DEFAULT_TOMES_DIR } = {}) {
  return readJsonState(file(tomesDir), {});
}
export async function writeCheckState(state, { tomesDir = DEFAULT_TOMES_DIR } = {}) {
  return writeJsonState(file(tomesDir), state);
}

/**
 * One tick of the check ladder (G-C.1). Rides the needs-tracking loop's timer.
 * Reads escalation-enabled gauges, opens/closes checks, delivers an open check
 * as a ward outbox reach-out. Fire-and-forget safe: a delivery failure leaves
 * the check un-stamped so it retries next tick (the outbox dedups on originId,
 * so a retry can't double-post). NO threat, NO contact (that's G-C.2).
 */
export async function runGaugeCheckTick({
  now = Date.now(),
  candidates,                                   // test seam
  fetchCandidates = gaugeEscalationCandidates,
  enqueue = enqueueOutbox,
  tomesDir = DEFAULT_TOMES_DIR,
  enabled,
} = {}) {
  if (!(enabled ?? !gaugeEscalationDisabled())) return { reason: 'disabled' };

  let list = candidates;
  if (!Array.isArray(list)) {
    try { const r = await fetchCandidates(); list = Array.isArray(r?.gauges) ? r.gauges : []; }
    catch { return { reason: 'unruh-unavailable' }; }
  }

  const state = await readCheckState({ tomesDir });
  const { actions, nextState } = selectGaugeCheckActions({ candidates: list, checkState: state, now });

  let opened = 0;
  for (const a of actions.filter(x => x.kind === 'open')) {
    const msg = buildGaugeCheckMessage(a);
    try {
      await enqueue({ kind: 'gauge-check', originId: `gauge-check:${a.id}`, title: msg.title, body: msg.body, ts: new Date(now).toISOString() });
      opened += 1;
    } catch {
      // Reach-out didn't go out → don't record the check as opened; retry next tick.
      delete nextState[a.id];
    }
  }
  await writeCheckState(nextState, { tomesDir });
  if (opened) console.log(`[gauge-check] opened ${opened} care check(s)`);
  return { reason: 'ran', opened, closed: actions.filter(x => x.kind === 'close').length };
}
