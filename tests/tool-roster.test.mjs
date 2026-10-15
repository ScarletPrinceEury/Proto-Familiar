// Tool roster at depth + per-turn tool diagnostics (0.14.74).
//
// Providers put the tools schema at the top of a growing context; deep into a
// long session the Familiar lost track of what it had and narrated calls that
// never ran. The roster rides the time anchor at the END of the context every
// round. Separately, the loops only run calls when a round ends with
// finish_reason 'tool_calls' — a round that carries calls with any other finish
// reason is treated as the answer and its calls never run. The turn log records
// that as `dropped`, so the next phantom can be told apart from a real drop.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatToolRoster, anchorWithToolRoster } = await import('../tool-surfacing.js');
const { describeRound, toolNames } = await import('../src/diagnostics/turn-log.js');
const { runToolCallLoop } = await import('../cerebellum.js');

const tool = (name) => ({ type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } } });
const TOOLS = [tool('recall'), tool('save_memory'), tool('update_identity'), tool('find_graph_node'), tool('my_custom_thing')];

test('the roster names this round\'s tools by group, what else I can pull in, and the one rule', () => {
  const r = formatToolRoster(TOOLS);
  assert.match(r, /^\[Tools I can call right now \(core: recall, save_memory, update_identity; graph: find_graph_node; my own: my_custom_thing\)\./);
  assert.match(r, /More I can pull in with request_tools: .*memory-edit/);
  assert.doesNotMatch(r, /request_tools: [^.]*graph/, 'a group I already have is not offered again');
  assert.match(r, /A tool only runs when I actually call it\. If I don't see its result in this turn, it didn't run\.\]$/);
});

test('no tools (a closing text round) means no roster, and the anchor is just the clock', () => {
  assert.equal(formatToolRoster([]), '');
  assert.equal(anchorWithToolRoster('[Now: 13:20]', []), '[Now: 13:20]');
  assert.match(anchorWithToolRoster('[Now: 13:20]', TOOLS), /^\[Now: 13:20\]\n\n\[Tools I can call right now/);
});

test('the roster has a hard off-switch', () => {
  process.env.PROTO_FAMILIAR_TOOL_ROSTER_DISABLED = '1';
  try { assert.equal(formatToolRoster(TOOLS), ''); }
  finally { delete process.env.PROTO_FAMILIAR_TOOL_ROSTER_DISABLED; }
});

test('a round that carries calls without finish_reason tool_calls is recorded as dropped', () => {
  const calls = [{ function: { name: 'remove_from_identity' } }];
  assert.deepEqual(describeRound({ round: 0, finishReason: 'stop', toolCalls: calls, ran: false, content: 'Done.' }),
    { round: 0, finishReason: 'stop', calls: ['remove_from_identity'], ran: false, dropped: true, contentChars: 5, reasoningChars: 0 });
  assert.equal(describeRound({ round: 1, finishReason: 'tool_calls', toolCalls: calls, ran: true }).dropped, false);
  assert.equal(describeRound({ round: 2, finishReason: 'stop', toolCalls: [], ran: false }).dropped, false);
  assert.deepEqual(toolNames(TOOLS.slice(0, 2)), ['recall', 'save_memory']);
});

test('PIPELINE: the loop puts the roster last every round and reports each round', async () => {
  const seen = [];
  const rounds = [];
  const replies = [
    { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 't1', function: { name: 'recall', arguments: '{}' } }] } }] },
    // A provider that streams a call but finishes with 'stop': today the loop
    // takes this as the answer, so the call is dropped — and now that's visible.
    { choices: [{ finish_reason: 'stop', message: { content: 'Cut it.', tool_calls: [{ id: 't2', function: { name: 'remove_from_identity', arguments: '{}' } }] } }] },
  ];
  const { toolRounds } = await runToolCallLoop({
    callUpstream: async (msgs) => { seen.push(msgs.at(-1)); return replies[seen.length - 1]; },
    baseMessages: [{ role: 'user', content: 'tidy my file' }],
    timeAnchor: '[Now: 13:20]',
    rosterTools: () => TOOLS,
    executeTool: async () => 'ok',
    onRound: (r) => rounds.push(r),
  });
  assert.equal(seen.length, 2);
  for (const last of seen) {
    assert.equal(last.role, 'system');
    assert.match(last.content, /^\[Now: 13:20\]\n\n\[Tools I can call right now/);
  }
  assert.equal(toolRounds.length, 1, 'only the tool_calls round ran');
  assert.deepEqual(rounds.map(r => [r.finishReason, r.calls, r.ran, r.dropped]), [
    ['tool_calls', ['recall'], true, false],
    ['stop', ['remove_from_identity'], false, true],
  ]);
});

test('without rosterTools the anchor is unchanged (background loops, old callers)', async () => {
  let last;
  await runToolCallLoop({
    callUpstream: async (msgs) => { last = msgs.at(-1); return { choices: [{ finish_reason: 'stop', message: { content: 'hi' } }] }; },
    baseMessages: [{ role: 'user', content: 'hi' }],
    timeAnchor: '[Now: 13:20]',
  });
  assert.equal(last.content, '[Now: 13:20]');
});
