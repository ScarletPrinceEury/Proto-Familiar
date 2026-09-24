/**
 * Gauge safety ladder — G-C.2: the TEETH (§10.6 steps 2–3).
 *
 * ⚠️ SAFETY-CRITICAL, ward-signed (2026-09). This is the ONE place the gauge
 * ladder raises the ward's threat or reaches a trusted contact — deliberately
 * its own module so every crisis call site is auditable in one file and the
 * check module (`gauge-escalation.js`) stays structurally crisis-free.
 *
 * Invariant G1 (check-first) is enforced BEHAVIOURALLY here. An escalation
 * fires only for a gauge that:
 *   (a) is STILL in the `extreme` band right now (fresh candidate), AND
 *   (b) has an OPEN check — the check module opened it and a refill/recovery
 *       has NOT closed it (a log always stands the ladder down before this
 *       runs, since the check tick closes on recovery each tick), AND
 *   (c) whose check has gone unanswered for its full deadline, counted in the
 *       ward's ACTIVE hours (quiet hours excluded — a check opened at bedtime
 *       does not expire overnight and fire at 3am), AND
 *   (d) has not already escalated (one flag/contact per open check).
 * No open check → no teeth, EVER. This is the structural spine of G1: the
 * teeth cannot reach a gauge the check module hasn't first opened a check on.
 *
 * The teeth, in order:
 *   step 2 — flagDistress({ reason: 'gauge-critical: …' }) floors threat to
 *            severe. This is the model's-own-read seam; its weight/dedup/floor
 *            logic is UNCHANGED — we only convey the CAUSE via `reason` (stored
 *            in the threat audit). The severe tier then draws the existing
 *            silence-triage loop's full-context look on its next 5-min tick, so
 *            we don't add a triage call (ride the loop, gate in code).
 *   step 3 — OPT-IN per gauge: if `escalation.contact` is set, reach the named
 *            trusted contact via `deliverToTrustedContact`, which ALREADY
 *            mirrors every send into the ward's own outbox — the
 *            no-covert-contact rule is enforced there, not trusted to us. The
 *            contact is reached AFTER the flag, and a contact failure never
 *            un-does the flag or blocks the tick.
 *
 * Each escalation stamps `escalatedAt` on the shared check state so it fires
 * ONCE per open check; the stamp is cleared when the check closes on recovery
 * (the check module deletes the entry). Rides the check module's off-switch
 * (PROTO_FAMILIAR_GAUGE_ESCALATION_DISABLED=1) and its needs-loop timer.
 */

import { flagDistress } from '../safety/threat-tracker.js';
import { deliverToTrustedContact, readSettingsSync } from '../../cerebellum.js';
import { gaugeEscalationCandidates } from '../../thalamus.js';
import { activeMsInInterval } from './active-hours.js';
import {
  gaugeEscalationDisabled, readCheckState, writeCheckState,
} from './gauge-escalation.js';

const HOUR_MS = 60 * 60_000;
// When an enabled escalation somehow lacks the (validator-required) deadline,
// fall back to the ward's agreed default of 6 active hours rather than 0 (which
// would make an open check escalate instantly — the failure must be safe-slow).
export const DEFAULT_DEADLINE_HOURS = 6;

/** The deadline for a gauge, in ms of ACTIVE time. `checkin_deadline_hours` is
 *  validator-guaranteed positive for an enabled escalation; default-guarded. */
export function deadlineMsFor(escalation) {
  const h = Number(escalation?.checkin_deadline_hours);
  return (Number.isFinite(h) && h > 0 ? h : DEFAULT_DEADLINE_HOURS) * HOUR_MS;
}

/** Ward quiet-hours + zone from raw settings, normalized exactly like
 *  server.js `isWarmthQuietHours` (default 23→08; start===end disables). */
