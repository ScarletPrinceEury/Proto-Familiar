// The shared MCP reconnect/backoff machine (mcp-reconnector.js). It exists to
// give Phylactery and Unruh ONE correct implementation — the Unruh copy used to
// lack the in-flight mutex, so two rapid reconnect() calls could each tear the
// child down and respawn, orphaning a process. The mutex + backoff-guard
// behaviour is pinned here (with injected timer + logger so nothing real spawns).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeReconnector } from '../mcp-reconnector.js';

const silent = { log() {}, error() {} };
// A fake setTimeout that records (cb, delay) instead of firing, and returns a
// handle with .unref() so the production `?.unref?.()` is exercised.
function fakeTimers() {
  const scheduled = [];
  const fn = (cb, delay) => { scheduled.push({ cb, delay }); return { unref() {} }; };
  return { fn, scheduled };
}

test('reconnect() serialises concurrent callers — teardown + connect run ONCE (the mutex)', async () => {
  let teardowns = 0, connects = 0;
  const r = makeReconnector({
    name: 'T', connect: () => { connects++; return Promise.resolve(); },
    isShuttingDown: () => false, maxAttempts: 10, backoffMs: [1], logger: silent,
  });
  const teardown = async () => { teardowns++; };
  // Two callers fire before the first resolves.
  const p1 = r.reconnect(teardown);
  const p2 = r.reconnect(teardown);
  await Promise.all([p1, p2]);
  assert.equal(teardowns, 1, 'teardown ran once, not twice');
  assert.equal(connects, 1, 'connect ran once, not twice');
});

test('reconnect() clears its mutex so a LATER reconnect runs again', async () => {
  let connects = 0;
  const r = makeReconnector({
    name: 'T', connect: () => { connects++; return Promise.resolve(); },
    isShuttingDown: () => false, maxAttempts: 10, backoffMs: [1], logger: silent,
  });
  await r.reconnect(async () => {});
  await r.reconnect(async () => {});
  assert.equal(connects, 2, 'each sequential reconnect connects');
  assert.equal(r._peek().inFlight, false, 'mutex released after completion');
});

test('reconnect() resets the attempt counter on a successful connect', async () => {
  const { fn, scheduled } = fakeTimers();
  const r = makeReconnector({
    name: 'T', connect: () => Promise.resolve(), isShuttingDown: () => false,
    maxAttempts: 5, backoffMs: [1, 2], setTimeoutFn: fn, logger: silent,
  });
  r.schedule(); r.schedule();               // bump attempts to 2
  assert.equal(r._peek().attempts, 2);
  await r.reconnect(async () => {});         // a clean reconnect
  assert.equal(r._peek().attempts, 0, 'success zeroes the backoff');
  assert.equal(scheduled.length, 2, 'reconnect success schedules no retry');
});

test('schedule() arms a timer with the backoff ladder and increments attempts', () => {
  const { fn, scheduled } = fakeTimers();
  const r = makeReconnector({
    name: 'T', connect: () => Promise.resolve(), isShuttingDown: () => false,
    maxAttempts: 5, backoffMs: [10, 20, 30], setTimeoutFn: fn, logger: silent,
  });
  r.schedule();
  r.schedule();
  assert.deepEqual(scheduled.map(s => s.delay), [10, 20], 'walks the ladder');
  assert.equal(r._peek().attempts, 2);
});

test('schedule() gives up at maxAttempts — no further timers', () => {
  const { fn, scheduled } = fakeTimers();
  const errs = [];
  const r = makeReconnector({
    name: 'T', connect: () => Promise.resolve(), isShuttingDown: () => false,
    maxAttempts: 2, backoffMs: [1], setTimeoutFn: fn, logger: { log() {}, error: (m) => errs.push(m) },
  });
  r.schedule(); r.schedule();               // attempts 1, 2 → two timers
  r.schedule();                             // attempts >= max → no timer, one error
  assert.equal(scheduled.length, 2);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /gave up after 2 attempts/);
});

test('schedule() no-ops while shutting down (a mid-shutdown timer must not respawn)', () => {
  const { fn, scheduled } = fakeTimers();
  let down = true;
  const r = makeReconnector({
    name: 'T', connect: () => Promise.resolve(), isShuttingDown: () => down,
    maxAttempts: 5, backoffMs: [1], setTimeoutFn: fn, logger: silent,
  });
  r.schedule();
  assert.equal(scheduled.length, 0, 'nothing armed while shutting down');
  down = false;
  r.schedule();
  assert.equal(scheduled.length, 1, 'arms once shutdown clears');
});

test('schedule() no-ops while a reconnect is in flight (inFlight guard)', async () => {
  const { fn, scheduled } = fakeTimers();
  let releaseConnect;
  const r = makeReconnector({
    name: 'T', connect: () => new Promise(res => { releaseConnect = res; }),
    isShuttingDown: () => false, maxAttempts: 5, backoffMs: [1], setTimeoutFn: fn, logger: silent,
  });
  const p = r.reconnect(async () => {});    // stays pending (connect not resolved)
  await Promise.resolve();                   // let the IIFE reach the connect await
  r.schedule();                              // should be blocked by the mutex
  assert.equal(scheduled.length, 0, 'no timer armed during an in-flight reconnect');
  releaseConnect();
  await p;
});

test('a scheduled timer, when it fires, calls connect', () => {
  const { fn, scheduled } = fakeTimers();
  let connects = 0;
  const r = makeReconnector({
    name: 'T', connect: () => { connects++; return Promise.resolve(); },
    isShuttingDown: () => false, maxAttempts: 5, backoffMs: [1], setTimeoutFn: fn, logger: silent,
  });
  r.schedule();
  assert.equal(connects, 0, 'not called until the timer fires');
  scheduled[0].cb();
  assert.equal(connects, 1, 'timer firing triggers the connect');
});
