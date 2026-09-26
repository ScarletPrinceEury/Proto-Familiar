// voice-chat-turn.js — the shared /api/chat spoken turn (web Pass 2 + Discord 3b).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceChatTurn } from '../src/voice/voice-chat-turn.js';

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

test('extractContent: reads reasoning_content when content is empty (thinking model)', async () => {
  const run = createVoiceChatTurn(deps(okFetch({ content: '', reasoning_content: 'thought-through answer' })));
  assert.equal(await run({ transcript: 'hi' }), 'thought-through answer');
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

test('HTTP error → null; empty reply → null', async () => {
  const errFetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
  assert.equal(await createVoiceChatTurn(deps(errFetch))({ transcript: 'hi' }), null);
  assert.equal(await createVoiceChatTurn(deps(okFetch({ content: '' })))({ transcript: 'hi' }), null);
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