export function quietConfigFromSettings(s) {
  let quietStart = Number(s?.warmthQuietHoursStart);
  let quietEnd   = Number(s?.warmthQuietHoursEnd);
  if (!Number.isInteger(quietStart) || quietStart < 0 || quietStart > 23) quietStart = 23;
  if (!Number.isInteger(quietEnd)   || quietEnd   < 0 || quietEnd   > 23) quietEnd   = 8;
  return { quietStart, quietEnd, tz: s?.wardTimeZone || null };
}

/**
 * PURE decision: which open checks have gone unanswered past their active-hours
 * deadline and should escalate now. No I/O, no state mutation (the caller
 * stamps only what actually fires). Returns an array of escalate actions.
 *
 * @param {object} p
 * @param {Array<{id,label,band,hours_since,escalation}>} p.candidates  fresh, enabled-only
 * @param {object} p.checkState  { [id]: { checkOpenedAt, escalatedAt? } }
 * @param {{quietStart,quietEnd,tz}} p.quiet
 * @param {number} [p.now]
 * @param {(startMs:number,endMs:number,opts:object)=>number} [p.activeMs]  test seam
 */
export function selectGaugeEscalations({ candidates = [], checkState = {}, quiet = {}, now = Date.now(), activeMs = activeMsInInterval }) {
  const actions = [];
  for (const c of (Array.isArray(candidates) ? candidates : [])) {
    if (!c || !c.id || c.band !== 'extreme') continue;          // (a) still extreme
    const st = checkState[c.id];
    if (!st || !Number.isFinite(st.checkOpenedAt)) continue;    // (b) an OPEN check
    if (st.escalatedAt) continue;                               // (d) once per check
    const deadlineMs = deadlineMsFor(c.escalation);
    const active = activeMs(st.checkOpenedAt, now, {
      quietStart: quiet.quietStart, quietEnd: quiet.quietEnd, tz: quiet.tz, capMs: deadlineMs,
    });
    if (active < deadlineMs) continue;                          // (c) deadline not yet reached
    actions.push({ kind: 'escalate', id: c.id, label: c.label, hours_since: c.hours_since, escalation: c.escalation, activeMs: active, deadlineMs });
  }
  return actions;
}

// Plain duration, code-owned (exact-values rule). Mirrors the check message's
// phrasing so the flag reason and any contact read consistently.
function durationText(hours) {
  if (!Number.isFinite(hours)) return 'a while';
  if (hours < 48) return `about ${Math.round(hours)} hours`;
  return `about ${Math.round(hours / 24)} days`;
}

/** The threat-audit reason. Starts with the `gauge-critical` tag the ward chose
 *  so the cause is legible in the threat history. Threat-tracker caps to 300. */
export function buildGaugeCrisisReason({ label, hours_since, contactName } = {}) {
  const dur = durationText(hours_since);
  const tail = contactName ? ` Alerting ${contactName}.` : '';
  return `gauge-critical: ${label ?? 'a tracked upkeep'} not logged in ${dur}; my check-in went unanswered past its window.${tail}`;
}

/**
 * The trusted-contact message — code-built (a safety escalation must go out even
 * with the LLM down), first-person, identifies me as the Familiar, names my
 * human by their configured name (never a raw macro), specific but not alarming.
 * @param {{label, hours_since, wardName}} p
 */
export function buildGaugeContactMessage({ label, hours_since, wardName } = {}) {
  const who = (wardName && String(wardName).trim()) || 'the person I look after';
  const dur = durationText(hours_since);
  return `Hi — I'm ${who}'s Familiar (a companion app they use). I haven't seen them log ${label ?? 'something they usually keep up with'} in ${dur}, and a check-in I sent went unanswered for a while, so I wanted someone who cares about them to know. If you're able to check in with them, that would mean a lot.`;
}

