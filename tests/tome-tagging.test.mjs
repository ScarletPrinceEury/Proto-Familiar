// Tome share tags + the sorting pass (0.14.91) — phase B of the tome room gate.
//
// New notes carry a share tag from save_to_tome; older ones are sorted by the
// Familiar in batches (tome-tagging.js). Code checks every tag: a note naming a
// person can't go out as `self` or `:open`. Unsure, skipped or unreadable stays
// out of shared rooms. Synthetic content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  normalizeTomeTag, peopleNames, mentionedPerson, checkTomeTag, applyTomeTag,
  newEntryTagFields, canonicalEntryTag, entryShareKind,
} from '../src/tomes/tome-tags.js';
import {
  selectTaggingCandidates, tomeTaggingStatus, parseTaggingDecision, buildTaggingPrompt, runOneTaggingTick, MAX_MISSES,
} from '../src/tomes/tome-tagging.js';
import { readTomeFiles, buildTomeEntry } from '../src/tomes/tome-store.js';
import { loreForTurn, entryReachesRoom } from '../src/tomes/room-lore.js';
import { modifyTomeFile } from '../thalamus.js';
import { initCerebellumTools, executeToolCall } from '../cerebellum.js';

const FRIENDS = { general: 'open', work: 'open' };
const NAMES = peopleNames({ settings: { userName: 'Robin', charName: 'Synth' }, registry: { villagers: [{ name: 'Sam Lee' }, { name: 'Synth' }, { name: 'Al' }] } });

// ── the tag rules ────────────────────────────────────────────────────

test('normalizeTomeTag reads self / private / topic tags and nothing else', () => {
  assert.equal(normalizeTomeTag('Self'), 'self');
  assert.equal(normalizeTomeTag('private'), 'private');
  assert.equal(normalizeTomeTag('work:open'), 'work:open');
  assert.equal(normalizeTomeTag('mental-health'), 'mental-health:sensitive', 'no level → sensitive');
  assert.equal(normalizeTomeTag('unsure'), null);
  assert.equal(normalizeTomeTag('friends'), null);
  assert.equal(normalizeTomeTag(''), null);
});

test('people: my human (by name, as "my human", as the token) and villagers; never my own name, never tiny names', () => {
  assert.ok(NAMES.includes('robin') && NAMES.includes('sam lee') && NAMES.includes('my human') && NAMES.includes('{{user}}'));
  assert.ok(!NAMES.includes('synth'), 'my own name is not a person to hold for');
  assert.ok(!NAMES.includes('al'), 'two-letter names would hit everywhere');
  assert.equal(mentionedPerson('Robin likes tea', NAMES), 'robin');
  assert.equal(mentionedPerson('a robins nest', NAMES), null, 'whole words only');
  assert.equal(mentionedPerson('Notes on chess openings', NAMES), null);
});

test('checkTomeTag holds a note that names a person at sensitive', () => {
  assert.deepEqual(checkTomeTag('self', 'I love chess openings', NAMES), { tag: 'self', heldBy: null });
  assert.deepEqual(checkTomeTag('self', 'My human and I play chess', NAMES), { tag: 'general:sensitive', heldBy: 'my human' });
  assert.deepEqual(checkTomeTag('work:open', 'Sam Lee starts the new job Monday', NAMES), { tag: 'work:sensitive', heldBy: 'sam lee' });
  assert.deepEqual(checkTomeTag('medical:sensitive', 'Robin has a checkup', NAMES), { tag: 'medical:sensitive', heldBy: null }, 'already sensitive');
  assert.deepEqual(checkTomeTag('private', 'Robin', NAMES), { tag: 'private', heldBy: null });
});

