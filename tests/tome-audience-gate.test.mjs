// Tome lore by room: the audience gate (0.14.63 #521 → 0.14.89 → content-aware 0.14.90).
//
// Tome lore skipped the audience gate memories go through: every enabled tome
// could fire into a villager DM or a guild channel by keyword — the ward's
// diagnosis constants (constant entries, so every turn) and Session Memories
// included. room-lore.js now gates lore for the room the way memories are gated:
// the ward's own room has all of it; a shared room gets the Familiar's own lore
// (`self`), whatever its grants cover by content tag, and nothing wardOnly or
// from a private tome. Entries are filtered BEFORE activation, so a hidden entry
// can't wake a visible one through recursion. Synthetic content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activateLore } from '../src/tomes/tome-lore.js';
import {
  tomesForRoom, entryReachesRoom, tomeRoomShare, tomeIsWardOnly, loreForTurn, placeRoomLore, TOME_SELF_TAG,
} from '../src/tomes/room-lore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// A friend's circle: everyday facts open, nothing medical.
const FRIENDS = { general: 'open', work: 'open' };
const OWN_ROOM = null;   // null = the ward's own room (the recall convention)

const e = (uid, extra = {}) => ({ uid, enabled: true, content: `entry ${uid} about the week`, position: 4, keys: ['week'], ...extra });
const tomes = () => ([
  { name: 'My own lore', enabled: true, entries: {
    mine:    e('mine', { contentTag: TOME_SELF_TAG }),
    workish: e('workish', { contentTag: 'work:open' }),
    medical: e('medical', { contentTag: 'medical:sensitive' }),
    untagged: e('untagged'),
    diag:    e('diag', { wardOnly: true, constant: true }),
  } },
  { name: 'Session Memories', enabled: true, entries: { s1: e('s1', { contentTag: TOME_SELF_TAG }) } },
  { name: 'Shared guide', enabled: true, roomShare: 'always', entries: { g1: e('g1'), g2: e('g2', { wardOnly: true }) } },
  { name: 'Kept close', enabled: true, roomShare: 'never', entries: { k1: e('k1', { contentTag: TOME_SELF_TAG }) } },
]);
const uids = (a) => ['sys_top', 'before_char', 'after_char', 'sys_bottom', 'at_depth'].flatMap(k => (a[k] ?? []).map(x => x.uid)).sort();
const activateIn = (topicGrants) => activateLore(tomesForRoom(tomes(), { topicGrants }), 'how was the week', { messages: [], opts: {}, env: {} });

test("the ward's own room has all of it", () => {
  assert.deepEqual(uids(activateIn(OWN_ROOM)), ['diag', 'g1', 'g2', 'k1', 'medical', 'mine', 's1', 'untagged', 'workish']);
});

test('a shared room gets my own lore and what its grants cover, nothing private', () => {
  assert.deepEqual(uids(activateIn(FRIENDS)), ['g1', 'mine', 'workish'],
    'self flows; work:open is granted; medical is not; untagged is unsure; wardOnly, Session Memories and a never-share tome stay out; an always-share tome comes along minus its wardOnly entry');
  assert.deepEqual(uids(activateIn({})), ['g1', 'mine'], 'a room with no grants still has me and the always-share tome');
});

test('the per-entry rule, one case at a time', () => {
  assert.equal(entryReachesRoom({ contentTag: 'medical:sensitive' }, { topicGrants: { medical: 'sensitive' } }), true, 'a circle trusted with it sees it');
  assert.equal(entryReachesRoom({}, { topicGrants: { general: 'sensitive' } }), true, 'untagged needs general:sensitive, as with memories');
  assert.equal(entryReachesRoom({}, { topicGrants: FRIENDS }), false);
  assert.equal(entryReachesRoom({ wardOnly: true }, { share: 'always', topicGrants: FRIENDS }), false, 'wardOnly beats always');
  assert.equal(tomeRoomShare({ name: 'Session Memories', roomShare: 'always' }), 'never', 'a private tome is never shared');
  assert.equal(tomeRoomShare({ roomShare: 'bogus' }), 'content');
  assert.equal(tomeIsWardOnly({ name: 'x', wardOnly: true }), true);
});