/**
 * One tick of the TEETH. Rides the needs-tracking loop's timer, right after the
 * check tick (so the check state it reads already reflects this tick's
 * open/close). Fetches fresh candidates, decides via `selectGaugeEscalations`,
 * and for each: raises threat, optionally reaches the opt-in contact, and stamps
 * `escalatedAt` — writing the state ONCE at the end. Every dep is injectable for
 * deterministic tests; defaults wire the real seams.
 */
export async function runGaugeCrisisTick({
  now = Date.now(),
  candidates,                                   // test seam
  fetchCandidates = gaugeEscalationCandidates,
  readState       = readCheckState,
  writeState      = writeCheckState,
  readSettings    = readSettingsSync,
  flag            = flagDistress,
  deliverContact  = deliverToTrustedContact,
  tomesDir,
  enabled,
  threatDisabled  = () => process.env.PROTO_FAMILIAR_THREAT_DISABLED === '1',
} = {}) {
  if (!(enabled ?? !gaugeEscalationDisabled())) return { reason: 'disabled' };
  // The teeth are a threat-escalation feature: when the threat detector is off,
  // the WHOLE ladder stands down — not just the raise (which flagDistress would
  // no-op anyway) but the opt-in contact too, so a disabled detector can never
  // still reach a human. (G4 — ward-signed.)
  if (threatDisabled()) return { reason: 'threat-disabled' };

  let list = candidates;
  if (!Array.isArray(list)) {
    try { const r = await fetchCandidates(); list = Array.isArray(r?.gauges) ? r.gauges : []; }
    catch { return { reason: 'unruh-unavailable' }; }
  }

  const state = await readState(tomesDir ? { tomesDir } : {});
  let settings = {};
  try { settings = readSettings() || {}; } catch { /* fresh install → defaults */ }
  const quiet = quietConfigFromSettings(settings);

  const actions = selectGaugeEscalations({ candidates: list, checkState: state, quiet, now });
  if (!actions.length) return { reason: 'ran', escalated: 0, contacted: 0 };

  const nextState = { ...state };
  let escalated = 0, contacted = 0;
  for (const a of actions) {
    // step 2 — raise threat. flagDistress is idempotent (re-floors, never climbs)
    // and robust, but if it THROWS we leave the check un-stamped so the raise
    // retries next tick rather than being silently lost.
    const esc = a.escalation || {};
    const wantContact = !!esc.contact && typeof esc.contact_id === 'string' && esc.contact_id.trim();
    const contactName = wantContact ? esc.contact_id.trim() : null;
    try {
      // Threat store and check state are the same tomes/ dir in production;
      // forwarding tomesDir keeps them co-located and lets tests isolate both.
      await flag({ reason: buildGaugeCrisisReason({ label: a.label, hours_since: a.hours_since, contactName }), now, ...(tomesDir ? { tomesDir } : {}) });
    } catch (err) {
      console.error('[gauge-crisis] threat flag failed (will retry next tick):', err?.message ?? err);
      continue;   // do NOT stamp — retry the raise next tick
    }
    nextState[a.id] = { ...(nextState[a.id] || {}), escalatedAt: now };
    escalated += 1;

    // step 3 — OPT-IN trusted-contact reach. The mirror is enforced inside
    // deliverToTrustedContact; a failure here is logged (and mirrored by that
    // function's own outbox write) but never un-does the flag or blocks the loop.
    if (wantContact) {
      try {
        const msg = buildGaugeContactMessage({ label: a.label, hours_since: a.hours_since, wardName: settings.userName });
        const r = await deliverContact({ name: contactName, message: msg, channel: esc.contact_channel || 'discord' });
        if (r && r.ok) contacted += 1;
      } catch (err) {
        console.error('[gauge-crisis] trusted-contact reach failed:', err?.message ?? err);
      }
    }
  }

  await writeState(nextState, tomesDir ? { tomesDir } : {});
  if (escalated) console.log(`[gauge-crisis] escalated ${escalated} unanswered check(s)${contacted ? `, reached ${contacted} contact(s)` : ''}`);
  return { reason: 'ran', escalated, contacted };
}