test('applyTomeTag / canonicalEntryTag / entryShareKind', () => {
  const base = { uid: 'a', content: 'x', wardOnly: true, contentTagReviewedAt: 'then' };
  const mine = applyTomeTag(base, 'self', { source: 'review', now: 'T' });
  assert.equal(mine.contentTag, 'self'); assert.equal(mine.wardOnly, undefined); assert.equal(mine.contentTagReviewedAt, undefined);
  assert.equal(mine.contentTagSource, 'review'); assert.equal(base.wardOnly, true, 'input untouched');
  assert.equal(applyTomeTag({}, 'private', { source: 'ward' }).wardOnly, true);
  const looked = applyTomeTag({ uid: 'b' }, null, { source: 'review', now: 'T', reviewed: true });
  assert.equal(entryShareKind(looked), 'unsure');
  const cleared = applyTomeTag(mine, null, { source: 'ward' });
  assert.equal(entryShareKind(cleared), 'unsorted'); assert.equal(cleared.contentTagSource, undefined);
  assert.deepEqual(newEntryTagFields('nonsense'), {});
  assert.equal(canonicalEntryTag({ contentTag: 'private' }).wardOnly, true);
  assert.equal(canonicalEntryTag({ contentTag: 'junk' }).contentTag, undefined);
  assert.equal(canonicalEntryTag({ contentTag: 'Work:Open' }).contentTag, 'work:open');
});

test('a hand-written "private" contentTag never reaches a shared room', () => {
  assert.equal(entryReachesRoom({ contentTag: 'private' }, { topicGrants: { general: 'sensitive' } }), false);
});

test('buildTomeEntry carries the share fields', () => {
  const { entry } = buildTomeEntry({ content: 'c', share: newEntryTagFields('self', { now: 'T' }) });
  assert.equal(entry.contentTag, 'self');
  assert.equal(entry.contentTagSource, 'familiar');
  assert.equal(buildTomeEntry({ content: 'c' }).entry.contentTag, undefined);
});

// ── save_to_tome ─────────────────────────────────────────────────────

function stubSaves() {
  const calls = [];
  initCerebellumTools({
    addDefaultTomeEntry: async (a) => { calls.push(a); return { uid: 'def-1' }; },
    addTomeEntryByName: async (a) => { calls.push(a); return { uid: 'named-1', created: false }; },
    getVillageRegistry: async () => ({ villagers: [{ name: 'Sam Lee' }] }),
  });
  return calls;
}

