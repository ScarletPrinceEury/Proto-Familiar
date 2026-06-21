import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initCerebellumTools, executeToolCall } from '../cerebellum.js';

// memorize_now lets the Familiar commit the current conversation through the
// real pipeline on demand (the rollover substitute). The executor reads the
// session id off the tool context and delegates to the injected
// memorizeSessionNow dep; these pin its branches and that it never throws.

const ctx = (over = {}) => ({
  sessionInfo: { sessionId: '11111111-1111-1111-1111-111111111111', provider: 'nanogpt', model: 'm' },
  apiKey: 'sk-test',
  audienceTag: 'ward-private',
  ...over,
});

test('no dep wired → degrades to a calm first-person line, never throws', async () => {
  // Runs before any injection, so the dep is still null.
  const out = await executeToolCall('memorize_now', '{}', ctx());
  assert.match(out, /memory pipeline|session settles/i);
});

test('missing session id → defers gracefully instead of erroring', async () => {
  let called = false;
  initCerebellumTools({ memorizeSessionNow: async () => { called = true; return { ok: true }; } });
  const out = await executeToolCall('memorize_now', '{}', ctx({ sessionInfo: { provider: 'x' } }));
  assert.equal(called, false, 'no session id → never calls the pipeline');
  assert.match(out, /which conversation/i);
});

test('success path passes session id + auth through and confirms', async () => {
  let seen = null;
  initCerebellumTools({ memorizeSessionNow: async (a) => { seen = a; return { ok: true, jobId: 'j1' }; } });
  const out = await executeToolCall('memorize_now', '{}', ctx());
  assert.equal(seen.sessionId, '11111111-1111-1111-1111-111111111111');
  assert.equal(seen.apiKey, 'sk-test');
  assert.equal(seen.audienceTag, 'ward-private');
  assert.match(out, /long-term memory|carries across/i);
});

test('already in-flight (deduped) reads as in-hand, not a second commit', async () => {
  initCerebellumTools({ memorizeSessionNow: async () => ({ ok: true, deduped: true }) });
  const out = await executeToolCall('memorize_now', '{}', ctx());
  assert.match(out, /already|in hand/i);
});

test('too-short conversation is reported softly', async () => {
  initCerebellumTools({ memorizeSessionNow: async () => ({ ok: false, error: 'too-short' }) });
  const out = await executeToolCall('memorize_now', '{}', ctx());
  assert.match(out, /enough here|keep it in mind/i);
});
