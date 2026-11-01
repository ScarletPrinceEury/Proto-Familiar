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
 * A failed look isn't a look (ward-signed 0.14.121, known-issues D1). About a
 * third of due-intention looks were failing on provider trouble, and a failed
 * one used to count as seen, so a cool-down of up to six hours sat on it. Now
 * only a look that ran marks an intention seen. A failed look at something due
 * tries again 5, 15 and 30 minutes after it first failed (straight to the
 * fallback models on a usage limit, which noticing's call already walks); if it
 * still can't get a look, it's held, and my next live turn with my human says
 * so (noticing-held.js). This is only for due intentions: a failed look at
 * anything else keeps the loop's usual pacing.
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

// When a failed look at something due tries again, counted from its first
// failure (ward-signed 0.14.121). Three tries, then it's held for my next chat.
export const NOTICING_RETRY_OFFSETS_MS = Object.freeze([5, 15, 30].map(m => m * 60_000));

let _started           = false;
let _interval          = null;
let _guard             = null;
let _nextAllowedTickTs = 0;
let _seenDue           = new Set();   // due intention ids a look has already covered
let _failing           = new Map();   // due intention id → { intention, since, tries, held }
let _retryTimer        = null;

/** The due intentions a tick was about. */
function dueIntentionsOf(r) {
  return (r?.conditions ?? []).filter(c => c?.kind === 'due_intention' && c.intention?.id).map(c => c.intention);
}

/** Is a retry owed by now? */
export function retryIsDue(failing, nowMs, offsets = NOTICING_RETRY_OFFSETS_MS) {
  for (const e of failing.values()) {
    if (!e.held && e.tries > 0 && nowMs >= e.since + offsets[e.tries - 1]) return true;
  }
  return false;
}

/**
 * Where each due intention stands after a tick. Pure.
 *
 * outcome 'ran': a look actually ran (acted or stood down). What it had in
 *   front of it is covered: out of `failing`, and into `released` so any held
 *   note for it goes.
 * outcome 'failed': each due intention it was about uses a try; with none left,
 *   or when every connection said its allowance is used up (`usageLimited`), it's
 *   held for my next chat. One already held stays held: no second note, no more
 *   tries.
 * outcome 'quiet': nothing due was looked at; entries carry on.
 *
 * `covered`: ids an earlier look that ran already had in front of it (it chose
 * to wait, so it's still due). A later failure isn't news about those: they
 * get no tries and no note.
 *
 * An entry the tick no longer had as due: a phase round whose window passed
 * while it waited for a retry never got its look, so it's held; a timed one
 * stays due until it's marked, so it's gone because it was seen to and is
 * dropped.
 *
 * Returns { failing, held, released, retryAt } (retryAt null when no retry is
 * owed).
 */
export function settleDueLooks(failing, { outcome, due = [], nowMs, usageLimited = false, covered = new Set(), offsets = NOTICING_RETRY_OFFSETS_MS }) {
  const next = new Map();
  const held = [];
  const released = [];
  const dueIds = new Set(due.map(i => i.id));
  for (const [id, e] of failing) {
    if (dueIds.has(id) || e.held) continue;
    if (e.intention?.trigger?.kind === 'phase') held.push({ ...e, held: true });
  }
  for (const it of due) {
    const prev = failing.get(it.id);
    if (outcome === 'ran') { released.push(it.id); continue; }
    if (outcome !== 'failed') { if (prev) next.set(it.id, prev); continue; }
    if (prev?.held) { next.set(it.id, prev); continue; }
    if (!prev && covered.has(it.id)) continue;
    const e = { intention: it, since: prev?.since ?? nowMs, tries: prev?.tries ?? 0, held: false };
    if (usageLimited || e.tries >= offsets.length) { e.held = true; held.push(e); }
    else e.tries += 1;
    next.set(it.id, e);
  }
  const waits = [...next.values()].filter(e => !e.held).map(e => e.since + offsets[e.tries - 1]);
  return { failing: next, held, released, retryAt: waits.length ? Math.max(nowMs, Math.min(...waits)) : null };
}

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
  onHeld     = async () => {},  // async ([{ intention, since }]) — out of tries: hold for my next chat
  onReleased = async () => {},  // async ([id]) — a look ran for these: drop their held notes
  retryOffsetsMs = NOTICING_RETRY_OFFSETS_MS,
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

  // Wake for an owed retry instead of waiting for the next base tick. If a tick
  // was already running when it fired (and so didn't see the retry was owed),
  // come back once, shortly; after that the base tick's gate picks it up.
  const armRetry = (at, again = true) => {
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    if (at == null || !_started) return;
    _retryTimer = setTimeout(async () => {
      _retryTimer = null;
      await fire();
      if (again && _started && !_retryTimer && retryIsDue(_failing, now(), retryOffsetsMs)) armRetry(now() + 1000, false);
    }, Math.max(0, at - now()));
    _retryTimer.unref?.();
  };

  const fire = () => _guard.run(async () => {
    try {
      if (!(await isEnabled())) { onTick({ acted: false, reason: 'disabled' }); return; }
      // Cadence gate: don't deliberate again until the self-set (or default)
      // cool-down has elapsed. The wake-condition gate inside the tick is
      // separate — this only paces how often we even look. An owed retry of a
      // failed look at something due goes ahead regardless.
      const nowMs = now();
      let dueWake = false;
      let freshIds = [];
      if (nowMs < _nextAllowedTickTs && !retryIsDue(_failing, nowMs, retryOffsetsMs)) {
        // In cool-down, only an intention that has newly come due gets a look.
        // One already waiting on a retry (or held for my next chat) has its own
        // schedule and doesn't wake this.
        let ids = [];
        if (typeof getDueIntentionIds === 'function') {
          try { ids = await getDueIntentionIds(); } catch (err) { onError(err); }
        }
        const { fresh, seen } = freshDueIntentions(ids, _seenDue);
        _seenDue = seen;
        freshIds = fresh.filter(id => !_failing.has(id));
        if (!freshIds.length) {
          onTick({ acted: false, reason: 'in_cooldown', cooldownUntilTs: _nextAllowedTickTs });
          return;
        }
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
      // Only a look that ran (or found nothing ready) has covered what's due.
      // A failed one leaves what it was about unseen: it gets its retries, then
      // a held note. A fresh one whose condition didn't pass was settled by code,
      // not the model, so it's seen either way.
      const due = dueIntentionsOf(r);
      const failed = r.reason === 'deliberation_failed';
      const dueIds = new Set(due.map(it => it.id));
      for (const id of freshIds) if (!failed || !dueIds.has(id)) _seenDue.add(id);
      if (!failed) for (const id of dueIds) _seenDue.add(id);
      const outcome = failed ? 'failed' : (r.reason === 'acted' || r.reason === 'stood_down') ? 'ran' : 'quiet';
      const settled = settleDueLooks(_failing, { outcome, due, nowMs, usageLimited: r.usageLimited === true, covered: _seenDue, offsets: retryOffsetsMs });
      _failing = settled.failing;
      if (settled.released.length) {
        try { await onReleased(settled.released); } catch (err) { onError(err); }
      }
      if (settled.held.length) {
        try { await onHeld(settled.held.map(e => ({ intention: e.intention, since: e.since }))); } catch (err) { onError(err); }
        r.heldForChat = settled.held.map(e => e.intention.id);
      }
      if (settled.retryAt != null) {
        r.retryAt = settled.retryAt;
        // Out of cool-down, the base tick would look again on its own and use
        // up the retries early. Wait for the booked one instead: both of the
        // first two come sooner than the base tick would have.
        if (_nextAllowedTickTs <= nowMs) _nextAllowedTickTs = settled.retryAt;
      }
      armRetry(settled.retryAt);
      if (dueWake) r.dueWake = true;
      r.tookMs = now() - nowMs;
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
  if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
  const guard = _guard;
  _started           = false;
  _nextAllowedTickTs = 0;
  _seenDue           = new Set();
  _failing           = new Map();
  if (guard) await guard.settle();
}

export function isRunning() { return _started; }
