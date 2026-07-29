/**
 * The Phylactery child must not be killable by a client-side timeout.
 *
 * ── What happened ───────────────────────────────────────────────────────
 * Phylactery died repeatedly at boot with a forty-line anyio traceback ending
 * in `BrokenResourceError`. Every link in the chain looked harmless:
 *
 *   1. `backfillContentTags()` fires at boot and took 12,295 ms on real data
 *      — it scales with how much my human has told me.
 *   2. The village canonical pull fires at the same moment, calling
 *      `identity_get_all` with the MCP SDK's `timeout` option set to 8,000 ms.
 *   3. Phylactery is busy, so the pull loses. The SDK's timeout handler does
 *      NOT merely give up locally — it calls `cancel()`, which SENDS
 *      `notifications/cancelled` to the child.
 *   4. Python's receive loop answers that with `RequestResponder.cancel()` →
 *      `self._cancel_scope.cancel()`, cancelling a scope entered by a
 *      DIFFERENT task. That takes the session down.
 *   5. The dying session closes its read stream while `stdio_server`'s
 *      `stdin_reader` is blocked in `send()` on a zero-capacity stream, so it
 *      raises `BrokenResourceError` — which it does not catch. The child dies.
 *
 * It got worse over time because step 1 grows with the memory count. That is
 * a horrible property for a crash to have, and it is why this test asserts the
 * RULE rather than the timing: no amount of slowness may hand anything the
 * power to cancel a request on that child.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => fs.readFile(path.join(ROOT, f), 'utf8');

test('no Phylactery call may pass the SDK timeout option — it cancels, and cancelling kills the child', async () => {
  const thal = await read('thalamus.js');

  // The guard must be in callTool itself, not a convention somebody remembers.
  assert.match(thal, /if \(opts\.timeout\)/, 'callTool does not refuse a hard timeout');
  assert.match(thal, /kills the Phylactery child/, 'the refusal does not say why, so it will be removed by someone helpful');

  // And the option must not be forwarded under any name.
  assert.doesNotMatch(
    thal,
    /callTool\([^)]*\{\s*timeout\s*:/,
    'a caller is still passing a hard timeout into callTool',
  );
});

test('the village boot pull gives up locally instead of cancelling', async () => {
  const srv = await read('server.js');
  const thal = await read('thalamus.js');

  // This is the exact call site that was doing it.
  assert.match(srv, /getIdentityAll\(\{ softTimeout: VILLAGE_PULL_TIMEOUT_MS \}\)/,
    'the village pull is back on a cancelling timeout');
  assert.doesNotMatch(srv, /getIdentityAll\(\{ timeout:/, 'the hard timeout returned');

  // Fail-fast is still a real behaviour — this must not have been "fixed" by
  // simply waiting forever, which would hang boot behind a slow child.
  assert.match(srv, /VILLAGE_PULL_TIMEOUT_MS = 8_000/);
  assert.match(thal, /softTimeout/, 'callTool lost its soft give-up');
});

test('a soft give-up abandons the wait without touching the request', async () => {
  // The behavioural half: Promise.race semantics, proven rather than asserted
  // about. A hard timeout would have to reach the transport; this may not.
  let cancelled = false;
  const slowCall = new Promise((resolve) => setTimeout(() => resolve('late answer'), 60));
  slowCall.cancel = () => { cancelled = true; };

  let timer = null;
  let raced;
  try {
    raced = await Promise.race([
      slowCall,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('gave up')), 10);
        timer.unref?.();
      }),
    ]).catch((e) => e);
  } finally {
    if (timer) clearTimeout(timer);
    slowCall.catch?.(() => {});
  }

  assert.ok(raced instanceof Error, 'the caller should have given up');
  assert.match(raced.message, /gave up/);
  assert.equal(cancelled, false, 'giving up locally must not cancel anything remote');

  // And the abandoned call still settles harmlessly rather than becoming an
  // unhandled rejection that takes the process down later.
  assert.equal(await slowCall, 'late answer');
});

test('the race timer is cleared — an uncleared one leaks the event loop', async () => {
  const thal = await read('thalamus.js');
  const callTool = thal.slice(thal.indexOf('async function callTool'));
  const body = callTool.slice(0, callTool.indexOf('\n}\n'));
  assert.match(body, /clearTimeout\(timer\)/, 'the soft-timeout timer is never cleared');
  assert.match(body, /finally/, 'the clear must happen on the winning branch too');
  // The same leak showed up in the voice describe race as a mystery 25s hang
  // in the test suite; it is cheap to assert and expensive to rediscover.
});

test('boot maintenance is deferred and serialised, not fired all at once', async () => {
  const srv = await read('server.js');

  assert.match(srv, /async function runPhylacteryMaintenance\(\)/,
    'the heavy backfills are loose in the boot path again');
  assert.match(srv, /MAINTENANCE_DELAY_MS/, 'maintenance no longer waits for the boot rush to pass');

  // Serialised: each step awaited inside the one runner, rather than three
  // fire-and-forget .then() chains racing each other on one sqlite file.
  const runner = srv.slice(
    srv.indexOf('async function runPhylacteryMaintenance()'),
    srv.indexOf('const httpServer = app.listen'),
  );
  for (const step of ['getMemoryHealth', 'backfillContentTags', 'remapCategoryAudiences']) {
    assert.ok(runner.includes(`await ${step}(`) || runner.includes(`await ${step}(`),
      `${step} is not awaited inside the serialised runner`);
  }
  // Never throws: every caller of this is fire-and-forget.
  assert.match(runner, /catch \{ \/\* retries next boot \*\/ \}/);

  // An unreachable child must SAY so. getMemoryHealth catches its own errors
  // and returns {ok:false, healthy:null}, so a try/catch around it can never
  // fire — the first version of this check was written that way and was dead
  // code. The condition has to read the result.
  assert.match(runner, /health\.ok === false \|\| health\.healthy === null/,
    'an unreachable Phylactery would make maintenance silently do nothing');
  assert.match(runner, /maintenance pass skipped/);
});

test('Phylactery survives the SDK teardown race instead of printing a wall of red', async () => {
  const py = await read('phylactery/src/phylactery/server.py');

  assert.match(py, /except BaseExceptionGroup as eg/, 'the group is no longer caught');
  assert.match(py, /BrokenResourceError/, 'the specific race is not recognised');
  // Crucially it must NOT swallow everything — a real bug hiding in the group
  // has to still surface.
  assert.match(py, /if rest:\s*\n\s*raise/, 'a real error alongside the race would be swallowed');
  assert.match(py, /_flatten_group/, 'nested groups would slip past a shallow check');
});
