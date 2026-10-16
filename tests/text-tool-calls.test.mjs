// A tool call written into a reply as text didn't run, and the next turn says so (0.14.86).
//
// From the self-rule inventory: early on, the Familiar's tool calls "went out as
// raw text twice" until its human noticed. Some models write the call out instead
// of making it; nothing runs and it reads like it did. The next turn's line now
// says so plainly, and the turn log records it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { findTextToolCalls, lastTurnRecord } = await import('../message-sanitize.mjs');
const { describeRound } = await import('../src/diagnostics/turn-log.js');

test('the shapes a written-out call takes are found, by name', () => {
  assert.deepEqual(findTextToolCalls('Saving that.\n<tool_call>{"name": "save_memory", "arguments": {"content": "x"}}</tool_call>'), ['save_memory']);
  assert.deepEqual(findTextToolCalls('{"name": "remove_from_identity", "arguments": {"passage": "y"}}'), ['remove_from_identity']);
  assert.deepEqual(findTextToolCalls('Done:\nsave_memory({"content": "x"})'), ['save_memory']);
  assert.deepEqual(findTextToolCalls('<function=recall>{"query": "tea"}</function>'), ['recall']);
  assert.deepEqual(findTextToolCalls('<tool_call>\n</tool_call>'), ['a tool']);
});

test('ordinary prose that mentions a tool is not a call', () => {
  for (const s of [
    "I'll use save_memory to keep that.",
    'I called save_memory (ok) and remove_from_identity.',
    'The tool is `save_memory`, it takes content.',
    'Her cat: {"name": "Luna", "age": 3}',
    'Something about functions and objects ({ braces })',
  ]) assert.deepEqual(findTextToolCalls(s), [], s);
});

const turn = (assistant) => [
  { role: 'user', content: 'remember tea' },
  ...assistant,
  { role: 'user', content: 'and?' },
];

test("the next turn's line says a written-out call didn't run", () => {
  assert.equal(
    lastTurnRecord(turn([{ role: 'assistant', content: 'On it.\n<tool_call>{"name": "save_memory", "arguments": {}}</tool_call>' }])),
    "[Last turn: no tools used. My reply had save_memory written out as text, which doesn't run it.]");
  // A real call of the same name ran: nothing to point out.
  const real = turn([
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', function: { name: 'save_memory' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
    { role: 'assistant', content: 'Saved — save_memory({"content":"tea"}) is what I ran.' },
  ]);
  assert.equal(lastTurnRecord(real), '[Last turn, tools used: save_memory (ok).]');
});

test('the turn log records it per round', () => {
  const r = describeRound({ round: 0, finishReason: 'stop', toolCalls: [], ran: false, content: '<tool_call>{"name": "recall", "arguments": {}}</tool_call>' });
  assert.deepEqual(r.textToolCalls, ['recall']);
  assert.ok(!('textToolCalls' in describeRound({ round: 0, finishReason: 'stop', toolCalls: [], ran: false, content: 'Just talking.' })));
});
