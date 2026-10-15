// My noticing turn reaches for what my live turns reach for (0.14.82, ward decision).
//
// An intention set in a full live turn ("walk the care list, merge the duplicate
// graph node, cut the doubled paragraph") fired in a noticing turn that had none
// of those tools — but did have intention_done and the reach-out — so the likely
// outcomes were a sweep marked done without the work, or a morning list of fixes
// that never ran. Noticing now composes like a live turn: core + surfaced modules
// + request_tools, the same round budget, minus the crisis tools (ward-signed:
// escalation stays one path, flag_distress → triage).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { composeNoticingTools, runToolCallLoop, executeToolCall, NOTICING_EXCLUDED_TOOLS } = await import('../cerebellum.js');
const { runNoticingToolLoop } = await import('../src/safety/noticing.js');

const names = (tools) => tools.map(t => t.function.name);

// What the noticing turn could reach before parity. None of it may go missing.
const OLD_ALLOWLIST = [
  'intention_set', 'intention_list', 'intention_drop', 'intention_done', 'intention_mark_fired',
  'schedule_find', 'schedule_availability', 'schedule_export', 'schedule_set_lead', 'get_datetime',
  'schedule_resolve', 'schedule_calibrate_link', 'search_conversation',
  'recall', 'read_memory_by_id', 'update_memory_by_id', 'flag_distress',
];

test('a noticing turn keeps everything it had, and has my core (identity edits, save_memory, request_tools)', () => {
  const got = names(composeNoticingTools({}));
  for (const n of OLD_ALLOWLIST) assert.ok(got.includes(n), `still has ${n}`);
  for (const n of ['remove_from_identity', 'rewrite_identity_section', 'update_identity', 'save_memory',
                   'request_tools', 'reach_out_to_ward', 'set_next_check']) {
    assert.ok(got.includes(n), `now has ${n}`);
  }
});

test('a sweep intention firing in noticing surfaces the tools its own words need', async () => {
  const { selectModules } = await import('../tool-surfacing.js');
  const sweep = 'I run the maintenance sweep: walk the care facts line by line and drop the stale one, merge the two duplicate nodes in the graph, cut the doubled paragraph in my_mechanics.';
  const got = names(composeNoticingTools({}, { modules: selectModules({ turnText: sweep }) }));
  for (const n of ['list_care_facts', 'delete_memory_by_id', 'delete_graph_node', 'remove_from_identity']) {
    assert.ok(got.includes(n), `the sweep can reach ${n}`);
  }
});

test('the crisis tools stay with triage; noticing hands an alarming read over with flag_distress', () => {
  const got = names(composeNoticingTools({}, { modules: new Set(['graph', 'village']), requested: ['acks'] }));
  for (const n of NOTICING_EXCLUDED_TOOLS) assert.ok(!got.includes(n), `${n} is not a noticing tool`);
  assert.ok(got.includes('flag_distress'));
  assert.deepEqual([...NOTICING_EXCLUDED_TOOLS].sort(), ['contact_trusted_person', 'show_crisis_resources']);
});

test('what the turn surfaces or pulls in arrives, like a live turn', () => {
  assert.ok(!names(composeNoticingTools({})).includes('delete_graph_node'), 'graph only when surfaced or asked for');
  assert.ok(names(composeNoticingTools({}, { modules: new Set(['graph']) })).includes('delete_graph_node'));
  assert.ok(names(composeNoticingTools({}, { requested: ['graph'] })).includes('delete_graph_node'));
});

test('pipeline: request_tools in a noticing turn brings the tools in for the next round, under the live round budget', async () => {
  const toolCtx = { noticing: true, wardPrivate: true, _requestedModules: new Set() };
  const base = composeNoticingTools({});
  const getTools = () => (toolCtx._requestedModules.size ? composeNoticingTools({}, { requested: toolCtx._requestedModules }) : base);
  const seen = [];
  const callRaw = async ({ tools }) => {
    seen.push(names(tools));
    if (seen.length === 1) {
      return { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
        { id: 'r1', type: 'function', function: { name: 'request_tools', arguments: JSON.stringify({ modules: ['graph'] }) } },
      ] } }] };
    }
    if (seen.length < 9) {
      return { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
        { id: `t${seen.length}`, type: 'function', function: { name: 'get_datetime', arguments: '{}' } },
      ] } }] };
    }
    return { choices: [{ finish_reason: 'stop', message: { content: 'done' } }] };
  };
  const out = await runNoticingToolLoop({
    runLoop: runToolCallLoop, callRaw, conn: {}, settings: {},
    messages: [{ role: 'system', content: 'I take a look around.' }],
    tools: base, executeTool: (n, a, ctx) => executeToolCall(n, a, ctx), toolCtx, getTools, maxRounds: 12,
  });
  assert.equal(out.timedOut, false);
  assert.ok(!seen[0].includes('delete_graph_node'), 'not before I asked');
  assert.ok(seen[1].includes('delete_graph_node'), 'there on the very next round');
  assert.ok(seen.length >= 9, `the turn ran ${seen.length} rounds, past the old cap of 5`);
});
