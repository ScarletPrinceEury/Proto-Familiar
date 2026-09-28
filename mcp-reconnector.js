/**
 * makeReconnector — the reconnect/backoff machinery shared by the two MCP
 * stdio peers (Phylactery, Unruh). Each peer owns one instance holding its
 * attempt counter and its single-in-flight mutex; everything peer-specific
 * (how to connect, how to tear the child down, whether a deliberate shutdown
 * is active) is injected, so the two peers run ONE correct implementation
 * instead of two near-identical copies.
 *
 * Why this exists as one thing: the Unruh copy was missing the in-flight
 * mutex the Phylactery copy had, so two rapid `reconnect()` calls (e.g. a
 * db restore racing a settings PUT) could each tear the child down and
 * respawn, orphaning a process. Sharing the implementation makes that class
 * of drift impossible.
 *
 * When `reconnect()`'s own connect fails, it arms a backoff retry — but only
 * AFTER releasing the in-flight mutex, so `schedule()`'s in-flight guard doesn't
 * swallow it. (The original called `schedule()` from inside the still-in-flight
 * promise, so the guard saw the mutex set and no retry ever fired; a failed
 * settings-change reconnect left the peer down until the next external trigger.
 * Ward-approved fix.)
 *
 * @param {object} o
 * @param {string}            o.name           peer name for log lines
 * @param {() => Promise<void>} o.connect       (re)establish the connection
 * @param {() => boolean}     o.isShuttingDown  true while a deliberate teardown/shutdown is active
 * @param {number}            o.maxAttempts
 * @param {number[]}          o.backoffMs       per-attempt delay ladder (last value repeats)
 * @param {typeof setTimeout} [o.setTimeoutFn]  injectable for tests
 * @param {Pick<Console,'log'|'error'>} [o.logger] injectable for tests
 */
export function makeReconnector({
  name,
  connect,
  isShuttingDown,
  maxAttempts,
  backoffMs,
  setTimeoutFn = setTimeout,
  logger = console,
}) {
  let attempts = 0;
  /** @type {Promise<void> | null} */
  let inFlight = null;

  // Reconnect with exponential backoff on an unexpected close. Capped so a
  // fundamentally-broken peer doesn't spin forever; the cap resets on every
  // successful connect, so transient crashes recover cleanly. No-ops while a
  // deliberate reconnect is already in flight (no need to double up) or while
  // shutting down (a pending timer that fires mid-shutdown must not respawn).
  function schedule() {
    if (isShuttingDown()) return;
    if (inFlight) return;
    if (attempts >= maxAttempts) {
      logger.error(`[thalamus] ${name} reconnect gave up after ${maxAttempts} attempts — restart Proto-Familiar to retry`);
      return;
    }
    const delay = backoffMs[Math.min(attempts, backoffMs.length - 1)];
    attempts += 1;
    logger.log(`[thalamus] Reconnecting to ${name} in ${delay}ms (attempt ${attempts}/${maxAttempts})`);
    // unref so a pending retry doesn't keep the process alive.
    setTimeoutFn(() => {
      connect().catch(err => {
        logger.error(`[thalamus] ${name} reconnect failed:`, err?.message ?? err);
        schedule();
      });
    }, delay)?.unref?.();
  }

  // Tear down the current child and respawn with a fresh env (so a settings
  // change to the designated connection takes effect immediately). A single
  // in-flight promise serialises concurrent callers so they can't orphan a
  // child. `teardown` closes the client and toggles the peer's shutting-down
  // flag around the close.
  async function reconnect(teardown) {
    if (inFlight) return inFlight;
    let failed = false;
    inFlight = (async () => {
      await teardown();
      try {
        await connect();
        attempts = 0;
      } catch (err) {
        logger.error(`[thalamus] ${name} reconnect failed:`, err?.message ?? err);
        failed = true;
      }
    })();
    try { await inFlight; }
    finally { inFlight = null; }
    // Mutex released — NOW a failed reconnect can arm a backoff retry (the guard
    // would have swallowed a schedule() call made while inFlight was still set).
    if (failed) schedule();
  }

  return {
    schedule,
    reconnect,
    resetAttempts() { attempts = 0; },
    // Test-only introspection — never used in production paths.
    _peek() { return { attempts, inFlight: inFlight !== null }; },
  };
}
