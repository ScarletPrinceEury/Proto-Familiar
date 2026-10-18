// Tome lore gets full Village gating, like memories (0.14.95, ward decisions):
// the circle check (who a note names, the room it was made in) plus the topic
// check (several topics allowed; a room needs every one), the shipped diagnosis
// lines following the mental-health grant, and Session Memories gated entry by
// entry. Synthetic people and content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeRegistry } from '../src/village/village.js';
import { visibleAudiences, topicGrantsForRoom, resolveAudience, audienceTagFor, AUDIENCE_TAG_WARD_OPEN } from '../src/village/audience.js';
import { entryAudience, villagerMatchers } from '../src/tomes/tome-audience.js';
import { tomesForRoom, entryReachesRoom, loreForTurn } from '../src/tomes/room-lore.js';
import { migrateTomeSharing, DIAGNOSIS_TAG } from '../src/tomes/tome-migrations.js';
import { modifyTomeFile } from '../thalamus.js';
import { initCerebellumTools, executeToolCall } from '../cerebellum.js';

const REG = normalizeRegistry({
  categories: [
    { id: 'friends', name: 'Friends', grants: { topics: { general: 'open', work: 'open' } } },
    { id: 'close', name: 'Close', grants: { topics: { general: 'sensitive', work: 'open', 'mental-health': 'sensitive' } } },
  ],
  villagers: [
    { id: 'v-sam', name: 'Sam Lee', categoryIds: ['friends'], disclosure: { basics: 'friends' } },
    { id: 'v-jo', name: 'Jo March', categoryIds: ['close'] },
    { id: 'v-me', name: 'Synth', categoryIds: [] },
  ],
});

function room(...ids) {
  const sessionAudience = { participants: ids.map(id => ({ id })) };
  return {
    audiences: visibleAudiences(sessionAudience, REG),
    topicGrants: topicGrantsForRoom(resolveAudience(sessionAudience, REG), audienceTagFor(sessionAudience, REG)),
    registry: REG,
  };
}
const SAMS_DM = room('v-sam');
const JOS_DM = room('v-jo');
const audienceOf = (e) => entryAudience(e, { registry: REG, matchers: villagerMatchers(REG, { charName: 'Synth' }) });

test('a note gets its circle the way a memory does', () => {
  assert.equal(audienceOf({ content: 'Openings I like' }), AUDIENCE_TAG_WARD_OPEN, 'about nobody else: the topic check decides');
  assert.equal(audienceOf({ content: 'Jo March starts a new job' }), 'ward-private', 'about someone, no disclosure setting: private, like a memory about them');
  assert.equal(audienceOf({ content: 'Sam Lee likes chess' }), 'friends', "Sam's own disclosure setting widens it to their circle");
  assert.equal(audienceOf({ content: 'Sam Lee had surgery', contentTag: 'medical:sensitive' }), 'ward-private', 'a sensitive fact about someone keeps the memory floor');
  assert.equal(audienceOf({ content: 'Openings', roomTag: 'close' }), 'close', 'made in a circle’s room: stays in that circle');
  assert.equal(audienceOf({ content: 'Openings', room: { participants: [{ id: 'v-jo' }] } }), 'close', 'the room a web topic-save records');
  assert.equal(audienceOf({ content: 'Synth thinks', }), AUDIENCE_TAG_WARD_OPEN, 'my own name is not a third party');
  assert.equal(audienceOf({ content: 'Jo March', audience: 'close' }), 'close', 'an explicit audience wins');
});

test('the circle check comes before the topic check, in every room', () => {
  const reach = (e, r, share = 'content') => entryReachesRoom(e, { share, ...r });
  assert.equal(reach({ content: 'Openings', contentTag: 'self' }, SAMS_DM), true);
  assert.equal(reach({ content: 'Jo March got the job', contentTag: 'self' }, SAMS_DM), false, 'a note about Jo stays private even tagged self');
  assert.equal(reach({ content: 'Sam Lee likes chess', contentTag: 'general:open' }, SAMS_DM), true, "within Sam's own circle");
  assert.equal(reach({ content: 'Openings', roomTag: 'close', contentTag: 'self' }, SAMS_DM), false, "made in the Close room: not Sam's");
  assert.equal(reach({ content: 'Openings', roomTag: 'close', contentTag: 'self' }, JOS_DM), true, 'but Jo is in Close');
  assert.equal(reach({ content: 'Jo March got the job', contentTag: 'self' }, { ...SAMS_DM, audiences: undefined }), false, 'no circle set from the caller: fail-closed for notes about people');
  assert.equal(reach({ content: 'Openings', contentTag: 'self' }, { ...SAMS_DM, audiences: undefined }), true, 'but notes about nobody else still pass');
});

test('several topics: a room needs every one of them', () => {
  const both = { content: 'A long day', contentTag: 'general:open+mental-health:sensitive' };
  assert.equal(entryReachesRoom(both, { ...SAMS_DM }), false, 'Friends has general but not mental health');
  assert.equal(entryReachesRoom(both, { ...JOS_DM }), true, 'Close has both');
  const garbled = { content: 'x', contentTag: 'work:open+buddies' };
  assert.equal(entryReachesRoom(garbled, { ...SAMS_DM }), false, 'an unreadable tag counts as untagged (general:sensitive): Friends only has general:open');
  assert.equal(entryReachesRoom(garbled, { ...JOS_DM }), true, 'Close has general:sensitive');
});

