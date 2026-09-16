// Memorization pipeline Pass A — the fixes from the 2026-09-16 failure audit:
//   A1  empty facts is a SUCCESS for a small slice, a failure for a big one
//   A2  an assistant-only slice gets a placeholder user turn (roles stay faithful)
//   A3  the consent-item `standing` is the fact's temporality boolean (was a crash)
//   A4  a noise-only slice (heartbeat/system markers) has no genuine turns
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFacts, buildExtractionMessages, genuineTurns, EMPTY_FACTS_MAX_READABLE,
  chunkMessagesBySize,
} from '../src/memory/memorization.js';

// ── A1: empty facts ─────────────────────────────────────────────────────────
test('parseFacts: valid empty facts + allowEmpty → [] (small slice = success)', () => {
  assert.deepEqual(parseFacts('{"facts": [], "relations": []}', null, { allowEmpty: true }), []);
});

test('parseFacts: valid empty facts + !allowEmpty → throws (big slice should yield facts)', () => {
  assert.throws(() => parseFacts('{"facts": []}', null, { allowEmpty: false }), /no facts/i);
});

test('parseFacts: a parsed object with NO facts array is always a failure (bad format)', () => {
  assert.throws(() => parseFacts('{"relations": []}', null, { allowEmpty: true }), /no facts/i);
});

test('parseFacts: real facts are returned regardless of allowEmpty', () => {
  const raw = '{"facts": [{"content": "my human likes tea"}]}';
  assert.equal(parseFacts(raw, null, { allowEmpty: false }).length, 1);
  assert.equal(parseFacts(raw, null, { allowEmpty: true }).length, 1);
});

test('EMPTY_FACTS_MAX_READABLE is the ward-set boundary (5)', () => {
  assert.equal(EMPTY_FACTS_MAX_READABLE, 5);
});

// ── A2: assistant-only slice → placeholder user turn, roles faithful ─────────
test('buildExtractionMessages: an assistant-only slice gets ONE placeholder user turn', () => {
  const msgs = [
    { role: 'assistant', content: 'thinking of you today' },
    { role: 'assistant', content: 'hope the appointment went ok' },
  ];
  const out = buildExtractionMessages({ instructions: 'INSTR', messages: msgs, wardLabel: 'Maus' });
  const users = out.filter(m => m.role === 'user');
  assert.equal(users.length, 1, 'exactly one placeholder user turn inserted');
  assert.equal(users[0].content, '[no reply from Maus]');
  // The Familiar's own lines stay assistant — never folded into a fake user turn.
  const assistants = out.filter(m => m.role === 'assistant');
  assert.deepEqual(assistants.map(m => m.content), ['thinking of you today', 'hope the appointment went ok']);
  // A user role is present → z.ai's zero-user-turn (1214) rejection can't arise.
  assert.ok(out.some(m => m.role === 'user'));
});

test('buildExtractionMessages: a slice that already has a user turn gets NO placeholder', () => {
  const msgs = [
    { role: 'user', content: 'hey' },
    { role: 'assistant', content: 'hi' },
  ];
  const out = buildExtractionMessages({ instructions: 'INSTR', messages: msgs, wardLabel: 'Maus' });
  assert.equal(out.filter(m => m.role === 'user').length, 1);
  assert.ok(!out.some(m => m.content === '[no reply from Maus]'));
});

// ── A4: the genuine-conversation notion ──────────────────────────────────────
test('genuineTurns: a heartbeat/marker-only slice has zero genuine turns', () => {
  const msgs = [
    { role: 'user', content: '[OpenClaw heartbeat poll]' },
    { role: 'user', content: '[OpenClaw heartbeat poll]' },
    { role: 'assistant', content: '[image failed to load]' },
  ];
  assert.equal(genuineTurns(msgs).length, 0);
});

test('genuineTurns: counts real turns, ignores interspersed markers and tool turns', () => {
  const msgs = [
    { role: 'user', content: '[OpenClaw heartbeat poll]' },
    { role: 'user', content: 'how are you?' },
    { role: 'assistant', content: 'I am well.' },
    { role: 'assistant', content: null, tool_calls: [{ id: '1', function: { name: 'f' } }] },
    { role: 'tool', tool_call_id: '1', content: 'result' },
  ];
  assert.equal(genuineTurns(msgs).length, 2, 'the two real turns; markers, tool-call carrier and tool result excluded');
});

// ── C: oversized-slice chunking ──────────────────────────────────────────────
test('chunkMessagesBySize: a slice that fits is one chunk (common path unchanged)', () => {
  const msgs = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  const chunks = chunkMessagesBySize(msgs, 64 * 1024);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], msgs);
});

test('chunkMessagesBySize: an oversized slice splits at turn boundaries, losing nothing', () => {
  // 20 turns of ~1 KB each → ~20 KB total; a 5 KB cap forces several chunks.
  const msgs = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(1000) + `#${i}` }));
  const chunks = chunkMessagesBySize(msgs, 5 * 1024);
  assert.ok(chunks.length > 1, 'split into multiple chunks');
  // Concatenation is exactly the input, in order — no turn dropped or split.
  assert.deepEqual(chunks.flat(), msgs);
  // Every chunk (except possibly a lone oversized turn) is under the cap.
  for (const c of chunks) {
    if (c.length === 1) continue;
    assert.ok(Buffer.byteLength(JSON.stringify(c), 'utf8') <= 5 * 1024 + 2);
  }
});

test('chunkMessagesBySize: a single turn larger than the cap becomes its own chunk (never split mid-turn)', () => {
  const msgs = [
    { role: 'user', content: 'small' },
    { role: 'assistant', content: 'y'.repeat(80 * 1024) },
    { role: 'user', content: 'small again' },
  ];
  const chunks = chunkMessagesBySize(msgs, 64 * 1024);
  assert.deepEqual(chunks.flat(), msgs, 'nothing lost');
  assert.ok(chunks.some(c => c.length === 1 && c[0].content.length === 80 * 1024), 'the huge turn is alone');
});
