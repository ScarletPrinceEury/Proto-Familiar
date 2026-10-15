// The Familiar marks care facts itself (0.14.71).
//
// 0.14.70 moved care details about my human out of identity into high-care
// standing facts, but the only way a fact became high-care was its WORDING
// matching care.py's patterns. A plainly worded standing care request ("a
// nudge to eat before a long shift") never made the care list, and I had no way to say
// so. high_care on save_memory / update_memory_by_id is my own call; these run
// the real executors through the real thalamus wrapper into a stub Phylactery
// and check what actually reaches it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { careWeightFromFlag } = await import('../src/safety/care-facts.js');
const { BUILTIN_TOOLS, executeToolCall } = await import('../cerebellum.js');
const { __setPhylacteryClientForTest } = await import('../thalamus.js');

let calls = [];
beforeEach(() => {
  calls = [];
  __setPhylacteryClientForTest({
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: 'Memory saved id=eat-before-a-shift-x1.' }] };
    },
  });
});

const saveArgs = (name) => calls.find(c => c.name === name)?.args;
const run = (tool, args) => executeToolCall(tool, JSON.stringify(args));

test('high_care maps to the care_weight vocabulary the Knowledge editor uses', () => {
  assert.equal(careWeightFromFlag(true), 'high');
  assert.equal(careWeightFromFlag('true'), 'high');
  assert.equal(careWeightFromFlag(false), 'low');
  assert.equal(careWeightFromFlag('false'), 'low');
  for (const unset of [undefined, null, 'maybe', 1]) assert.equal(careWeightFromFlag(unset), undefined);
});

test('a plainly worded care request saved with high_care reaches Phylactery as high-care', async () => {
  const out = await run('save_memory', {
    content: '- They want a nudge to eat before a long shift.',
    granularity: 'daily', title: 'eat before a long shift', register: 'ward', high_care: true,
  });
  const args = saveArgs('memory_create');
  assert.equal(args.care_weight, 'high');
  assert.equal(args.register, 'ward');
  assert.equal(out, 'ok');
});

test('without high_care nothing is sent, so the wording still decides', async () => {
  await run('save_memory', { content: '- Likes oat milk.', granularity: 'daily', title: 'oat milk', register: 'ward' });
  assert.ok(!('care_weight' in saveArgs('memory_create')));
});

test('high_care false is an explicit no, which beats a wording match', async () => {
  await run('save_memory', { content: '- Jokes that coffee is their medication.', granularity: 'daily', title: 'coffee joke', register: 'ward', high_care: false });
  assert.equal(saveArgs('memory_create').care_weight, 'low');
});

test('high_care on a non-ward save says plainly it is not in the care list', async () => {
  const out = await run('save_memory', { content: '- Today they had a rough morning.', granularity: 'daily', high_care: true });
  assert.equal(saveArgs('memory_create').care_weight, 'high');
  assert.notEqual(out, 'ok', 'a quiet ok would let me believe it is in front of me');
  assert.match(out, /not in my care list/);
});

test('update_memory_by_id can flag or unflag an existing fact on its own', async () => {
  await run('update_memory_by_id', { id: 'eat-before-a-shift-x1', high_care: true });
  assert.equal(saveArgs('memory_update_by_id').careWeight, 'high');
  calls = [];
  await run('update_memory_by_id', { id: 'eat-before-a-shift-x1', high_care: false });
  assert.equal(saveArgs('memory_update_by_id').careWeight, 'low');
  calls = [];
  const nothing = await run('update_memory_by_id', { id: 'eat-before-a-shift-x1' });
  assert.match(nothing, /Nothing to change/);
  assert.equal(calls.length, 0);
});

test('both tools tell me high_care exists (I can only use what I can see)', () => {
  const props = (n) => BUILTIN_TOOLS.find(t => t.function.name === n).function.parameters.properties;
  assert.equal(props('save_memory').high_care?.type, 'boolean');
  assert.equal(props('update_memory_by_id').high_care?.type, 'boolean');
  const desc = BUILTIN_TOOLS.find(t => t.function.name === 'save_memory').function.description;
  assert.match(desc, /high_care: true/);
});
