import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleAudiences, topicGrantsForRoom, AUDIENCE_TAG_WARD_PRIVATE } from '../audience.js';

// Membership-model registry (audit fix): 'family' and 'work' carry IDENTICAL
// grants (both memories:true) — the whole point is that equal permissionScore
// no longer means "same circle." A villager's membership set is
// categoryIds ∪ {strangers}; the room's visible set is the INTERSECTION of
// every present participant's (and the location's) membership set.
const registry = {
  categories: [
    { id: 'strangers', grants: {} },
    { id: 'family',    grants: { memories: true } },
    { id: 'work',      grants: { memories: true } },   // same score as family, different circle
    { id: 'close',     grants: { memories: true, contacts: true } },
  ],
  villagers: [
    { id: 'mom-id',  name: 'Mom',  categoryIds: ['family'], aliases: [] },
    { id: 'boss-id', name: 'Boss', categoryIds: ['work'], aliases: [] },
    { id: 'sib-id',  name: 'Sib',  categoryIds: ['family', 'close'], aliases: [] },
  ],
  locations: [],
};

test('ward-private: null audience, or empty participants + no location → null', () => {
  assert.equal(visibleAudiences(null, registry), null);
  assert.equal(visibleAudiences({ participants: [], location: null }, registry), null);
});

test('family DM (single participant) → their circle + strangers', () => {
  const set = visibleAudiences({ participants: [{ id: 'mom-id', name: 'Mom' }] }, registry);
  assert.deepEqual(set.sort(), ['family', 'strangers']);
});

test('family + work in the same room → ONLY strangers, even though both score equally (the audit fix)', () => {
  // Mom ∈ {family, strangers}, Boss ∈ {work, strangers}. Under the old scalar
  // trust model these tied and could see each other; under membership the
  // intersection of their sets is just {strangers} — two circles with equal
  // permissionScore are still mutually isolated unless they actually share a
  // category. This is the exact bug this rewrite fixes.
  const set = visibleAudiences(
    { participants: [{ id: 'mom-id', name: 'Mom' }, { id: 'boss-id', name: 'Boss' }] },
    registry,
  );
  assert.deepEqual(set.sort(), ['strangers']);
});

test('Sib DM (multi-circle villager) → both their circles + strangers', () => {
  const set = visibleAudiences({ participants: [{ id: 'sib-id', name: 'Sib' }] }, registry);
  assert.deepEqual(set.sort(), ['close', 'family', 'strangers']);
});

test('a stranger present → only strangers', () => {
  const set = visibleAudiences({ participants: [{ name: 'Nobody' }] }, registry);
  assert.deepEqual(set, ['strangers']);
});

test('a villager whose categoryIds include a deleted/unknown category → that id is absent (fail-closed)', () => {
  const withGhost = {
    ...registry,
    villagers: [...registry.villagers, { id: 'ghost-owner', name: 'GhostOwner', categoryIds: ['family', 'ghost'], aliases: [] }],
  };
  const set = visibleAudiences({ participants: [{ id: 'ghost-owner', name: 'GhostOwner' }] }, withGhost);
  assert.ok(!set.includes('ghost'));
  assert.deepEqual(set.sort(), ['family', 'strangers']);
});

// ── topicGrantsForRoom (content-gating Phase 4 recall gate) ─────────

test('topicGrantsForRoom: ward-private room → null (ward sees all, no content filter)', () => {
  assert.equal(topicGrantsForRoom({ topics: { medical: 'open' } }, AUDIENCE_TAG_WARD_PRIVATE), null);
  assert.equal(topicGrantsForRoom({}, null), null);
});

test('topicGrantsForRoom: a villager room returns its sanitized per-topic map', () => {
  const grants = { memories: 'shared', topics: { medical: 'open', general: 'sensitive', bogus: 'open', legal: 'nonsense' } };
  // Unknown topic (bogus) and bad level (legal:nonsense) are dropped; valid kept.
  assert.deepEqual(topicGrantsForRoom(grants, 'friends'), { medical: 'open', general: 'sensitive' });
});

test('topicGrantsForRoom: a villager room with no topics map → {} (fail-closed, nothing by content)', () => {
  assert.deepEqual(topicGrantsForRoom({ memories: 'shared' }, 'friends'), {});
  assert.deepEqual(topicGrantsForRoom(null, 'strangers'), {});
});