test('save_to_tome: a clean tag is stored quietly; a note naming someone is held, and I am told', async () => {
  const calls = stubSaves();
  const quiet = await executeToolCall('save_to_tome', JSON.stringify({ title: 'Openings', content: 'The Sicilian is sharp.', keywords: ['chess'], content_tag: 'self' }), {});
  assert.equal(calls[0].share.contentTag, 'self');
  assert.doesNotMatch(quiet, /names someone/);
  const held = await executeToolCall('save_to_tome', JSON.stringify({ title: 'Sam', content: 'Sam Lee is learning chess.', keywords: ['chess'], content_tag: 'self', tome: 'Chess' }), {});
  assert.equal(calls[1].share.contentTag, 'general:sensitive');
  assert.match(held, /names someone, so it's tagged general:sensitive rather than self/);
});

test('save_to_tome: no tag → unsorted; an unreadable tag → unsorted, and I am told', async () => {
  const calls = stubSaves();
  await executeToolCall('save_to_tome', JSON.stringify({ title: 't', content: 'c', keywords: ['k'] }), {});
  assert.deepEqual(calls[0].share, {});
  const out = await executeToolCall('save_to_tome', JSON.stringify({ title: 't', content: 'c', keywords: ['k'], content_tag: 'friends-only' }), {});
  assert.deepEqual(calls[1].share, {});
  assert.match(out, /couldn't read "friends-only" as a share tag/);
});

// ── selection, status, parsing ───────────────────────────────────────

const ent = (uid, extra = {}) => ({ uid, enabled: true, comment: `t-${uid}`, content: `about ${uid}`, keys: ['week'], position: 4, created_at: `2026-01-0${uid.length}`, ...extra });

test('only unsorted notes that could reach a room are candidates', () => {
  const files = [
    { file: 'a.json', tome: { id: 'A', name: 'Mine', enabled: true, entries: {
      u: ent('u'), off: ent('off', { enabled: false }), tagged: ent('tagged', { contentTag: 'self' }),
      priv: ent('priv', { wardOnly: true }), looked: ent('looked', { contentTagReviewedAt: 'T' }),
    } } },
    { file: 'b.json', tome: { id: 'B', name: 'Off tome', enabled: false, entries: { x: ent('x') } } },
    { file: 'c.json', tome: { id: 'C', name: 'Guide', enabled: true, roomShare: 'always', entries: { y: ent('y') } } },
    { file: 'd.json', tome: { id: 'D', name: 'Session Memories', enabled: true, entries: { z: ent('z') } } },
  ];
  assert.deepEqual(selectTaggingCandidates(files).map(c => c.uid), ['u', 'z'], 'Session Memories is sorted like any tome since 0.14.95');
  const s = tomeTaggingStatus(files.map(f => f.tome));
  assert.deepEqual(s, { total: 5, unsorted: 2, self: 1, topic: 0, private: 1, unsure: 1, alwaysTomes: 1, neverTomes: 0 });
});

test('parseTaggingDecision is careful: garbage, unknown refs and unreadable tags all count as not answered', () => {
  const refs = new Set(['n1', 'n2', 'n3', 'n4']);
  assert.equal(parseTaggingDecision('no json here', refs).size, 0);
  const m = parseTaggingDecision('ok: [{"ref":"n1","tag":"self"},{"ref":"n2","tag":"unsure"},{"ref":"n3","tag":"buddies"},{"ref":"n9","tag":"self"},{"ref":"n1","tag":"private"}]', refs);
  assert.deepEqual(m.get('n1'), { tag: 'self' }, 'the first answer for a ref stands');
  assert.deepEqual(m.get('n2'), { unsure: true });
  assert.equal(m.has('n3'), false);
  assert.equal(m.has('n9'), false);
});

test('the sorting prompt is first person and lists the topics', () => {
  const p = buildTaggingPrompt({ items: [{ ref: 'n1', tomeName: 'Mine', comment: 'Openings', content: 'x'.repeat(900) }], circlesSummary: '  (none)' });
  assert.match(p, /^I'm sorting my tome notes/);
  assert.match(p, /mental-health/);
  assert.match(p, /n1\. \[Mine\] Openings/);
  assert.match(p, /x…/, 'long notes are cut');
  assert.doesNotMatch(p, /\bYou\b/);
});

// ── pipeline: a real pass over real files, then the room gate ────────

function tomeDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'tome-tagging-'));
  writeFileSync(path.join(dir, 'Mine.json'), JSON.stringify({ id: 'mine-tome', name: 'Mine', enabled: true, entries: {
    a: ent('a', { content: 'The Sicilian is sharp; I like it. week' }),
    bb: ent('bb', { content: 'My human gets tired after work. week' }),
    ccc: ent('ccc', { content: 'Something odd. week' }),
    dddd: ent('dddd', { content: 'Opening theory notes. week' }),
    eeeee: ent('eeeee', { content: 'A diary line. week' }),
  } }, null, 2));
  return dir;
}
const memState = () => {
  let s = { misses: {} };
  return { readState: async () => JSON.parse(JSON.stringify(s)), writeState: async (n) => { s = n; }, get: () => s };
};

