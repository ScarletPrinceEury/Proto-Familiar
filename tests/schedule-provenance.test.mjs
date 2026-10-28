// Where a schedule item came from is visible, and a delete the sync would undo
// doesn't happen (0.14.84).
//
// From a self-rule inventory: "check where a duplicate came from before retiring
// it" existed only because schedule search results didn't say which items the
// calendar sync owns, and deleting a synced item looked like it worked until the
// next sync quietly brought it back. These run the real executors through the
// real thalamus wrappers into a stub Unruh.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { executeToolCall } = await import('../cerebellum.js');
const { __setUnruhClientForTest } = await import('../thalamus.js');

const SYNCED = { id: 'wash-day-x1', type: 'event', label: 'Wash day', when: '2026-11-02T09:00:00', payload: { source: 'gcal', gcal_uid: 'abc_20261102' } };
const MINE = { id: 'call-the-vet-k2', type: 'task', label: 'Call the vet', payload: {} };
const SHARED = { ...SYNCED, id: 'club-night-z9', label: 'Club night', payload: { source: 'gcal', gcal_attribution: { kind: 'villager', label: 'the club' } } };

let calls = [];
beforeEach(() => {
  calls = [];
  __setUnruhClientForTest({
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args });
      const byId = { [SYNCED.id]: SYNCED, [MINE.id]: MINE };
      const reply = name === 'schedule_find' ? { ok: true, matches: [SYNCED, MINE, SHARED] }
        : name === 'schedule_get' ? (byId[args.id] ? { ok: true, node: byId[args.id] } : { ok: false, code: 'not_found' })
        : name === 'schedule_delete_node' ? { ok: true, deleted: true }
        : { ok: true };
      return { content: [{ type: 'text', text: JSON.stringify(reply) }] };
    },
  });
});
const run = (tool, args) => executeToolCall(tool, JSON.stringify(args), { wardPrivate: true });

test('schedule_find marks what the calendar sync owns, and whose calendar it is', async () => {
  const out = await run('schedule_find', { query: 'a' });
  assert.match(out, /- Wash day 📅 \[event\]/);
  assert.match(out, /- Club night 📅 the club \[event\]/);
  assert.match(out, /- Call the vet \[task\]/, 'a hand-made item carries no marker');
});

test('a synced item is not deleted; I hear what works instead', async () => {
  const out = await run('schedule_delete', { id: SYNCED.id });
  assert.ok(!calls.some(c => c.name === 'schedule_delete_node'), 'no delete reached Unruh');
  assert.match(out, /^Wash day comes from the calendar sync \(📅\), so deleting it here would only last until the next sync\./);
  assert.match(out, /resolve it as cancelled \(schedule_resolve\)/);
});

test('my own items still delete as before', async () => {
  assert.match(await run('schedule_delete', { id: MINE.id }), /^ok: /);
  assert.deepEqual(calls.find(c => c.name === 'schedule_delete_node')?.args, { id: MINE.id });
});
