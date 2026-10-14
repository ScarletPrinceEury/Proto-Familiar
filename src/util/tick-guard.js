/**
 * tick-guard.js — the in-flight guard every background loop uses, with a
 * watchdog (0.14.67).
 *
 * Each loop skips a tick while the previous one is still running, so ticks never
 * overlap. Before this, that guard cleared only when the tick SETTLED — so a
 * tick stuck on an await that never returns (an MCP call, a tool, a file lock,
 * anything without its own bound) stopped the loop for good, and nothing said
 * so. Provider calls are bounded (llm-call.js), but the guard can't rely on
 * every await below it being bounded.
 *
 * The watchdog: a tick still running `watchdogMs` after it started is released —
 * logged loudly, counted (tickGuardStatus, surfaced on /api/health), and the next
 * tick may run. Nothing can force-cancel arbitrary awaits, so the stuck tick
 * keeps going in the background, but the `tick` handle it was given is marked
 * `abandoned` and its `signal` aborted: calls that take the signal stop, and a
 * loop can check `tick.abandoned` before a side effect so a late finisher
 * doesn't act on stale state. If it does finish, that's logged too.
 *
 * Pick `watchdogMs` well above the longest LEGITIMATE tick — releasing a slow
 * but healthy tick lets the next one overlap it.
 */

const _status = new Map();   // name → { running, startedAt, released, lastReleasedAt }

/** Every guard's state, for /api/health: a loop that keeps getting released is visible. */
export function tickGuardStatus() {
  return Object.fromEntries([..._status].map(([name, s]) => [name, { ...s }]));
}

// `onRelease(tick)` (optional) runs right after a release — e.g. to name what the
// stuck tick was working on. It can't block or break the release.
export function createTickGuard({ name, watchdogMs, log = console, now = Date.now, onRelease = null }) {
  if (!name) throw new Error('tick guard needs a name');
  if (!(Number.isFinite(watchdogMs) && watchdogMs > 0)) throw new Error(`tick guard ${name} needs a watchdogMs`);
  const st = { running: false, startedAt: null, released: 0, lastReleasedAt: null };
  _status.set(name, st);
  let current = null;   // { guarded, released: Promise }

  function run(fn) {
    if (current) return current.guarded;
    const ac = new AbortController();
    const startedAt = now();
    const tick = { signal: ac.signal, abandoned: false, startedAt };
    let timer = null;
    let releaseNow;
    const released = new Promise((resolve) => { releaseNow = resolve; });
    const work = Promise.resolve().then(() => fn(tick));
    timer = setTimeout(() => {
      tick.abandoned = true;
      ac.abort(new DOMException(`${name} tick exceeded its ${Math.round(watchdogMs / 1000)}s watchdog`, 'TimeoutError'));
      st.released += 1;
      st.lastReleasedAt = new Date(now()).toISOString();
      log.error(`[${name}] a tick has been running for ${Math.round((now() - startedAt) / 1000)}s — released so the loop keeps going (the stuck tick continues in the background, marked abandoned)`);
      if (typeof onRelease === 'function') {
        try { onRelease(tick); } catch (err) { log.warn(`[${name}] onRelease failed: ${err?.message ?? err}`); }
      }
      releaseNow();
      work.then(
        () => log.warn(`[${name}] an abandoned tick finally finished after ${Math.round((now() - startedAt) / 1000)}s`),
        (err) => log.warn(`[${name}] an abandoned tick finally failed after ${Math.round((now() - startedAt) / 1000)}s: ${err?.message ?? err}`),
      );
    }, watchdogMs);
    timer.unref?.();
    st.running = true;
    st.startedAt = new Date(startedAt).toISOString();
    const entry = {
      released,
      // Clear the watchdog whichever side wins — an uncleared timer holds the
      // event loop open (the ensureDescribed 25s test-hang lesson).
      guarded: Promise.race([work, released]).finally(() => {
        clearTimeout(timer);
        if (current === entry) { current = null; st.running = false; st.startedAt = null; }
      }),
    };
    current = entry;
    return entry.guarded;
  }

  return {
    run,
    busy: () => current !== null,
    /** For stop(): wait for the in-flight tick — but never past its watchdog. */
    async settle() {
      const c = current;
      if (c) { try { await c.guarded; } catch { /* the loop's own handler reported it */ } }
    },
  };
}
