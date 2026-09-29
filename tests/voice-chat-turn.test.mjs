// voice-chat-turn.js — the shared /api/chat spoken turn (web Pass 2 + Discord 3b).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceChatTurn, voiceHttpRetryPlan } from '../src/voice/voice-chat-turn.js';

const conn = { provider: 'p', apiKey: 'k', model: 'm' };
const deps = (fetchFn, over = {}) => ({
  port: 1234,
  readSettings: () => ({}),
  connectionForFeature: () => conn,
  log: () => {},
  fetchFn,
  ...over,
});

function okFetch(message) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) }; };
  fn.calls = calls;
  return fn;
}

test('posts with the RULE-A guarantees + passes sessionAudience through', async () => {
  const fetchFn = okFetch({ content: 'hey' });
  const run = createVoiceChatTurn(deps(fetchFn));
  const reply = await run({ transcript: 'hi', history: [{ role: 'user', content: 'earlier' }], sessionAudience: 'ward-private' });
  assert.equal(reply, 'hey');
  const body = fetchFn.calls[0].body;
  assert.equal(body.max_tokens, 4000, 'generous cap (thinking models bill reasoning)');
  assert.equal(body.runToolLoop, true, 'tools on a call by default');
  assert.equal(body.enrich, true);
  assert.equal(body.voiceMode, true);
  assert.equal(body.injectCorePrompts, true, 'no browser here — the server must fold in the four core prompts');
  assert.equal(body.sessionAudience, 'ward-private', 'audience passed through, not invented');
  // history + the new user turn are both sent, in order
  assert.deepEqual(body.messages.map(m => m.content), ['earlier', 'hi']);
});

test('reads reasoning_content when a FINISHED answer is parked there (no length-truncation)', async () => {
  // A proxy that legitimately puts a completed answer in reasoning_content
  // (finish_reason is not 'length') — recover it as the reply.
  const run = createVoiceChatTurn(deps(okFetch({ content: '', reasoning_content: 'thought-through answer' })));
  assert.equal(await run({ transcript: 'hi' }), 'thought-through answer');
});

// A fetch stub that plays a queued list of choices, one per call, tracking the
// max_tokens each request carried. The last entry repeats once the queue drains.
function seqFetch(choices) {
  const calls = [];
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ maxTokens: body.max_tokens });
    const choice = choices[Math.min(calls.length - 1, choices.length - 1)];
    return { ok: true, status: 200, json: async () => ({ choices: [choice] }) };
  };
  fn.calls = calls;
  return fn;
}

test('a length-truncated empty is SILENCE, never a spoken CoT dump — and retries with a bigger cap', async () => {
  // An always-thinking model that spent its whole budget reasoning: finish_reason
  // 'length', empty content, raw chain-of-thought parked in reasoning_content.
  // Speaking that aloud is the GLM-5.3 "thinking dump" — the reply must never be
  // the CoT. When BOTH attempts exhaust the budget, the turn goes quiet (null).
  const lengthEmpty = { finish_reason: 'length', message: { content: '', reasoning_content: 'let me think… they asked… I should…' } };
  const fetchFn = seqFetch([lengthEmpty, lengthEmpty]);
  const run = createVoiceChatTurn(deps(fetchFn));
  assert.equal(await run({ transcript: 'hi' }), null, 'never speaks the raw CoT');
  assert.equal(fetchFn.calls.length, 2, 'one bounded retry');
  assert.equal(fetchFn.calls[0].maxTokens, 4000, 'first attempt at the base cap');
  assert.equal(fetchFn.calls[1].maxTokens, 8000, 'length-truncation retry gets more room to finish');
});

test('an empty first turn is rescued by the retry (spoken reply, not silence)', async () => {
  // First attempt hits the budget (length, empty); the retry — with the larger
  // cap — actually finishes and returns a real answer. The turn speaks it.
  const fetchFn = seqFetch([
    { finish_reason: 'length', message: { content: '', reasoning_content: 'thinking…' } },
    { finish_reason: 'stop',   message: { content: 'Tuesday at 3.' } },
  ]);
  const run = createVoiceChatTurn(deps(fetchFn));
  assert.equal(await run({ transcript: 'when is my dentist?' }), 'Tuesday at 3.');
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(fetchFn.calls[1].maxTokens, 8000);
});

test('empty transcript → null, no fetch', async () => {
  const fetchFn = okFetch({ content: 'x' });
  const run = createVoiceChatTurn(deps(fetchFn));
  assert.equal(await run({ transcript: '   ' }), null);
  assert.equal(fetchFn.calls.length, 0);
});

test('no usable connection → null', async () => {
  const run = createVoiceChatTurn(deps(okFetch({ content: 'x' }), { connectionForFeature: () => null }));
  assert.equal(await run({ transcript: 'hi' }), null);
});

test('a deterministic 4xx → null, NOT retried (an identical retry fails identically)', async () => {
  const calls = [];
  const errFetch = async () => { calls.push(1); return { ok: false, status: 400, json: async () => ({ error: 'bad request' }) }; };
  assert.equal(await createVoiceChatTurn(deps(errFetch))({ transcript: 'hi' }), null);
  assert.equal(calls.length, 1, '400 is deterministic — one attempt only');
});

test('empty reply → null', async () => {
  assert.equal(await createVoiceChatTurn(deps(okFetch({ content: '' })))({ transcript: 'hi' }), null);
});

