// A room someone else is in (0.14.124, ward decisions 2026-11-06).
//
// - When the web chat has someone marked present and the village list can't be
//   read, the room is one with a stranger in it. It used to fall back to my
//   human's own room: full private context, no outgoing check, memory filed as
//   private, with someone sitting right there.
// - Every room someone else can read carries one line saying so, and what I
//   leave out: codes, ids, links, contact info, anyone's full real name.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PROTO_FAMILIAR_PHYLACTERY_DISABLED = '1';
process.env.PROTO_FAMILIAR_UNRUH_DISABLED = '1';

const { roomGate, strangerRoomGate, roomGateOrStranger } = await import('../src/village/audience.js');
const { othersPresentLine } = await import('../src/village/outgoing-tripwire.js');
const { presenceBlock } = await import('../src/discord/discord-gateway.js');

const REGISTRY = {
  categories: [
    { id: 'strangers', grants: {} },
    { id: 'friends', grants: { memories: 'shared', topics: { hobbies: 'open' } } },
  ],
  villagers: [{ id: 'v-sam', name: 'Sam', categoryIds: ['friends'] }],
  locations: [],
};
const WITH_SAM = { participants: [{ id: 'v-sam', name: 'Sam' }] };

// ── The fallback ──────────────────────────────────────────────────────────

test('an unreadable village list makes it a room with a stranger, never my human\'s own room', async () => {
  const gate = await roomGateOrStranger(WITH_SAM, async () => { throw new Error('registry is half-written'); });
  assert.match(gate.error.message, /half-written/);
  assert.equal(gate.registry, null);
  assert.equal(gate.tag, 'strangers');
  assert.deepEqual(gate.grants, {}, 'nothing granted, not null (null is my human\'s own room)');
  assert.deepEqual(gate.topics, {}, 'no topic opens, not null (null sees everything)');
  assert.ok(Array.isArray(gate.visible) && !gate.visible.includes('ward-private'));
});

test('an audience that can\'t be resolved falls back the same way', async () => {
  const gate = await roomGateOrStranger({ participants: 'not a list' }, async () => REGISTRY);
  assert.ok(gate.error);
  assert.equal(gate.tag, 'strangers');
});

test('the fallback is exactly what a real stranger room gets when nothing is granted to strangers', () => {
  const real = roomGate({ participants: [{ name: 'Someone' }] }, { categories: [], villagers: [], locations: [] });
  assert.deepEqual(strangerRoomGate(), real);
});

test('a readable list still gives the real room', async () => {
  const gate = await roomGateOrStranger(WITH_SAM, async () => REGISTRY);
  assert.equal(gate.error, null);
  assert.equal(gate.registry, REGISTRY);
  assert.deepEqual({ ...gate, error: undefined, registry: undefined }, { ...roomGate(WITH_SAM, REGISTRY), error: undefined, registry: undefined });
  assert.equal(gate.tag, 'friends');
});

// ── The line ──────────────────────────────────────────────────────────────

test('the line names what I leave out, read or heard', () => {
  assert.equal(othersPresentLine(), "Other people can read this, so I leave out codes, ids, links, contact info and anyone's full real name.");
  assert.match(othersPresentLine({ voice: true }), /^Other people can hear this, /);
});

test('every Discord room someone else can read carries it; my human\'s DM doesn\'t', () => {
  const base = { locationLabel: '#general', speakerName: 'Sam', participants: [{ name: 'Sam' }], settings: {} };
  assert.ok(presenceBlock({ ...base, kind: 'guild' }).includes(othersPresentLine()), 'a shared channel');
  assert.ok(presenceBlock({ ...base, kind: 'villager-dm' }).includes(othersPresentLine()), 'a villager\'s DM');
  assert.ok(!presenceBlock({ ...base, kind: 'ward-dm' }).includes(othersPresentLine()), 'my human\'s own DM');
});
