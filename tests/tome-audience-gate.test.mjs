import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activateLore, filterByAudience, foldLoreForPrompt } from '../src/tomes/tome-lore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// A synthetic condition tome: a wardOnly diagnosis constant + an un-marked,
// actionable symptom entry. No private content — SYNTH stands in for the ward.
const synthTomes = () => ([{
  name: 'Synthetic Condition', enabled: true,
  entries: {
    diag:    { uid: 'diag',    constant: true, enabled: true, wardOnly: true,
               content: 'SYNTH has a condition.', position: 'sys_top', keys: [] },
    symptom: { uid: 'symptom', enabled: true,
               content: 'When SYNTH is tired: rest helps.', position: 4, keys: ['tired'] },
  },
}]);

// ── filterByAudience unit ─────────────────────────────────────────────────────

test('filterByAudience drops wardOnly entries on a non-ward turn, keeps them for the ward', () => {
  const activated = { sys_top: [{ uid: 'a', wardOnly: true }], at_depth: [{ uid: 'b' }] };
  const villager = filterByAudience(activated, { wardPrivate: false });
  assert.deepEqual(villager.sys_top.map(e => e.uid), [], 'wardOnly dropped for a villager');
  assert.deepEqual(villager.at_depth.map(e => e.uid), ['b'], 'unmarked entry kept');

  const ward = filterByAudience(activated, { wardPrivate: true });
  assert.deepEqual(ward.sys_top.map(e => e.uid), ['a'], 'ward sees the wardOnly entry');
});

test('filterByAudience does not mutate its input', () => {
  const activated = { sys_top: [{ uid: 'a', wardOnly: true }] };
  filterByAudience(activated, { wardPrivate: false });
  assert.equal(activated.sys_top.length, 1, 'original slot untouched');
});

// ── pipeline through the real engine ─────────────────────────────────────────

test('pipeline: a villager turn gets the symptom entry but NOT the diagnosis constant', () => {
  const activated = activateLore(synthTomes(), 'i am so tired', { messages: [], opts: {}, env: {} });
  const gated = filterByAudience(activated, { wardPrivate: false });
  const folded = foldLoreForPrompt(gated);
  const all = `${folded.lead}\n${folded.tail}\n${folded.atDepth}`;
  assert.ok(!all.includes('has a condition'), 'the diagnosis constant must not reach a villager turn');
  assert.ok(all.includes('rest helps'), 'the actionable symptom entry still injects');
});

test('pipeline: a ward-private turn gets both the diagnosis constant and the symptom entry', () => {
  const activated = activateLore(synthTomes(), 'i am so tired', { messages: [], opts: {}, env: {} });
  const gated = filterByAudience(activated, { wardPrivate: true });
  const folded = foldLoreForPrompt(gated);
  const all = `${folded.lead}\n${folded.tail}\n${folded.atDepth}`;
  assert.ok(all.includes('has a condition'), 'the ward sees their own diagnosis context');
  assert.ok(all.includes('rest helps'), 'and the symptom entry');
});

// ── guard: the shipped condition constants stay tagged (survives the §4 rewrite) ──

test('every shipped condition-tome constant is tagged wardOnly (diagnosis never leaks)', async () => {
  const files = ['ADHD-Tome.json', 'Depression-Tome.json', 'Agoraphobia-Tome.json', 'OCD-Tome.json', 'Bipolar-Tome.json'];
  for (const f of files) {
    const tome = JSON.parse(await fs.readFile(path.join(REPO, 'tomes', f), 'utf8'));
    const constants = Object.values(tome.entries).filter(e => e.constant === true);
    assert.ok(constants.length > 0, `${f} should have a constant entry`);
    for (const e of constants) {
      assert.equal(e.wardOnly, true, `${f} constant ${e.uid?.slice(0, 8)} must be wardOnly`);
    }
  }
});

// ── whole private tomes (0.14.89) ────────────────────────────────────────────
// Session Memories holds summaries of the ward's own conversations: no entry of
// it belongs in a shared room, tagged or not. A tome marked wardOnly behaves the
// same. Other tomes are untouched.
import { tomeIsWardOnly } from '../src/tomes/tome-lore.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { extractFunctionSource } from './_vm-extract.mjs';

const roomTomes = () => ([
  { name: 'Session Memories', enabled: true, entries: {
    s1: { uid: 's1', enabled: true, content: 'We talked about the hard week.', position: 4, keys: ['week'] } } },
  { name: 'Private Notes', enabled: true, wardOnly: true, entries: {
    p1: { uid: 'p1', enabled: true, content: 'A private note about the week.', position: 4, keys: ['week'] } } },
  { name: 'Essay workshop', enabled: true, entries: {
    e1: { uid: 'e1', enabled: true, content: 'Essay plan for the week.', position: 4, keys: ['week'] } } },
]);
const uids = (a) => ['sys_top', 'before_char', 'after_char', 'sys_bottom', 'at_depth'].flatMap(k => (a[k] ?? []).map(e => e.uid)).sort();

test('a whole private tome stays out of a shared room and stays in for the ward', () => {
  const activated = activateLore(roomTomes(), 'how was the week', { messages: [], opts: {}, env: {} });
  assert.deepEqual(uids(filterByAudience(activated, { wardPrivate: false })), ['e1'], 'only the shareable tome reaches the room');
  assert.deepEqual(uids(filterByAudience(activated, { wardPrivate: true })), ['e1', 'p1', 's1'], 'the ward has all of it');
  assert.equal(tomeIsWardOnly({ name: 'Session Memories' }), true);
  assert.equal(tomeIsWardOnly({ name: 'Essay workshop' }), false);
});

test('the browser engine makes the same calls as the server engine (hand-maintained parity)', () => {
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const ctx = {};
  runInNewContext(`${extractFunctionSource(src, 'tomeIsWardOnly')}\n${extractFunctionSource(src, 'filterLoreByAudience')}\nresult = { tomeIsWardOnly, filterLoreByAudience };`, ctx);
  const web = ctx.result;
  for (const t of [{ name: 'Session Memories' }, { name: 'x', wardOnly: true }, { name: 'Essay workshop' }, {}]) {
    assert.equal(web.tomeIsWardOnly(t), tomeIsWardOnly(t), JSON.stringify(t));
  }
  const activated = activateLore(roomTomes(), 'how was the week', { messages: [], opts: {}, env: {} });
  for (const wardPrivate of [true, false]) {
    assert.deepEqual(uids(web.filterLoreByAudience(activated, { wardPrivate })), uids(filterByAudience(activated, { wardPrivate })));
  }
});
