// read_tome (0.14.101): reading my own tomes on purpose. A quiet moment has no
// conversation to wake an entry by keyword, so before this a note I filed
// myself was out of reach there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { tomeEntries, entryAliases, findEntry, findTome, readTomeText, PAGE_SIZE, ENTRY_CHARS } from '../src/tomes/tome-reader.js';
import { readAllTomes } from '../src/tomes/tome-store.js';
import { initCerebellumTools, executeToolCall, composeNoticingTools, villagerToolNames } from '../cerebellum.js';
import { TOOL_MODULES } from '../tool-surfacing.js';

const entry = (uid, comment, content, extra = {}) => ({ uid, comment, content, keys: ['garden'], enabled: true, ...extra });
const WORKSHOP = {
  name: 'Garden notes',
  entries: {
    'a1b2c3d4-0000': entry('a1b2c3d4-0000', 'Tomato bed plan', 'Tomatoes go in the south bed this year.', { learnedAt: '2026-10-20T10:00:00Z' }),
    'a1ffeeee-1111': entry('a1ffeeee-1111', 'Tomato bed plan', 'Last spring: compost first, then manure in autumn.', { learnedAt: '2026-10-16T10:00:00Z' }),
    'b9b9b9b9-2222': entry('b9b9b9b9-2222', 'Watering schedule', 'Water the beds every second evening in July.', { learnedAt: '2026-10-22T10:00:00Z' }),
    'c0c0c0c0-3333': entry('c0c0c0c0-3333', 'Notes for {{user}}', 'Ask {{user}} about the seedlings.', { learnedAt: '2026-10-18T10:00:00Z' }),
  },
};
const MANUAL = { name: 'Familiar Manual', entries: { 0: { uid: 0, comment: 'Tomes / lorebook', content: 'My scan looks back over {{scanDepth}} messages.', keys: ['tome'] } } };

test('entries come newest first; undated ones keep file order after the dated', () => {
  const t = { entries: { x: entry('x', 'undated one', 'a'), y: entry('y', 'old', 'b', { learnedAt: '2026-01-01' }), z: entry('z', 'new', 'c', { learnedAt: '2026-02-01' }), w: entry('w', 'undated two', 'd') } };
  assert.deepEqual(tomeEntries(t).map(x => x.uid), ['z', 'y', 'x', 'w']);
});

test('aliases read as the title plus a short tail from the uid, stable, and distinct when titles repeat', () => {
  const list = tomeEntries(WORKSHOP);
  const a = entryAliases(list);
  assert.equal(a.get('b9b9b9b9-2222'), 'watering-schedule-b9');
  // Two entries share a title and their uid tails share "a1", so the tails grow until they differ.
  assert.equal(a.get('a1b2c3d4-0000'), 'tomato-bed-plan-a1b');
  assert.equal(a.get('a1ffeeee-1111'), 'tomato-bed-plan-a1f');
  assert.deepEqual([...entryAliases(tomeEntries(WORKSHOP))], [...a], 'the same aliases on every read');
  assert.equal(new Set(a.values()).size, list.length);
});

test('an entry is found by alias, uid, title, or an older shorter alias that still fits one entry', () => {
  const list = tomeEntries(WORKSHOP);
  const a = entryAliases(list);
  assert.equal(findEntry(list, a, 'watering-schedule-b9').hit.uid, 'b9b9b9b9-2222');
  assert.equal(findEntry(list, a, 'b9b9b9b9-2222').hit.uid, 'b9b9b9b9-2222');
  assert.equal(findEntry(list, a, 'watering schedule').hit.uid, 'b9b9b9b9-2222');
  assert.equal(findEntry(list, a, 'watering-schedule-b').hit.uid, 'b9b9b9b9-2222', 'an older alias from before the tail grew');
  const both = findEntry(list, a, 'Tomato bed plan');
  assert.equal(both.hit, null);
  assert.equal(both.matches.length, 2, 'a shared title is ambiguous, not a guess');
});

