/**
 * Noticing loop — the heartbeat that gives the Familiar its own turn.
 *
 * The counterpart to silence-triage and warm reach-out, but pointed inward:
 * on each tick, code checks whether anything is worth noticing (a due
 * intention, a rhythm deviation, a readiness gap, an aging commitment) and
 * ONLY THEN does the Familiar get a deliberation. No wake condition → no
 * turn (the OpenClaw anti-pattern avoided: code decides when there's
 * something to look at, not a fixed hourly checklist).
 *
 * Shape mirrors reachout-loop.js: a pure, fully-injectable runOneNoticingTick
 * (in noticing.js) carries the behaviour; this thin singleton drives it on an
 * interval with a self-set cadence.
 *
 * Unlike the caring loops, this one does NOT stand down at elevated threat —
 * that's the ward-signed decision (noticing matters most in distress). The
 * cadence gate here is the only pacing; the wake-condition gate inside the
 * tick is what keeps it from firing needlessly.
 *
 * A newly due intention ends the cool-down (ward-signed 0.14.99). The cool-down
 * the Familiar sets paces how often it looks around, up to six hours; an
 * intention coming due is an appointment it made with itself (or a promise the
 * app caught from chat), and shouldn't wait that out. Only an intention the
 * last look hadn't covered counts, so one that's still due doesn't re-wake
 * every base tick.
 *
 * Off-switch: settings `noticingEnabled` (default ON) or
 * PROTO_FAMILIAR_NOTICING_DISABLED=1 (checked by the wrapper's isEnabled in
 * server.js).
 */

import { runOneNoticingTick, DEFAULT_NOTICING_TICK_MS } from './noticing.js';
import { createTickGuard } from '../util/tick-guard.js';

// Watchdog on the tick guard (ward-signed 0.14.67). The deliberation is already
// capped at 600s in total (runNoticingToolLoop), so only the wake-input reads
// before it could still hang — which used to stop noticing for good. Released
// after this long and reported through onTick (reason 'tick_released' →
// noticing-events; no wait-streak change, since nothing was decided); the next
// base tick looks again.
export const NOTICING_WATCHDOG_MS = 20 * 60_000;

let _started           = false;
let _interval          = null;
let _guard             = null;
let _nextAllowedTickTs = 0;
let _seenDue           = new Set();   // due intention ids a look has already covered

/**
 * Which due intentions haven't been looked at yet. `seen` is pruned to the ids
 * still due, so an intention that stops being due and later comes due again
 * (a daily round) counts as new. Pure. Returns { fresh, seen }.
 */
export function freshDueIntentions(dueIds = [], seen = new Set()) {
  const due  = new Set((Array.isArray(dueIds) ? dueIds : []).filter(Boolean));
  const kept = new Set([...seen].filter(id => due.has(id)));
  return { fresh: [...due].filter(id => !kept.has(id)), seen: kept };
}

export function startNoticingLoop({
  tickMs     = DEFAULT_NOTICING_TICK_MS,
  watchdogMs = NOTICING_WATCHDOG_MS,
  onTick     = () => {},
  onError    = () => {},
  isEnabled  = async () => true,
  now        = Date.now,
  getDueIntentionIds = null,   // async () => [id]; enables the due-intention wake
  ...tickConfig
}) {
  if (_started) throw new Error('noticing loop already running');
  _started = true;

  _guard = createTickGuard({
    name: 'noticing', watchdogMs,
    onRelease: () => {
      try { onTick({ acted: false, reason: 'tick_released', conditions: [], at: now() }); } catch (err) { onError(err); }
    },
  });
  const fire = () => _guard.run(async () => {
    try {
      if (!(await isEnabled())) { onTick({ acted: false, reason: 'disabled' }); return; }
      // Cadence gate: don't deliberate again until the self-set (or default)
      // cool-down has elapsed. The wake-condition gate inside the tick is
      // separate — this only paces how often we even look.
      const nowMs = now();
      let dueWake = false;
      if (nowMs < _nextAllowedTickTs) {
        // In cool-down, only an intention that has newly come due gets a look.
        let ids = [];
        if (typeof getDueIntentionIds === 'function') {
          try { ids = await getDueIntentionIds(); } catch (err) { onError(err); }
        }
        const { fresh, seen } = freshDueIntentions(ids, _seenDue);
        _seenDue = seen;
        if (!fresh.length) {
          onTick({ acted: false, reason: 'in_cooldown', cooldownUntilTs: _nextAllowedTickTs });
          return;
        }
        for (const id of fresh) _seenDue.add(id);
        dueWake = true;
      }
      const r = await runOneNoticingTick({ now, ...tickConfig });
      // Set the cool-down from the tick's chosen cadence. A quiet window
      // (no wake condition) uses the base tick interval — cheap to re-check
      // soon since it costs no LLM call. A due-intention wake that found
      // nothing to look at after all (its condition didn't pass) keeps the
      // cool-down that was already set.
      if (r.reason === 'quiet_window') {
        if (!dueWake) _nextAllowedTickTs = nowMs + tickMs;
      } else if (Number.isFinite(r.nextCheckInMs)) {
        _nextAllowedTickTs = nowMs + r.nextCheckInMs;
      }
      for (const c of r.conditions ?? []) {
        if (c?.kind === 'due_intention' && c.intention?.id) _seenDue.add(c.intention.id);
      }
      if (dueWake) r.dueWake = true;
      try { onTick(r); } catch (err) { onError(err); }
    } catch (err) {
      try { onError(err); } catch { /* swallow */ }
    }
  });

  _interval = setInterval(() => { fire(); }, tickMs);
  _interval.unref?.();
  // No immediate fire — one tick after boot, like the other loops.
  return { stop: stopNoticingLoop };
}

/** Reset the cadence gate so the next tick deliberates unconditionally. */
export function resetNoticingCooldown() { _nextAllowedTickTs = 0; }

export async function stopNoticingLoop() {
  if (!_started) return;
  if (_interval) { clearInterval(_interval); _interval = null; }
  const guard = _guard;
  _started           = false;
  _nextAllowedTickTs = 0;
  _seenDue           = new Set();
  if (guard) await guard.settle();
}

export function isRunning() { return _started; }
