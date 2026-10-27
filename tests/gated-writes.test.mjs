// What a villager's turn may change by id (0.14.105, ward-signed).
//
// A villager with write grants got update_memory_by_id, move_memory_date and the
// by-id schedule writes. Recall on their turn was scoped to the room; the writes
// weren't, so a guessed slug id rewrote any memory, my human's private ones
// included. Now each id a by-id write names is read first and must be readable
// by the room.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { GATED_BY_ID_WRITES, NOT_TARGETED, memoryReadableInRoom, scheduleItemWritableInRoom, gatedWriteRefusal } from '../src/village/gated-writes.js';
const { BUILTIN_TOOLS, VILLAGER_WRITE_TOOLS, executeToolCall } = await import('../cerebellum.js');
const { __setPhylacteryClientForTest, __setUnruhClientForTest } = await import('../thalamus.js');

const ROOM = { audiences: ['friends', 'ward-content-gated'], topicGrants: { general: 'sensitive', work: 'open' } };
const mem = (over) => ({ ok: true, id: 'm-x1', audience: 'friends', content_tag: 'general:open', ...over });

test('a memory is changeable in the room only when the room could read it', () => {
  assert.equal(memoryReadableInRoom(mem(), ROOM), true);
  assert.equal(memoryReadableInRoom(mem({ audience: 'ward-private' }), ROOM), false, 'private to my human');
  assert.equal(memoryReadableInRoom(mem({ audience: 'family' }), ROOM), false, 'another circle');
  assert.equal(memoryReadableInRoom(mem({ audience: 'ward-content-gated', content_tag: 'work:open' }), ROOM), true);
  assert.equal(memoryReadableInRoom(mem({ audience: 'ward-content-gated', content_tag: 'mental-health:sensitive' }), ROOM), false, 'topic not granted');
  assert.equal(memoryReadableInRoom(mem({ content_tag: '' }), { ...ROOM, topicGrants: { general: 'open' } }), false, 'untagged counts as general:sensitive');
  assert.equal(memoryReadableInRoom({ ok: false, error: 'no memory' }, ROOM), false);
  assert.equal(memoryReadableInRoom(mem(), { audiences: [], topicGrants: {} }), false, 'a room cleared for nothing');
});

test('a schedule item is changeable in the room unless it is sensitive', () => {
  assert.equal(scheduleItemWritableInRoom({ node: { id: 'dentist-k2', payload: {} } }), true);
  assert.equal(scheduleItemWritableInRoom({ id: 'dentist-k2' }), true, 'a bare node works too');
  assert.equal(scheduleItemWritableInRoom({ node: { id: 'hard-week-p3', payload: { sensitive: true } } }), false);
  assert.equal(scheduleItemWritableInRoom({ node: { id: 'spine-q1', payload: { spine: true } } }), false);
  assert.equal(scheduleItemWritableInRoom({ ok: false, error: 'not found' }), false);
});

