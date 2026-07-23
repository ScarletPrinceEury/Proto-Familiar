import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleAudiences, AUDIENCE_TAG_WARD_PRIVATE } from '../audience.js';

// Categories with ascending trust (by permissionScore of their grants):
//   strangers (0) < friends (1, memories:'shared') < family (3, memories:true + graph:true)
const registry = {
  categories: [
    { id: 'strangers', grants: {} },
    { id: 'friends',   grants: { memories: 'shared' } },
    { id: 'family',    grants: { memories: true, graph: true } },
  ],
};

test('ward-private room → null (no filter, ward sees everything)', () => {
  assert.equal(visibleAudiences(AUDIENCE_TAG_WARD_PRIVATE, registry), null);
  assert.equal(visibleAudiences(null, registry), null);
});

test('a room sees its own tag + every less-trusted category, never ward-private', () => {
  const friends = visibleAudiences('friends', registry);
  assert.deepEqual(friends.sort(), ['friends', 'strangers']); // not family
  assert.ok(!friends.includes('ward-private'));               // ward-private is never a category

  const family = visibleAudiences('family', registry);
  assert.deepEqual(family.sort(), ['family', 'friends', 'strangers']); // sees all below it

  const strangers = visibleAudiences('strangers', registry);
  assert.deepEqual(strangers, ['strangers']);                 // only its own floor
});

test('a record tagged with a deleted/unknown category is absent from the set (fail-closed)', () => {
  // 'ghost' isn't in the registry, so no room's visible set contains it →
  // `audience IN (set)` excludes it.
  for (const tag of ['friends', 'family', 'strangers']) {
    assert.ok(!visibleAudiences(tag, registry).includes('ghost'));
  }
});

// Content-gating (Phase 2): a nested `topics` grant must NOT perturb the coarse
// permissionScore-based visibility (topic gating is a separate axis, Phase 4).
test('a topics grant does not change coarse visibleAudiences scoring', () => {
  const withTopics = {
    categories: [
      { id: 'strangers', grants: {} },
      { id: 'friends',   grants: { memories: 'shared', topics: { medical: 'sensitive', general: 'open' } } },
      { id: 'family',    grants: { memories: true, graph: true, topics: { general: 'sensitive' } } },
    ],
  };
  // Identical to the topic-less registry above.
  assert.deepEqual(visibleAudiences('friends', withTopics).sort(), ['friends', 'strangers']);
  assert.deepEqual(visibleAudiences('family', withTopics).sort(), ['family', 'friends', 'strangers']);
  assert.deepEqual(visibleAudiences('strangers', withTopics), ['strangers']);
});
