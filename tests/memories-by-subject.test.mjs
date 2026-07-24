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
// Env setup MUST happen before importing thalamus.js:
//   - PROTO_FAMILIAR_PHYLACTERY_DISABLED=1 short-circuits connectPhylactery()
//     before it ever touches `uv` (see the module's off-switch check).
//   - UV_BIN is pointed at /bin/false. Phylactery's own venv/pyproject exist
//     in this checkout, but so do Unruh's — and startThalamus() always
//     attempts connectUnruh() too (it has no disable env var of its own).
//     Unruh's pre-checks (source + venv present) pass in this repo, so
//     without this override the test would actually spawn a real `uv run
//     python -m unruh` child process. Pointing UV_BIN at /bin/false (which
//     exists on this box and exits immediately) makes that spawn fail fast:
//     the child process closes almost instantly, the MCP SDK's transport
//     `onclose` rejects the in-flight `initialize` request right away
//     (see @modelcontextprotocol/sdk's Protocol._onclose), and
//     connectUnruh()'s own .catch() swallows the failure — startThalamus()
//     settles in well under a second instead of hanging on a live
//     subprocess or the SDK's 60s default request timeout.
process.env.PROTO_FAMILIAR_PHYLACTERY_DISABLED = '1';
process.env.UV_BIN = '/bin/false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMemoriesBySubject } from '../thalamus.js';

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