test("a hidden entry can't wake a visible one through recursion", () => {
  const t = [{ name: 'Chain', enabled: true, entries: {
    secret: { uid: 'secret', enabled: true, constant: true, content: 'mentions the garden', position: 4, contentTag: 'medical:sensitive' },
    garden: { uid: 'garden', enabled: true, content: 'garden notes', position: 4, keys: ['garden'], contentTag: TOME_SELF_TAG },
  } }];
  const opts = { messages: [], opts: { recursive: true }, env: {} };
  assert.deepEqual(uids(activateLore(tomesForRoom(t, { topicGrants: OWN_ROOM }), 'hello', opts)), ['garden', 'secret']);
  assert.deepEqual(uids(activateLore(tomesForRoom(t, { topicGrants: FRIENDS }), 'hello', opts)), [], 'the secret never ran, so it woke nothing');
});

test('pipeline: loreForTurn reads real files and gates them for the room; placeRoomLore puts it where web lore sits', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'room-lore-'));
  writeFileSync(path.join(dir, 'Mine-Tome.json'), JSON.stringify({ name: 'Mine', enabled: true, entries: {
    top: { uid: 'top', enabled: true, content: 'TOP {{char}}', position: 'sys_top', keys: ['week'], contentTag: TOME_SELF_TAG },
    deep: { uid: 'deep', enabled: true, content: 'DEEP', position: 4, keys: ['week'], contentTag: 'medical:sensitive' },
  } }));
  const settings = { charName: 'Synth' };
  const own = await loreForTurn({ content: 'the week', settings, topicGrants: OWN_ROOM, tomesDir: dir });
  assert.equal(own.count, 2);
  assert.match(own.lead, /TOP Synth/, 'macros resolve');
  const room = await loreForTurn({ content: 'the week', settings, topicGrants: FRIENDS, tomesDir: dir });
  assert.equal(room.count, 1);
  assert.equal(room.atDepth, '', 'the medical entry stays out');

  const placed = placeRoomLore([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }],
    { lead: 'LEAD', tail: 'TAIL', atDepth: 'DEPTH' });
  assert.equal(placed[0].content, 'LEAD\n\n---\n\nSYS\n\n---\n\nTAIL');
  assert.deepEqual(placed.slice(-2), [{ role: 'system', content: 'DEPTH' }, { role: 'user', content: 'c' }]);
});

// ── guards on the shipped tomes ──────────────────────────────────────────────

const CONDITION_TOMES = ['ADHD-Tome.json', 'Depression-Tome.json', 'Agoraphobia-Tome.json', 'OCD-Tome.json', 'Bipolar-Tome.json'];

test('every shipped condition-tome constant is tagged wardOnly (diagnosis never leaks)', async () => {
  for (const f of CONDITION_TOMES) {
    const tome = JSON.parse(await fs.readFile(path.join(REPO, 'tomes', f), 'utf8'));
    const constants = Object.values(tome.entries).filter(x => x.constant === true);
    assert.ok(constants.length > 0, `${f} should have a constant entry`);
    for (const x of constants) assert.equal(x.wardOnly, true, `${f} constant ${x.uid?.slice(0, 8)} must be wardOnly`);
  }
});

test("the shipped condition tomes keep the ward's decision: guidance shared, diagnosis held back", async () => {
  for (const f of CONDITION_TOMES) {
    const tome = JSON.parse(await fs.readFile(path.join(REPO, 'tomes', f), 'utf8'));
    assert.equal(tomeRoomShare(tome), 'always', `${f} guidance reaches shared rooms`);
    const shared = tomesForRoom([tome], { topicGrants: FRIENDS })[0];
    assert.ok(!Object.values(shared.entries).some(x => x.wardOnly), `${f} diagnosis stays out`);
    assert.ok(Object.keys(shared.entries).length > 0, `${f} guidance comes along`);
  }
});