test("an 'always' tome shares its untagged notes; a note with its own topics follows them", () => {
  const tome = { name: 'Guide', enabled: true, roomShare: 'always', entries: {
    g: { uid: 'g', content: 'guidance' },
    d: { uid: 'd', content: 'diagnosis', contentTag: DIAGNOSIS_TAG },
  } };
  assert.deepEqual(Object.keys(tomesForRoom([tome], SAMS_DM)[0].entries), ['g']);
  assert.deepEqual(Object.keys(tomesForRoom([tome], JOS_DM)[0].entries), ['g', 'd']);
});

function tempTomes() {
  const dir = mkdtempSync(path.join(tmpdir(), 'village-gate-'));
  writeFileSync(path.join(dir, 'ADHD-Tome.json'), JSON.stringify({ id: 'a0000000-a000-4000-a000-a00000000000', name: 'ADHD Support', enabled: true, roomShare: 'always', entries: {
    'a0000001-a000-4000-a000-a00000000000': { uid: 'a0000001-a000-4000-a000-a00000000000', constant: true, enabled: true, content: 'DIAGNOSIS LINE', position: 0, wardOnly: true },
    tip: { uid: 'tip', enabled: true, content: 'TIME TIP', keys: ['time'], position: 4 },
  } }));
  writeFileSync(path.join(dir, 'OCD-Tome.json'), JSON.stringify({ id: 'c0000000-c000-4000-c000-c00000000000', name: 'OCD Support', enabled: true, roomShare: 'always', entries: {
    'c0000001-c000-4000-c000-c00000000000': { uid: 'c0000001-c000-4000-c000-c00000000000', constant: true, enabled: true, content: 'KEPT', position: 0, wardOnly: true, contentTagSource: 'ward' },
  } }));
  writeFileSync(path.join(dir, 'Session.json'), JSON.stringify({ id: 'sm', name: 'Session Memories', wardOnly: true, enabled: true, entries: {
    s1: { uid: 's1', enabled: true, content: 'SESSION about the time', keys: ['time'], position: 4 },
  } }));
  return dir;
}

test('pipeline: the boot migration converts the shipped flag once, leaves my human’s own choice, and the room gate follows', async () => {
  const dir = tempTomes();
  const first = await migrateTomeSharing(dir, { modifyTomeFile, now: () => 'T' });
  assert.deepEqual(first, { diagnosis: ['ADHD Support'], unprivate: ['Session Memories'] });
  const adhd = JSON.parse(readFileSync(path.join(dir, 'ADHD-Tome.json'), 'utf8')).entries['a0000001-a000-4000-a000-a00000000000'];
  assert.equal(adhd.contentTag, DIAGNOSIS_TAG);
  assert.equal(adhd.wardOnly, undefined);
  assert.equal(adhd.contentTagSource, 'shipped');
  const ocd = JSON.parse(readFileSync(path.join(dir, 'OCD-Tome.json'), 'utf8')).entries['c0000001-c000-4000-c000-c00000000000'];
  assert.equal(ocd.wardOnly, true, 'set by my human: untouched');
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'Session.json'), 'utf8')).wardOnly, undefined);
  assert.deepEqual(await migrateTomeSharing(dir, { modifyTomeFile }), { diagnosis: [], unprivate: [] }, 'idempotent');

  const settings = { charName: 'Synth' };
  const sam = await loreForTurn({ content: 'the time', settings, ...SAMS_DM, tomesDir: dir });
  const all = sam.lead + sam.atDepth;
  assert.match(all, /TIME TIP/);
  assert.doesNotMatch(all, /DIAGNOSIS LINE|KEPT/);
  assert.doesNotMatch(all, /SESSION about/, 'an unsorted session memory is general:sensitive; Friends only has general:open');
  const jo = await loreForTurn({ content: 'the time', settings, ...JOS_DM, tomesDir: dir });
  const joAll = jo.lead + jo.atDepth;
  assert.match(joAll, /DIAGNOSIS LINE/, 'Close is trusted with mental health at sensitive');
  assert.match(joAll, /SESSION about/, 'and with general at sensitive');
  assert.doesNotMatch(joAll, /KEPT/);
});

test('save_to_tome on a shared turn records the room, so the note stays in that circle', async () => {
  const calls = [];
  initCerebellumTools({ addDefaultTomeEntry: async (a) => { calls.push(a); return { uid: 'u1' }; } });
  await executeToolCall('save_to_tome', JSON.stringify({ title: 't', content: 'c', keywords: ['k'], content_tag: 'self' }), { audienceTag: 'close' });
  assert.equal(calls[0].share.roomTag, 'close');
  await executeToolCall('save_to_tome', JSON.stringify({ title: 't', content: 'c', keywords: ['k'] }), { audienceTag: 'ward-private' });
  assert.equal(calls[1].share.roomTag, undefined, "my human's own room needs no stamp");
});