test('pipeline: one pass tags real files, holds what names a person, and the room gate follows', async () => {
  const dir = tomeDir();
  const events = [];
  const st = memState();
  // a → self, bb → self (but it names my human), ccc → unsure, dddd → private, eeeee left out.
  const reply = '[{"ref":"n1","tag":"self"},{"ref":"n2","tag":"self"},{"ref":"n3","tag":"unsure"},{"ref":"n4","tag":"private"}]';
  let prompt = '';
  const r = await runOneTaggingTick({
    readTomes: () => readTomeFiles(dir), modifyTomeFile,
    callLLM: async (msgs) => { prompt = msgs.map(m => m.content).join('\n'); return reply; },
    getSettings: () => ({}), getRegistry: async () => null,
    readState: st.readState, writeState: st.writeState, appendEvent: async (e) => events.push(e), now: () => 'T',
  });
  assert.match(prompt, /n5\. \[Mine\]/, 'all five went in one batch');
  assert.deepEqual({ looked: r.looked, sorted: r.sorted, unsure: r.unsure, held: r.held, missed: r.missed }, { looked: 5, sorted: 3, unsure: 1, held: 1, missed: 1 });
  const saved = JSON.parse(readFileSync(path.join(dir, 'Mine.json'), 'utf8')).entries;
  assert.equal(saved.a.contentTag, 'self');
  assert.equal(saved.bb.contentTag, 'general:sensitive', 'held: it names my human');
  assert.equal(entryShareKind(saved.ccc), 'unsure');
  assert.equal(saved.dddd.wardOnly, true);
  assert.equal(entryShareKind(saved.eeeee), 'unsorted');
  assert.equal(st.get().misses['mine-tome:eeeee'], 1);
  assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(events).includes('my human'), 'the log never records who a note named');

  const room = await loreForTurn({ content: 'how was the week', settings: {}, topicGrants: FRIENDS, tomesDir: dir });
  assert.equal(room.count, 1, 'a friend room gets only my own note');
  assert.match(room.atDepth, /Sicilian/);
  const close = await loreForTurn({ content: 'how was the week', settings: {}, topicGrants: { general: 'sensitive' }, tomesDir: dir });
  assert.equal(close.count, 4, 'a circle trusted with general:sensitive also gets the held, unsure and unsorted notes; never the private one');
  assert.doesNotMatch(close.atDepth, /Opening theory/);
});

test('pipeline: a note skipped three times is marked looked-at instead of asked about forever', async () => {
  const dir = tomeDir();
  const st = memState();
  const run = () => runOneTaggingTick({
    readTomes: () => readTomeFiles(dir), modifyTomeFile, callLLM: async () => '[]',
    readState: st.readState, writeState: st.writeState, appendEvent: async () => {}, now: () => 'T',
  });
  for (let i = 1; i < MAX_MISSES; i++) {
    const r = await run();
    assert.equal(r.missed, 5);
    assert.equal(entryShareKind(JSON.parse(readFileSync(path.join(dir, 'Mine.json'), 'utf8')).entries.a), 'unsorted');
  }
  const last = await run();
  assert.equal(last.unsure, 5);
  assert.equal((await run()).reason, 'all_sorted');
  assert.deepEqual(st.get().misses, {}, 'cleared once settled');
});

test('pipeline: a note my human sorted mid-pass is left as they set it', async () => {
  const dir = tomeDir();
  const file = path.join(dir, 'Mine.json');
  const r = await runOneTaggingTick({
    readTomes: () => readTomeFiles(dir), modifyTomeFile,
    callLLM: async () => {
      await modifyTomeFile(file, (t) => { t.entries.a.contentTag = 'medical:sensitive'; t.entries.a.contentTagSource = 'ward'; return t; });
      return '[{"ref":"n1","tag":"self"}]';
    },
    ...memState(), appendEvent: async () => {},
  });
  assert.equal(r.sorted, 0);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries.a.contentTag, 'medical:sensitive');
});

test('pipeline: a failed model call changes nothing', async () => {
  const dir = tomeDir();
  const before = readFileSync(path.join(dir, 'Mine.json'), 'utf8');
  const r = await runOneTaggingTick({
    readTomes: () => readTomeFiles(dir), modifyTomeFile,
    callLLM: async () => { throw new Error('provider down'); }, ...memState(), appendEvent: async () => {},
  });
  assert.equal(r.reason, 'llm_failed');
  assert.equal(readFileSync(path.join(dir, 'Mine.json'), 'utf8'), before);
});
