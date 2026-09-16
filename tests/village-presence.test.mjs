// The Village presence block — who from my human's Village is in play this turn,
// so the Familiar refers to them right without stopping to run village_lookup.
// The fix for: misgendering people it should know / can't tell them apart, because
// registry facts only ever reached it on an on-demand lookup it rarely ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectRelevantVillagers, buildVillagePresenceBlock, nameTokens,
  villagePresenceOn, MIN_NAME_TOKEN,
} from '../src/village/village-presence.js';
import { disclosableVillagerFields } from '../src/village/village-card.js';

const reg = {
  villagers: [
    { id: 'sam-r-x1', name: 'Sam Rivera', pronouns: 'they/them',
      relationToWard: 'my human\'s brother', commStyleNotes: 'dry, texts in fragments',
      notes: 'allergic to cats', privateNotes: 'in recovery — do not mention drinking' },
    { id: 'mara-k-z2', name: 'Mara', pronouns: 'she/her', notes: 'runs the book club' },
    { id: 'al-p-q3',   name: 'Al', pronouns: 'he/him' }, // short name: present-only, never text-scanned
  ],
};

// ── detection: high-confidence present signal ────────────────────────────────
test('a registered participant (by id) is detected as present', () => {
  const hits = detectRelevantVillagers({ registry: reg, participants: [{ id: 'sam-r-x1', name: 'Sam Rivera' }] });
  assert.deepEqual(hits.map(h => [h.villager.id, h.why]), [['sam-r-x1', 'present']]);
});

test('a participant matched only by name still counts as present', () => {
  const hits = detectRelevantVillagers({ registry: reg, participants: [{ id: null, name: 'Mara' }] });
  assert.deepEqual(hits.map(h => [h.villager.id, h.why]), [['mara-k-z2', 'present']]);
});

// ── detection: name-mention scan ─────────────────────────────────────────────
test('a first-name mention pulls the villager (how people are named mid-talk)', () => {
  const hits = detectRelevantVillagers({ registry: reg, text: "how's Sam doing lately?" });
  assert.deepEqual(hits.map(h => [h.villager.id, h.why]), [['sam-r-x1', 'mentioned']]);
});

test('the mention scan is a whole-word match — no substring false positives', () => {
  // "Samuel" and "marathon" must NOT match "Sam" / "Mara".
  const hits = detectRelevantVillagers({ registry: reg, text: 'Samuel ran a marathon' });
  assert.equal(hits.length, 0);
});

test('a name shorter than the token floor is never text-scanned (Al ∉ "all done")', () => {
  assert.ok('Al'.length < MIN_NAME_TOKEN);
  const hits = detectRelevantVillagers({ registry: reg, text: 'that is all done now' });
  assert.equal(hits.length, 0);
});

test('a short-named villager still surfaces when actually present', () => {
  const hits = detectRelevantVillagers({ registry: reg, participants: [{ id: 'al-p-q3', name: 'Al' }] });
  assert.deepEqual(hits.map(h => h.villager.id), ['al-p-q3']);
});

test('the ward is never returned as a villager, even if a villager shares the name', () => {
  const r = { villagers: [{ id: 'x', name: 'Maus', pronouns: 'she/her' }] };
  const hits = detectRelevantVillagers({ registry: r, text: 'Maus is thinking', wardName: 'Maus' });
  assert.equal(hits.length, 0);
});

test('present wins over mentioned; each villager appears once', () => {
  const hits = detectRelevantVillagers({
    registry: reg, text: 'Sam and Mara', participants: [{ id: 'sam-r-x1', name: 'Sam Rivera' }],
  });
  const sam = hits.find(h => h.villager.id === 'sam-r-x1');
  assert.equal(sam.why, 'present');
  assert.equal(hits.filter(h => h.villager.id === 'sam-r-x1').length, 1);
});

test('nameTokens: full name plus long parts, short parts dropped, deduped', () => {
  assert.deepEqual(nameTokens('Sam Rivera').sort(), ['Rivera', 'Sam', 'Sam Rivera'].sort());
  assert.deepEqual(nameTokens('Al'), ['Al']); // full kept even if short; parts filtered
  assert.deepEqual(nameTokens('Jo Jo'), ['Jo Jo']); // both parts too short → only the full phrase
});

// ── the rendered block + gating ──────────────────────────────────────────────
test('empty when nobody registered is in play', () => {
  assert.equal(buildVillagePresenceBlock({ registry: reg, text: 'just a normal sentence' }), '');
  assert.equal(buildVillagePresenceBlock({ registry: { villagers: [] }, text: 'Sam' }), '');
});

test('ward-private turn: private notes ARE included', () => {
  const block = buildVillagePresenceBlock({ registry: reg, text: 'thinking about Sam', wardPrivate: true });
  assert.match(block, /Sam Rivera \(they\/them\)/);
  assert.match(block, /do not mention drinking/);
  assert.match(block, /my human's brother/);
});

test('shared room: private notes are WITHHELD, everything else is fair game', () => {
  const block = buildVillagePresenceBlock({
    registry: reg, participants: [{ id: 'sam-r-x1', name: 'Sam Rivera' }], wardPrivate: false,
  });
  assert.doesNotMatch(block, /do not mention drinking/, 'privateNotes never in a shared room');
  assert.match(block, /they\/them/, 'pronouns are fair game');
  assert.match(block, /allergic to cats/, 'public notes are fair game');
  assert.match(block, /here now/, 'a present villager is marked present');
});

test('the block is first-person and carries no macro tokens (injected block, not macro\'d)', () => {
  const block = buildVillagePresenceBlock({ registry: reg, text: 'Sam', wardPrivate: true });
  assert.match(block, /my human/);
  assert.doesNotMatch(block, /\{\{\s*(user|char)\s*\}\}/, 'injected blocks author literal "my human"');
});

// ── the shared gate ──────────────────────────────────────────────────────────
test('disclosableVillagerFields: privateNotes ride ward-private only; withheld flag otherwise', () => {
  const v = reg.villagers[0];
  const priv = disclosableVillagerFields(v, { wardPrivate: true });
  assert.equal(priv.privateNotes, 'in recovery — do not mention drinking');
  assert.equal(priv.privateNotesWithheld, false);
  const room = disclosableVillagerFields(v, { wardPrivate: false });
  assert.equal(room.privateNotes, null);
  assert.equal(room.privateNotesWithheld, true);
  // the fair-game fields survive either way
  assert.equal(room.pronouns, 'they/them');
  assert.equal(room.notes, 'allergic to cats');
});

// ── off-switch ───────────────────────────────────────────────────────────────
test('villagePresenceOn: default on; setting false or env kill-switch turns it off', () => {
  assert.equal(villagePresenceOn({}), true);
  assert.equal(villagePresenceOn({ villagePresenceEnabled: false }), false);
  const saved = process.env.PROTO_FAMILIAR_VILLAGE_PRESENCE_DISABLED;
  process.env.PROTO_FAMILIAR_VILLAGE_PRESENCE_DISABLED = '1';
  try { assert.equal(villagePresenceOn({ villagePresenceEnabled: true }), false); }
  finally { if (saved === undefined) delete process.env.PROTO_FAMILIAR_VILLAGE_PRESENCE_DISABLED; else process.env.PROTO_FAMILIAR_VILLAGE_PRESENCE_DISABLED = saved; }
});
