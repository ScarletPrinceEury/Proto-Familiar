// collapseToolTurns — tool-call scaffolding is turn-internal, not conversational
// history. The bug it fixes: a null/mid-sentence carrier turn re-injected as
// history read to the Familiar as its own past turn being "null" or cut off
// mid-sentence, on both web and Discord (a null carrier renders "[HH:MM] null"
// once a machine timestamp is prepended), though my human received the reply whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseToolTurns, stripLlmTimestamps } from '../message-sanitize.mjs';

const roles = (out) => out.map(m => m.role);
const contents = (out) => out.map(m => m.content);

test('a null carrier + tool result + final → one clean assistant turn (no null)', () => {
  const out = collapseToolTurns([
    { role: 'user', content: 'weather?' },
    { role: 'assistant', content: null, tool_calls: [{ id: '1', function: { name: 'weather' } }] },
    { role: 'tool', tool_call_id: '1', content: '18C sunny' },
    { role: 'assistant', content: 'It is 18C and sunny.' },
  ]);
  assert.deepEqual(roles(out), ['user', 'assistant']);
  assert.deepEqual(contents(out), ['weather?', 'It is 18C and sunny.']);
  assert.ok(!out.some(m => 'tool_calls' in m), 'tool_calls stripped from history');
  assert.ok(!out.some(m => m.content === null), 'no null content survives');
});

test('a mid-sentence preamble carrier merges with the reply it preceded', () => {
  const out = collapseToolTurns([
    { role: 'user', content: 'look up X' },
    { role: 'assistant', content: 'Sure, let me check that—', tool_calls: [{ id: '2', function: { name: 'look_up' } }] },
    { role: 'tool', tool_call_id: '2', content: 'X = 42' },
    { role: 'assistant', content: 'X is 42.' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[1].role, 'assistant');
  assert.equal(out[1].content, 'Sure, let me check that—\n\nX is 42.', 'both halves of the reply survive as one turn');
});

test('multiple tool rounds in one turn collapse into a single assistant turn', () => {
  const out = collapseToolTurns([
    { role: 'user', content: 'do a lot' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', function: { name: 't1' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'r1' },
    { role: 'assistant', content: 'partway,', tool_calls: [{ id: 'b', function: { name: 't2' } }] },
    { role: 'tool', tool_call_id: 'b', content: 'r2' },
    { role: 'assistant', content: 'all done.' },
  ]);
  assert.deepEqual(roles(out), ['user', 'assistant']);
  assert.equal(out[1].content, 'partway,\n\nall done.');
});

test('role:tool result messages never survive into history', () => {
  const out = collapseToolTurns([
    { role: 'assistant', content: 'x', tool_calls: [{ id: '1', function: { name: 'f' } }] },
    { role: 'tool', tool_call_id: '1', content: 'secret tool output' },
    { role: 'assistant', content: 'done' },
  ]);
  assert.ok(!out.some(m => m.role === 'tool'));
  assert.ok(!contents(out).some(c => String(c).includes('secret tool output')));
});

test('two independent assistant messages (banners) are NEVER merged', () => {
  const out = collapseToolTurns([
    { role: 'assistant', content: 'proactive banner' },
    { role: 'assistant', content: 'a real reply' },
  ]);
  assert.deepEqual(contents(out), ['proactive banner', 'a real reply']);
});

test('normal alternating chat is byte-identical (regression pin)', () => {
  const input = [
    { role: 'user', content: 'hi', id: 'u1', timestamp: 't1' },
    { role: 'assistant', content: 'hello', id: 'a1', timestamp: 't2' },
    { role: 'user', content: 'bye', id: 'u2', timestamp: 't3' },
    { role: 'assistant', content: 'see you', id: 'a2', timestamp: 't4' },
  ];
  assert.deepEqual(collapseToolTurns(input), input);
});

test('a carrier that never got closing text keeps its (honest) partial content', () => {
  const out = collapseToolTurns([
    { role: 'user', content: 'do X' },
    { role: 'assistant', content: 'Working on it—', tool_calls: [{ id: '3', function: { name: 't' } }] },
    { role: 'tool', tool_call_id: '3', content: 'done' },
  ]);
  assert.deepEqual(contents(out), ['do X', 'Working on it—'], 'no closing text → the partial is what my human saw; kept, not invented');
});

test('a fully-empty tool turn (null carrier, no closing text) drops entirely, no null turn', () => {
  const out = collapseToolTurns([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: null, tool_calls: [{ id: '4', function: { name: 't' } }] },
    { role: 'tool', tool_call_id: '4', content: 'r' },
  ]);
  assert.deepEqual(roles(out), ['user'], 'an empty assistant turn is dropped, never re-injected as null');
});

test('preserves user-turn fields (speaker, attachments) and vision-array assistant text', () => {
  const out = collapseToolTurns([
    { role: 'user', content: 'see this', speaker: 'Alice', attachments: [{ id: 'img1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'I see a cat' }, { type: 'image_url' }] },
  ]);
  assert.equal(out[0].speaker, 'Alice');
  assert.deepEqual(out[0].attachments, [{ id: 'img1' }]);
  assert.equal(out[1].content, 'I see a cat');
});

test('non-array / garbage input never throws', () => {
  assert.equal(collapseToolTurns(null), null);          // non-array passthrough
  assert.deepEqual(collapseToolTurns(undefined), []);   // default param → empty history
  assert.deepEqual(collapseToolTurns([]), []);
  assert.deepEqual(collapseToolTurns(['junk', 5, null]), ['junk', 5, null]);
});

// The Discord symptom specifically: a machine timestamp prepended to a null
// carrier's content produced the literal string "[HH:MM] null". After collapse
// there is no null carrier to prepend to.
test('the "[HH:MM] null" Discord render can no longer arise from a carrier', () => {
  const collapsed = collapseToolTurns([
    { role: 'user', content: 'hi', timestamp: '2026-09-16T10:00:00Z' },
    { role: 'assistant', content: null, tool_calls: [{ id: '1', function: { name: 'f' } }], timestamp: '2026-09-16T10:00:01Z' },
    { role: 'tool', tool_call_id: '1', content: 'r' },
    { role: 'assistant', content: 'the answer', timestamp: '2026-09-16T10:00:02Z' },
  ]);
  // Mirror discord-gateway's history .map: prepend a machine time to content.
  const rendered = collapsed
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `${m.role}: ${m.timestamp ? `[10:00] ${stripLlmTimestamps(m.content)}` : stripLlmTimestamps(m.content)}`);
  assert.ok(!rendered.some(line => /\bnull\b/.test(line)), 'no "[10:00] null" line');
  assert.deepEqual(rendered, ['user: [10:00] hi', 'assistant: [10:00] the answer']);
});