test('a tome is picked by exact name, or by part of a name when only one fits', () => {
  const all = [WORKSHOP, MANUAL, { name: 'Garden plans', entries: {} }];
  assert.equal(findTome(all, 'familiar manual').tome, MANUAL);
  assert.equal(findTome(all, 'notes').tome, WORKSHOP);
  assert.equal(findTome(all, 'garden').tome, null);
  assert.match(readTomeText(all, { tome: 'garden' }), /More than one tome fits "garden": Garden notes, Garden plans/);
  assert.match(readTomeText(all, { tome: 'recipes' }), /I don't keep a tome called "recipes"\. My tomes: Garden notes, Familiar Manual, Garden plans\./);
});

test('a listing shows ids, titles, sizes and dates, and points at reading one', () => {
  const out = readTomeText([WORKSHOP], { tome: 'Garden notes' });
  assert.match(out, /^Garden notes: 4 entries, newest first\./);
  assert.match(out, /- watering-schedule-b9 · "Watering schedule" · 44 chars · 2026-10-22 · keys: garden/);
  assert.match(out, /read_tome, this tome and its id as entry/);
});

test('a long tome lists in pages', () => {
  const entries = {};
  for (let i = 0; i < 60; i++) entries[`u${i}`] = entry(`u${i}`, `Thought ${i}`, 'x', { learnedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() });
  const big = { name: 'Ponderings', entries };
  const p1 = readTomeText([big], { tome: 'Ponderings' });
  assert.match(p1, /60 entries, newest first\. Page 1 of 3 \(1–25\)\./);
  assert.equal(p1.split('\n').filter(l => l.startsWith('- ')).length, PAGE_SIZE);
  assert.match(p1, /"Thought 59"/, 'newest first');
  assert.match(p1, /Page 2 has the next ones\./);
  const p3 = readTomeText([big], { tome: 'Ponderings', page: 3 });
  assert.equal(p3.split('\n').filter(l => l.startsWith('- ')).length, 10);
  assert.doesNotMatch(p3, /has the next ones/);
});

test('reading an entry gives the whole text with its facts', () => {
  const out = readTomeText([WORKSHOP], { tome: 'Garden notes', entry: 'watering-schedule-b9' });
  assert.match(out, /^"Watering schedule" \(watering-schedule-b9\) in Garden notes — saved 2026-10-22, 44 chars, keys: garden\./);
  assert.match(out, /Water the beds every second evening in July\.$/);
  assert.doesNotMatch(out, /The rest/);
});

test('a long entry comes in parts that join back into the whole text', () => {
  const words = Array.from({ length: 6000 }, (_, i) => `word${i}`).join(' ');
  const t = { name: 'Drafts', entries: { d: entry('d', 'Long draft', words) } };
  let from = 0, joined = '', parts = 0;
  while (parts < 20) {
    const out = readTomeText([t], { tome: 'Drafts', entry: 'long-draft-d', from });
    const body = out.split('\n\n').slice(1).join('\n\n').replace(/\n…\(The rest: read_tome with from: \d+\.\)$/, '');
    joined += body;
    parts++;
    const next = /from: (\d+)\.\)$/.exec(out);
    if (!next) break;
    assert.ok(body.length <= ENTRY_CHARS);
    from = Number(next[1]);
  }
  assert.ok(parts > 1, 'it really was cut');
  assert.equal(joined, words, 'nothing lost or repeated between parts');
  assert.match(readTomeText([t], { tome: 'Drafts', entry: 'long-draft-d', from: 999999 }), /That's past the end/);
});

test('search needs every word, shows a snippet, and can cover all tomes', () => {
  const all = [WORKSHOP, MANUAL];
  const inOne = readTomeText(all, { tome: 'notes', query: 'compost manure' });
  assert.match(inOne, /^1 entry in Garden notes with "compost manure":/);
  assert.match(inOne, /tomato-bed-plan-a1f/);
  assert.match(inOne, /\n {2}Last spring: compost first, then manure in autumn\./);
  assert.match(readTomeText(all, { tome: 'notes', query: 'compost sunshine' }), /Nothing in Garden notes has all of "compost sunshine"/);
  const across = readTomeText(all, { query: 'scan' });
  assert.match(across, /in Familiar Manual/);
  assert.match(readTomeText(all, {}), /I need a tome's name, or something to search for across all of them\. My tomes: Garden notes, Familiar Manual\./);
});

test('macros are filled in when I read, and a title or search can use the filled-in words', () => {
  const out = readTomeText([MANUAL], { tome: 'Familiar Manual', entry: 'Tomes / lorebook' }, { resolve: (s) => s.replace('{{scanDepth}}', '6') });
  assert.match(out, /My scan looks back over 6 messages\./);
  const named = { resolve: (s) => s.replace(/\{\{user\}\}/g, 'Sam') };
  assert.match(readTomeText([WORKSHOP], { tome: 'notes', entry: 'Notes for Sam' }, named), /Ask Sam about the seedlings\./);
  assert.match(readTomeText([WORKSHOP], { tome: 'notes', query: 'sam seedlings' }, named), /notes-for-user-c0 · "Notes for Sam"/);
});

function stubReadTomes(tomes) {
  initCerebellumTools({ readTomes: async () => tomes });
}

test('executor: only when it is just my human and me', async () => {
  stubReadTomes([WORKSHOP]);
  const out = await executeToolCall('read_tome', JSON.stringify({ tome: 'Garden notes' }), { wardPrivate: false });
  assert.match(out, /Someone else is here, so I won't open my tomes in full right now/);
  assert.doesNotMatch(out, /watering-schedule/);
});

test('executor: reads in a private turn and in a noticing turn, with {{user}} filled in', async () => {
  stubReadTomes([WORKSHOP]);
  const live = await executeToolCall('read_tome', JSON.stringify({ tome: 'Garden notes', entry: 'notes for {{user}}' }), { wardPrivate: true });
  assert.doesNotMatch(live, /\{\{user\}\}/);
  const quiet = await executeToolCall('read_tome', JSON.stringify({ tome: 'Garden notes', entry: 'watering-schedule-b9' }), { noticing: true, wardPrivate: true });
  assert.match(quiet, /Water the beds every second evening/);
});

test('read_tome is core, reaches noticing turns, and never a villager', () => {
  assert.equal(TOOL_MODULES.read_tome, 'core');
  const noticing = composeNoticingTools({}, { modules: [] }).map(t => t.function?.name);
  assert.ok(noticing.includes('read_tome'), 'a quiet moment can open a tome');
  const villager = villagerToolNames({ schedule: 'write', memories: 'write', contacts: 'write' });
  assert.ok(![...villager].includes('read_tome'));
});

test('PIPELINE: read_tome over real tome files on disk', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tome-reader-'));
  try {
    writeFileSync(path.join(dir, 'garden.json'), JSON.stringify(WORKSHOP));
    writeFileSync(path.join(dir, '.outbox.json'), JSON.stringify({ name: 'not a tome', entries: {} }));
    initCerebellumTools({ readTomes: () => readAllTomes(dir) });
    const listing = await executeToolCall('read_tome', JSON.stringify({ tome: 'notes' }), { wardPrivate: true });
    const id = /- (tomato-bed-plan-a1f) /.exec(listing)?.[1];
    assert.ok(id, 'the listing names the older tomato entry');
    const full = await executeToolCall('read_tome', JSON.stringify({ tome: 'notes', entry: id }), { wardPrivate: true });
    assert.match(full, /Last spring: compost first, then manure in autumn\./);
    assert.match(await executeToolCall('read_tome', JSON.stringify({ tome: 'not a tome' }), { wardPrivate: true }), /I don't keep a tome called/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
