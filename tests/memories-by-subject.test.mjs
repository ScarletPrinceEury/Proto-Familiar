// Regression guard for getMemoriesBySubject (thalamus.js).
//
// The villager `!consent` menu backs "what does my Familiar hold about me"
// on getMemoriesBySubject({ villagerId }). Its "MCP not connected" guard
// used to read `if (!phylacteryClient)` — a variable that is NOT declared
// anywhere in thalamus.js (the module's client is `mcpClient`). Because
// thalamus.js is an ES module (strict mode), evaluating that undeclared
// name threw `ReferenceError: phylacteryClient is not defined` on EVERY
// call, including with no Phylactery connection at all. The caller in
// discord-gateway.js swallows the rejection with `.catch(() => ({ items:
// [] }))`, so the bug was invisible end-to-end: the villager consent menu
// silently always showed zero kept memories, forever. The fix reads
// `mcpClient` in the guard, so with no client connected the function
// resolves gracefully to `{ ok: false, items: [] }` instead of throwing.
//
// The regression this test pins: with the MCP peers disabled/unreachable,
// getMemoriesBySubject() must RESOLVE to the degraded shape — never
// reject/throw.
//
// Env setup MUST happen before importing thalamus.js: both MCP peers are
// switched off, so startThalamus() returns without spawning anything.
// PROTO_FAMILIAR_PHYLACTERY_DISABLED / PROTO_FAMILIAR_UNRUH_DISABLED
// short-circuit connectPhylactery() / connectUnruh() before either touches
// `uv`. (This test used to point UV_BIN at /bin/false instead. That path
// doesn't exist on Windows, so resolveUv() fell back to the real uv, spawned a
// live `uv run python -m unruh`, and `npm test` sat there until someone killed
// the child by hand.)
process.env.PROTO_FAMILIAR_PHYLACTERY_DISABLED = '1';
process.env.PROTO_FAMILIAR_UNRUH_DISABLED = '1';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  getMemoriesBySubject, startThalamus, probeOrgans,
  shutdownUnruh, shutdownPhylactery,
} from '../thalamus.js';

// If an off-switch ever stops working, a real child may be running by now.
// Close it so the regression shows up as the failed assertion below, not as a
// suite that never exits.
after(() => {
  shutdownUnruh();
  shutdownPhylactery();
});

test('with both off-switches set, thalamus starts no Phylactery or Unruh child', async () => {
  await startThalamus();
  const organs = await probeOrgans();
  assert.equal(organs.unruh, false, 'Unruh connected despite PROTO_FAMILIAR_UNRUH_DISABLED=1');
  assert.equal(organs.phylactery, false, 'Phylactery connected despite PROTO_FAMILIAR_PHYLACTERY_DISABLED=1');
});

test('getMemoriesBySubject degrades to { ok: false, items: [] } instead of throwing when Phylactery is unreachable', async () => {
  let r;
  try {
    r = await getMemoriesBySubject({ villagerId: 'v-test' });
  } catch (err) {
    assert.fail(
      'getMemoriesBySubject rejected instead of degrading gracefully — the ' +
      'phylacteryClient ReferenceError regression is back ' +
      `(threw: ${err?.constructor?.name ?? typeof err}: ${err?.message ?? err})`,
    );
  }
  assert.deepEqual(r, { ok: false, items: [] });
});

test('getMemoriesBySubject is a function, and an empty/omitted arg still resolves gracefully', async () => {
  assert.equal(typeof getMemoriesBySubject, 'function');

  let r;
  try {
    r = await getMemoriesBySubject({});
  } catch (err) {
    assert.fail(
      'getMemoriesBySubject({}) rejected instead of degrading gracefully — the ' +
      'phylacteryClient ReferenceError regression is back ' +
      `(threw: ${err?.constructor?.name ?? typeof err}: ${err?.message ?? err})`,
    );
  }
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.items) && r.items.length === 0);
});