test('every id a write names is checked; a missing item reads exactly like a hidden one', async () => {
  const memories = { 'shared-a1': mem({ id: 'shared-a1' }), 'secret-b2': mem({ id: 'secret-b2', audience: 'ward-private' }) };
  const nodes = { 'walk-c3': { id: 'walk-c3', payload: {} }, 'low-d4': { id: 'low-d4', payload: { sensitive: true } } };
  const deps = {
    ...ROOM,
    readMemoryById: async ({ id }) => memories[id] ?? { ok: false, error: `no memory with id '${id}'` },
    getScheduleNode: async ({ id }) => (nodes[id] ? { node: nodes[id] } : { ok: false, error: 'not found' }),
  };
  assert.equal(await gatedWriteRefusal('update_memory_by_id', { id: 'shared-a1' }, deps), null);
  const hidden = await gatedWriteRefusal('update_memory_by_id', { id: 'secret-b2' }, deps);
  const missing = await gatedWriteRefusal('move_memory_date', { id: 'no-such-z9' }, deps);
  assert.match(hidden, /^Nothing changed: that memory isn't one I can change from this conversation\./);
  assert.equal(missing, hidden, 'no oracle for whether an id exists');
  assert.equal(await gatedWriteRefusal('schedule_link', { src: 'walk-c3', dst: 'walk-c3' }, deps), null);
  assert.match(await gatedWriteRefusal('schedule_link', { src: 'walk-c3', dst: 'low-d4' }, deps), /that item isn't one I can change/, 'the dst is checked too');
  assert.equal(await gatedWriteRefusal('schedule_link', { src: 'walk-c3', dst_state: 'tired' }, deps), null, 'a state named by label is new, nothing to check');
  assert.match(await gatedWriteRefusal('template_apply', { event_id: 'low-d4' }, deps), /that item/);
  const throws = { ...deps, readMemoryById: async () => { throw new Error('peer down'); } };
  assert.equal(await gatedWriteRefusal('update_memory_by_id', { id: 'shared-a1' }, throws), hidden, 'a failed read refuses');
  assert.equal(await gatedWriteRefusal('save_memory', { content: 'x' }, deps), null, 'creating something new is not a by-id write');
});

test('every villager write tool with an id-shaped argument is gated or explicitly exempt', () => {
  const ID_SHAPED = (k) => k === 'id' || k === 'src' || k === 'dst' || k.endsWith('_id');
  const props = (n) => Object.keys(BUILTIN_TOOLS.find(t => t.function?.name === n)?.function?.parameters?.properties ?? {});
  for (const name of VILLAGER_WRITE_TOOLS) {
    const idArgs = props(name).filter(ID_SHAPED);
    if (!idArgs.length) continue;
    if (NOT_TARGETED[name]) continue;
    assert.ok(GATED_BY_ID_WRITES[name], `${name} takes ${idArgs.join(', ')} but isn't in GATED_BY_ID_WRITES`);
    assert.deepEqual([...GATED_BY_ID_WRITES[name].args].sort(), [...idArgs].sort(), `${name}: every id argument is checked`);
  }
  for (const [name, rule] of Object.entries(GATED_BY_ID_WRITES)) {
    for (const a of rule.args) assert.ok(props(name).includes(a), `${name} has no argument ${a}`);
  }
});

// PIPELINE: the real executeToolCall, through the real thalamus wrappers, into
// stub Phylactery and Unruh clients — so the hook itself is what's tested.
let phyl = [], unruh = [];
const MEMS = {
  'secret-b2': { ok: true, id: 'secret-b2', audience: 'ward-private', content_tag: 'mental-health:sensitive', content: 'x' },
  'shared-a1': { ok: true, id: 'shared-a1', audience: 'friends', content_tag: 'general:open', content: 'y' },
};
const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] });
beforeEach(() => {
  phyl = []; unruh = [];
  __setPhylacteryClientForTest({
    callTool: async ({ name, arguments: args }) => {
      phyl.push({ name, args });
      if (name === 'memory_read_by_id') return text(MEMS[args.id] ?? { ok: false, error: 'no memory' });
      if (name === 'memory_update_by_id') return text({ ok: true, id: args.id });
      return text({ ok: true });
    },
  });
  __setUnruhClientForTest({
    callTool: async ({ name, arguments: args }) => {
      unruh.push({ name, args });
      if (name === 'schedule_get') return text({ node: { id: args.id, label: 'Hard week', payload: { sensitive: true } } });
      if (name === 'schedule_delete_node') return text({ ok: true, deleted: true });
      return text({ ok: true });
    },
  });
});
const VILLAGER = { discord: true, wardPrivate: false, audiences: ['friends'], topicGrants: { general: 'sensitive' }, viaVillager: 'Sam' };

test('PIPELINE: a villager turn cannot rewrite or move my human\'s private memory by id', async () => {
  const out = await executeToolCall('update_memory_by_id', JSON.stringify({ id: 'secret-b2', content: 'rewritten' }), VILLAGER);
  assert.match(out, /Nothing changed: that memory isn't one I can change from this conversation/);
  assert.ok(!phyl.some(c => c.name === 'memory_update_by_id'), 'the write never reached Phylactery');
  await executeToolCall('move_memory_date', JSON.stringify({ id: 'secret-b2', date: '2020-01-01' }), VILLAGER);
  assert.ok(!phyl.some(c => c.name === 'memory_move_date'));
});

test('PIPELINE: a memory the room can read is still changeable, and my human\'s turns are not gated', async () => {
  await executeToolCall('update_memory_by_id', JSON.stringify({ id: 'shared-a1', content: 'fixed' }), VILLAGER);
  assert.ok(phyl.some(c => c.name === 'memory_update_by_id' && c.args.id === 'shared-a1'));
  phyl = [];
  await executeToolCall('update_memory_by_id', JSON.stringify({ id: 'secret-b2', content: 'fixed' }), { discord: true, wardPrivate: true });
  assert.ok(!phyl.some(c => c.name === 'memory_read_by_id'), 'no gate read on my human\'s own turn');
  assert.ok(phyl.some(c => c.name === 'memory_update_by_id' && c.args.id === 'secret-b2'));
});

test('PIPELINE: a villager turn cannot delete a sensitive schedule item by id', async () => {
  const out = await executeToolCall('schedule_delete', JSON.stringify({ id: 'hard-week-p3' }), VILLAGER);
  assert.match(out, /that item isn't one I can change from this conversation/);
  assert.ok(!unruh.some(c => c.name === 'schedule_delete_node'));
});
