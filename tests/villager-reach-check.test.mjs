// A warm reach-out to a villager waits when its privacy check can't run
// (0.14.125, ward decision 2026-11-06). It used to go out with only the
// keep-between-us swap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVillagerReach } from '../src/warmth/villager-reach-check.js';

const SAM = { id: 'v-sam', name: 'Sam' };
const REGISTRY = {
  categories: [{ id: 'strangers', grants: {} }, { id: 'friends', grants: { memories: 'shared' } }],
  villagers: [{ id: 'v-sam', name: 'Sam', categoryIds: ['friends'] }],
  locations: [],
};
const check = (searchRestricted, loadRegistry = async () => REGISTRY) =>
  checkVillagerReach({ villager: SAM, draft: 'thinking of you!', loadRegistry, searchRestricted });

test('a clean check lets it go, searched against Sam\'s own circle', async () => {
  const asked = [];
  const r = await check(async (q) => { asked.push(q); return { hit: false }; });
  assert.deepEqual(r, { ok: true });
  assert.equal(asked[0].roomAudience, 'friends');
  assert.equal(asked[0].query, 'thinking of you!');
});

test('something stored as private for them holds it', async () => {
  const r = await check(async () => ({ hit: true, topic: 'x' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /isn't cleared for Sam/);
});

for (const [why, search, registry] of [
  ['the village list can\'t be read', async () => ({ hit: false }), async () => { throw new Error('half-written'); }],
  ['the memory search throws', async () => { throw new Error('phylactery not connected'); }],
  ['the memory search says it failed', async () => ({ hit: false, failed: true })],
  ['the memory search returns nothing', async () => undefined],
]) {
  test(`it waits when ${why}`, async () => {
    const r = await check(search, registry);
    assert.equal(r.ok, false);
    assert.match(r.error, /^held: the privacy check couldn't run/);
  });
}