// A fetch stub that plays queued HTTP responses (status + optional retry-after
// header), one per call, tracking how many times it was hit.
function seqHttp(responses) {
  const calls = [];
  const fn = async () => {
    const r = responses[Math.min(calls.length, responses.length - 1)];
    calls.push(r.status ?? 200);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? (r.retryAfter ?? null) : null) },
      json: async () => (r.body ?? { choices: [{ finish_reason: 'stop', message: { content: r.reply ?? '' } }] }),
    };
  };
  fn.calls = calls;
  return fn;
}
const noSleep = { sleep: () => Promise.resolve() };

test('voiceHttpRetryPlan: transient errors retry, deterministic and quota ones do not', () => {
  // 5xx / 408 → retry after a short default when no Retry-After.
  assert.deepEqual(voiceHttpRetryPlan(503, null), { retry: true, delayMs: 800 });
  assert.deepEqual(voiceHttpRetryPlan(500, null), { retry: true, delayMs: 800 });
  assert.deepEqual(voiceHttpRetryPlan(408, null), { retry: true, delayMs: 800 });
  // 5xx with a Retry-After we can afford → honor it; too-long → drop the turn.
  assert.deepEqual(voiceHttpRetryPlan(503, '2'), { retry: true, delayMs: 2000 });
  assert.equal(voiceHttpRetryPlan(503, '30').retry, false, 'a 30s wait is "not now" mid-call');
  // 429: retry ONLY with a short Retry-After (transient rate/concurrency);
  // a bare 429 (quota) or a long one is left alone.
  assert.deepEqual(voiceHttpRetryPlan(429, '1'), { retry: true, delayMs: 1000 });
  assert.equal(voiceHttpRetryPlan(429, null).retry, false, 'a bare 429 reads as quota — no retry');
  assert.equal(voiceHttpRetryPlan(429, '120').retry, false, 'a 2-minute 429 is quota — no retry');
  // other 4xx → never.
  assert.equal(voiceHttpRetryPlan(400, null).retry, false);
  assert.equal(voiceHttpRetryPlan(401, '1').retry, false);
});

test('a transient 503 is retried and the retry speaks the answer', async () => {
  const fetchFn = seqHttp([{ status: 503 }, { reply: 'back now' }]);
  const run = createVoiceChatTurn(deps(fetchFn, noSleep));
  assert.equal(await run({ transcript: 'hi' }), 'back now');
  assert.equal(fetchFn.calls.length, 2);
});

test('a quota 429 (no Retry-After) is NOT retried — the call resets fast', async () => {
  const fetchFn = seqHttp([{ status: 429 }]);
  const run = createVoiceChatTurn(deps(fetchFn, noSleep));
  assert.equal(await run({ transcript: 'hi' }), null);
  assert.equal(fetchFn.calls.length, 1, 'no wasted retry on quota exhaustion');
});

test('a concurrency 429 (short Retry-After) IS retried', async () => {
  const fetchFn = seqHttp([{ status: 429, retryAfter: '1' }, { reply: 'ok now' }]);
  const run = createVoiceChatTurn(deps(fetchFn, noSleep));
  assert.equal(await run({ transcript: 'hi' }), 'ok now');
  assert.equal(fetchFn.calls.length, 2);
});

test('sessionAudience defaults to ward-private when omitted', async () => {
  const fetchFn = okFetch({ content: 'ok' });
  await createVoiceChatTurn(deps(fetchFn))({ transcript: 'hi' });
  assert.equal(fetchFn.calls[0].body.sessionAudience, 'ward-private');
});

// ── tools on a call (Pass 1) ──────────────────────────────────────────────────
test('tools on: speaks the model preamble from _toolRounds, THEN the answer', async () => {
  const fn = async () => ({ ok: true, status: 200, json: async () => ({
    choices: [{ message: { content: 'Your dentist is Tuesday at 3.' } }],
    _toolRounds: [{ content: 'Let me check your calendar—', toolCalls: [{}], results: [] }],
  }) });
  const reply = await createVoiceChatTurn(deps(fn))({ transcript: 'when is my dentist?' });
  assert.equal(reply, 'Let me check your calendar— Your dentist is Tuesday at 3.');
});

test('a no-tool turn is unchanged: just the answer (no _toolRounds → no preamble)', async () => {
  const reply = await createVoiceChatTurn(deps(okFetch({ content: 'Hey?' })))({ transcript: 'Eury?' });
  assert.equal(reply, 'Hey?');
});

test('voiceCallToolsEnabled:false → runToolLoop false (fast no-tool reply)', async () => {
  const fetchFn = okFetch({ content: 'hey' });
  await createVoiceChatTurn(deps(fetchFn, { readSettings: () => ({ voiceCallToolsEnabled: false }) }))({ transcript: 'hi' });
  assert.equal(fetchFn.calls[0].body.runToolLoop, false);
});

test('PROTO_FAMILIAR_VOICE_CALL_TOOLS_DISABLED=1 overrides the setting → runToolLoop false', async () => {
  process.env.PROTO_FAMILIAR_VOICE_CALL_TOOLS_DISABLED = '1';
  try {
    const fetchFn = okFetch({ content: 'hey' });
    await createVoiceChatTurn(deps(fetchFn, { readSettings: () => ({ voiceCallToolsEnabled: true }) }))({ transcript: 'hi' });
    assert.equal(fetchFn.calls[0].body.runToolLoop, false);
  } finally {
    delete process.env.PROTO_FAMILIAR_VOICE_CALL_TOOLS_DISABLED;
  }
});
