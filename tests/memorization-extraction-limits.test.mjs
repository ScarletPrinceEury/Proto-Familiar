// The ward-tunable extraction timeout + token budget (memory extraction was
// stuck at a hardcoded 120s / 8000; now it honours the "Memory summary" settings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExtractionLimits } from '../src/memory/memorization.js';

test('unset settings → built-in defaults (120s / 8000)', () => {
  assert.deepEqual(resolveExtractionLimits({}), { timeoutMs: 120_000, maxTokens: 8000 });
  assert.deepEqual(resolveExtractionLimits(), { timeoutMs: 120_000, maxTokens: 8000 });
  assert.deepEqual(resolveExtractionLimits({ phylacteryLlmTimeoutS: null, phylacteryLlmMaxTokens: null }),
    { timeoutMs: 120_000, maxTokens: 8000 });
});

test('valid ward values are honoured (seconds → ms)', () => {
  const r = resolveExtractionLimits({ phylacteryLlmTimeoutS: 300, phylacteryLlmMaxTokens: 12000 });
  assert.equal(r.timeoutMs, 300_000, 'a slow/thinking model can be given more room');
  assert.equal(r.maxTokens, 12000);
});

test('out-of-range values fall back to the defaults (never a broken too-small limit)', () => {
  assert.deepEqual(resolveExtractionLimits({ phylacteryLlmTimeoutS: 5, phylacteryLlmMaxTokens: 100 }),
    { timeoutMs: 120_000, maxTokens: 8000 });
  assert.deepEqual(resolveExtractionLimits({ phylacteryLlmTimeoutS: 'nope', phylacteryLlmMaxTokens: -1 }),
    { timeoutMs: 120_000, maxTokens: 8000 });
});
