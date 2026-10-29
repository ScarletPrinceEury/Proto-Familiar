// I can change or take out a tome entry, and my human can undo it (A4).
// Before: I could add to a tome and read it, but a wrong note stayed wrong.
// Every edit and delete is logged first (tomes/.tome-edits.jsonl) so the Tomes
// window can put it back; the app's own manual refuses; an edit re-checks the
// entry's share tag. Run against temp tome files, and through my own tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { editTomeEntry, deleteTomeEntry, listTomeEdits, restoreTomeEdit } from '../src/tomes/tome-edits.js';
import { executeToolCall, initCerebellumTools } from '../cerebellum.js';

const entry = (uid, comment, content, extra = {}) => ({ uid, comment, content, keys: ['k'], enabled: true, ...extra });

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-tome-edits-'));
  const notes = path.join(dir, 'notes.json');
  writeFileSync(notes, JSON.stringify({ id: 'notes-a1', name: 'My Notes', entries: {
    'u-moths': entry('u-moths', 'Moths', 'Moths fly at night.', { graduationReviewedAt: '2026-10-01T00:00:00Z' }),
    'u-sorted': entry('u-sorted', 'Tea', 'Likes tea.', { contentTag: 'general:open', contentTagSource: 'review' }),
    'u-mine': entry('u-mine', 'Garden', 'The garden is wild.', { contentTag: 'family:open', contentTagSource: 'familiar' }),
    'u-ward': entry('u-ward', 'Rule', 'Keep it short.', { contentTag: 'general:open', contentTagSource: 'ward' }),
  } }));
  writeFileSync(path.join(dir, 'manual.json'), JSON.stringify({ id: 'familiar-manual', name: 'Familiar Manual', graduationExempt: true, entries: {
    'm-1': entry('m-1', 'Manual: Tomes', 'How tomes work.'),
  } }));
  const editsFile = path.join(dir, '.tome-edits.jsonl');
  const modify = async (file, fn) => {
    const t = JSON.parse(readFileSync(file, 'utf8'));
    const next = (await fn(t)) ?? t;
    writeFileSync(file, JSON.stringify(next));
    return next;
  };
  const read = () => JSON.parse(readFileSync(notes, 'utf8')).entries;
  return { dir, editsFile, modify, read, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('an edit changes the entry, logs the old one, and clears the graduation mark', async () => {
  const t = setup();
  try {
    const r = await editTomeEntry({ tomesDir: t.dir, editsFile: t.editsFile, modify: t.modify, tome: 'My Notes', entry: 'Moths', content: 'Moths fly at night and love lamps.', keywords: ['moth', 'lamp'] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.changed, ['content', 'keys']);
    const e = t.read()['u-moths'];
    assert.equal(e.content, 'Moths fly at night and love lamps.');
    assert.deepEqual(e.keys, ['moth', 'lamp']);
    assert.equal(e.graduationReviewedAt, undefined, 'new content gets judged again');
    const [logged] = await listTomeEdits({ editsFile: t.editsFile });
    assert.equal(logged.action, 'edit');
    assert.equal(logged.before.content, 'Moths fly at night.');
  } finally { t.done(); }
});

test('an edit re-checks the share tag: the sorting pass\'s is cleared, mine is held if it names someone, my human\'s stays', async () => {
  const t = setup();
  try {
    const base = { tomesDir: t.dir, editsFile: t.editsFile, modify: t.modify, tome: 'My Notes' };
    await editTomeEntry({ ...base, entry: 'Tea', content: 'Likes tea, green.' });
    assert.equal(t.read()['u-sorted'].contentTag, undefined, 'back to unsorted, so it gets sorted again');
    const held = await editTomeEntry({ ...base, entry: 'Garden', content: 'Sam planted the garden.', people: ['Sam'] });
    assert.equal(held.heldBy, 'Sam');
    assert.equal(t.read()['u-mine'].contentTag, 'family:sensitive');
    await editTomeEntry({ ...base, entry: 'Rule', content: 'Sam says keep it short.', people: ['Sam'] });
    assert.equal(t.read()['u-ward'].contentTag, 'general:open', 'a tag my human set is theirs');
  } finally { t.done(); }
});

test('the manual refuses, and a missing or vague name says what to do', async () => {
  const t = setup();
  try {
    const base = { tomesDir: t.dir, editsFile: t.editsFile, modify: t.modify };
    assert.equal((await editTomeEntry({ ...base, tome: 'Familiar Manual', entry: 'Manual: Tomes', content: 'x' })).code, 'protected');
    assert.equal((await deleteTomeEntry({ ...base, tome: 'Familiar Manual', entry: 'Manual: Tomes' })).code, 'protected');
    assert.match((await editTomeEntry({ ...base, tome: 'Nope', entry: 'x', content: 'y' })).text, /There's no tome called "Nope"\. list_tomes shows them\./);
    assert.match((await editTomeEntry({ ...base, tome: 'My Notes', entry: 'Owls', content: 'y' })).text, /There's no entry "Owls" in My Notes\. read_tome shows what's in it\./);
    assert.equal((await editTomeEntry({ ...base, tome: 'My Notes', entry: 'Moths' })).code, 'nothing');
    assert.equal((await editTomeEntry({ ...base, tome: 'My Notes', entry: 'Moths', content: '  ' })).code, 'empty');
    assert.deepEqual(await listTomeEdits({ editsFile: t.editsFile }), [], 'refusals log nothing');
  } finally { t.done(); }
});

test('a delete takes it out, and Restore puts it back once', async () => {
  const t = setup();
  try {
    const base = { tomesDir: t.dir, editsFile: t.editsFile, modify: t.modify };
    const d = await deleteTomeEntry({ ...base, tome: 'My Notes', entry: 'Moths' });
    assert.equal(d.ok, true);
    assert.equal(t.read()['u-moths'], undefined);
    const r = await restoreTomeEdit({ ...base, id: d.record.id });
    assert.equal(r.ok, true);
    assert.equal(t.read()['u-moths'].content, 'Moths fly at night.');
    assert.equal((await restoreTomeEdit({ ...base, id: d.record.id })).code, 'already');
    const [listed] = await listTomeEdits({ editsFile: t.editsFile });
    assert.ok(listed.restoredAt);
  } finally { t.done(); }
});

test('restoring an edit that was edited again says so', async () => {
  const t = setup();
  try {
    const base = { tomesDir: t.dir, editsFile: t.editsFile, modify: t.modify, tome: 'My Notes', entry: 'Moths' };
    const first = await editTomeEntry({ ...base, content: 'one' });
    await editTomeEntry({ ...base, content: 'two' });
    const r = await restoreTomeEdit({ tomesDir: t.dir, editsFile: t.editsFile, modify: t.modify, id: first.record.id });
    assert.equal(r.changedSince, true);
    assert.equal(t.read()['u-moths'].content, 'Moths fly at night.');
  } finally { t.done(); }
});

test('through my own tools: edit and delete in our room, refused when someone else is here', async () => {
  const t = setup();
  try {
    initCerebellumTools({
      editTomeEntry: (a) => editTomeEntry({ ...a, tomesDir: t.dir, editsFile: t.editsFile, modify: t.modify }),
      deleteTomeEntry: (a) => deleteTomeEntry({ ...a, tomesDir: t.dir, editsFile: t.editsFile, modify: t.modify }),
      getVillageRegistry: async () => ({ villagers: [] }),
    });
    const edited = String(await executeToolCall('edit_tome_entry', JSON.stringify({ tome: 'My Notes', entry: 'Moths', title: 'Night moths' }), {}));
    assert.match(edited, /^ok: Changed the title of "Night moths" in My Notes\. The old version is kept; .+ can put it back from the Tomes window\./);
    const shared = String(await executeToolCall('delete_tome_entry', JSON.stringify({ tome: 'My Notes', entry: 'Night moths' }), { wardPrivate: false }));
    assert.match(shared, /^Someone else is here/);
    assert.ok(t.read()['u-moths'], 'nothing deleted in a shared room');
    const deleted = String(await executeToolCall('delete_tome_entry', JSON.stringify({ tome: 'My Notes', entry: 'Night moths' }), {}));
    assert.match(deleted, /^ok: Took "Night moths" out of My Notes\. A copy is kept;/);
    assert.equal(t.read()['u-moths'], undefined);
  } finally { t.done(); }
});

test('a share tag the checker can\'t read is left as it was, not cleared', async () => {
  const t = setup();
  try {
    const notes = path.join(t.dir, 'notes.json');
    const tome = JSON.parse(readFileSync(notes, 'utf8'));
    tome.entries['u-odd'] = entry('u-odd', 'Odd', 'Old text.', { contentTag: 'not-a-topic:open', contentTagSource: 'familiar' });
    writeFileSync(notes, JSON.stringify(tome));
    await editTomeEntry({ tomesDir: t.dir, editsFile: t.editsFile, modify: t.modify, tome: 'My Notes', entry: 'Odd', content: 'Sam said so.', people: ['sam'] });
    assert.equal(t.read()['u-odd'].contentTag, 'not-a-topic:open');
  } finally { t.done(); }
});
