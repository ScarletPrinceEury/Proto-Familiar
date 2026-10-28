/**
 * Using items up (0.14.108). The pantry only ever grew: I had no way to take
 * something back off, so it kept food my human had already eaten and I offered
 * it to them. Covered here:
 *  - what I read back (quantities as "4 pcs", how long ago each item was noted)
 *    and what I hear after taking something off;
 *  - the memorization backstop: a "used" reading takes the item off, unless the
 *    live chat already did;
 *  - one run through the real Unruh child, through my own tool calls.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Point Unruh at a throwaway store BEFORE thalamus loads (it forwards the env
// into the spawn), so this never touches real data.
const tmp = mkdtempSync(path.join(tmpdir(), 'pf-pantry-'));
mkdirSync(path.join(tmp, 'unruh'), { recursive: true });
process.env.UNRUH_DB_PATH = path.join(tmp, 'unruh', 'unruh.db');

const { renderTrackerRead, formatTrackerValue, trackerUseResultText, executeToolCall } = await import('../cerebellum.js');
const { parseTrackerObservations, itemsTakenOffLive, processJob } = await import('../src/memory/memorization.js');
const thalamus = await import('../thalamus.js');

after(() => {
  try { thalamus.shutdownUnruh?.(); } catch { /* best-effort */ }
  try { thalamus.shutdownPhylactery?.(); } catch { /* best-effort */ }
  delete process.env.UNRUH_DB_PATH;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── What I read back ─────────────────────────────────────────────────────────

test('a quantity reads as "4 pcs", never "[object Object]"', () => {
  assert.equal(formatTrackerValue({ value: 4, unit: 'pcs' }), '4 pcs');
  assert.equal(formatTrackerValue({ value: 2 }), '2');
  assert.equal(formatTrackerValue(['a', 'b']), 'a/b');
  const out = renderTrackerRead({
    label: 'Pantry', archetype: 'inventory',
    items: [{ name: 'eggs', qty: { value: 4, unit: 'pcs' }, as_of: '2026-10-25T10:00:00' }],
  }, Date.parse('2026-10-28T10:00:00'));
  assert.doesNotMatch(out, /object Object/);
  assert.match(out, /· eggs — qty: 4 pcs \(noted 3 days ago\)/);
});

test('what I hear after taking something off', () => {
  const quiet = trackerUseResultText({ ok: true, removed: true, name: 'eggs' }, 'eggs');
  assert.equal(quiet.__okResult, true);
  assert.match(quiet.fullText, /Took eggs off the list/);
  assert.equal(trackerUseResultText({ ok: true, removed: false, name: 'eggs', left: { value: 4, unit: 'pcs' } }, 'eggs'), 'eggs: 4 pcs left.');
  const miss = trackerUseResultText({ ok: false, code: 'no_item', items: ['eggs', 'oat milk'] }, 'egg');
  assert.match(miss, /no "egg" on that list, so nothing came off/);
  assert.match(miss, /What's on it: eggs, oat milk/);
  assert.match(trackerUseResultText({ ok: false, code: 'cant_subtract', name: 'rice', error: 'rice is logged in bag, not g' }, 'rice'),
    /Couldn't take that much off rice: rice is logged in bag, not g\. Nothing changed/);
});

test('tracker_remove_item guards its args without reaching the store', async () => {
  assert.match(String(await executeToolCall('tracker_remove_item', '{}', {})), /tracker_id \(string\) is required/);
  assert.match(String(await executeToolCall('tracker_remove_item', JSON.stringify({ tracker_id: 'p' }), {})), /name \(string\) is required/);
  assert.match(String(await executeToolCall('tracker_remove_item', JSON.stringify({ tracker_id: 'p', name: 'eggs', amount: -2 }), {})),
    /amount should be a number above 0/);
});

// ── The memorization backstop ────────────────────────────────────────────────

test('a "used" reading parses; one without a name is dropped', () => {
  const out = parseTrackerObservations([
    { tracker_observations: [
      { tracker: 'pantry-x7', used: { name: 'eggs', amount: 2, unit: 'pcs' } },
      { tracker: 'pantry-x7', used: { name: 'yoghurt' } },
      { tracker: 'pantry-x7', used: { amount: 1 } },
      { tracker: 'ghost-z9', used: { name: 'eggs' } },
    ] },
  ], new Set(['pantry-x7']));
  assert.deepEqual(out, [
    { tracker: 'pantry-x7', used: { name: 'eggs', amount: 2, unit: 'pcs' } },
    { tracker: 'pantry-x7', used: { name: 'yoghurt' } },
  ]);
});

test('itemsTakenOffLive reads the slice\'s own tracker_remove_item calls', () => {
  const live = itemsTakenOffLive([
    { role: 'assistant', content: null, tool_calls: [
      { function: { name: 'tracker_remove_item', arguments: JSON.stringify({ tracker_id: 'pantry-x7', name: '  Eggs ' }) } },
      { function: { name: 'tracker_log', arguments: JSON.stringify({ tracker_id: 'pantry-x7', payload: { name: 'milk' } }) } },
      { function: { name: 'tracker_remove_item', arguments: 'not json' } },
    ] },
  ]);
  assert.deepEqual([...live], ['pantry-x7|eggs']);
});

function job(messages) {
  return {
    sessionId: 's-pantry-1', scope: 'session', topicId: 'topic-1', topicLabel: 'chat', messages,
    provider: 'nanogpt', apiKey: 'sk-test', model: 'm', baseUrl: null, audienceTag: 'ward-private',
  };
}

function deps(facts, { used, logged }) {
  return {
    callProvider: async () => ({ content: JSON.stringify({ facts, relations: [] }), finishReason: 'stop' }),
    getRegistry: async () => ({ villagers: [] }),
    getRememberMap: async () => null,
    getStandingConsent: async () => ({}),
    getScheduleWindow: async () => ({ nodes: [], linked: [] }),
    graphRelate: async () => ({ ok: true }),
    heldPromisesSince: async () => [], backPromises: async () => [],
    createMemoryFull: async () => ({ ok: true, id: 'mem-x' }),
    applyMemoryIntegrityGate: async ({ memoryArgs }) => ({ write: true, action: 'write', memoryArgs }),
    listTrackers: async () => ({ ok: true, trackers: [{ id: 'pantry-x7', label: 'Pantry', archetype: 'inventory', fields: ['name', 'qty'] }] }),
    logTrackerEntry: async (a) => { logged.push(a); return { ok: true, id: 'tke-1' }; },
    useTrackerItem: async (a) => { used.push(a); return { ok: true, id: 'tke-2', removed: true, name: a.name }; },
  };
}

const ATE = [{ content: 'My human ate two eggs and the yoghurt.', category: 'basics', confidence: 1.0, temporality: 'episodic',
  tracker_observations: [
    { tracker: 'pantry-x7', used: { name: 'eggs', amount: 2 } },
    { tracker: 'pantry-x7', used: { name: 'yoghurt' } },
  ] }];

test('pipeline: a "used" reading takes the item off as source:inferred', async () => {
  const used = [], logged = [];
  await processJob(job([
    { role: 'user', content: 'had two eggs and the last yoghurt for breakfast, long enough to memorize' },
    { role: 'assistant', content: 'good breakfast' },
  ]), deps(ATE, { used, logged }));
  assert.equal(logged.length, 0, 'nothing is added');
  assert.deepEqual(used.map(u => [u.name, u.amount, u.source]), [['eggs', 2, 'inferred'], ['yoghurt', undefined, 'inferred']]);
});

test('pipeline: an item the live chat already took off isn\'t taken off twice', async () => {
  const used = [], logged = [];
  await processJob(job([
    { role: 'user', content: 'had two eggs and the last yoghurt for breakfast, long enough to memorize' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'tracker_remove_item', arguments: JSON.stringify({ tracker_id: 'pantry-x7', name: 'eggs', amount: 2 }) } },
    ] },
    { role: 'tool', tool_call_id: 'c1', content: 'eggs: 4 left.' },
    { role: 'assistant', content: 'took the eggs off' },
  ]), deps(ATE, { used, logged }));
  assert.deepEqual(used.map(u => u.name), ['yoghurt'], 'only what the chat missed comes off');
});

// ── Through the real Unruh child ─────────────────────────────────────────────

let unruhUp = false;
before(async () => {
  await thalamus.startThalamus();
  const probe = await thalamus.listTrackers();
  unruhUp = !(probe && probe.ok === false && /not connected/i.test(probe.error ?? ''));
}, { timeout: 90_000 });

test('cross-process: log, use some, use the rest, ask for one that isn\'t there', { timeout: 90_000 }, async (t) => {
  if (!unruhUp) return t.skip('Unruh not connected (uv/venv absent)');
  const made = await thalamus.createTrackerFromTemplate({ template_id: 'pantry' });
  assert.equal(made.ok, true, made.error);
  const id = made.id;

  await executeToolCall('tracker_log', JSON.stringify({ tracker_id: id, payload: { name: 'eggs', qty: { value: 6, unit: 'pcs' } } }), {});
  await executeToolCall('tracker_log', JSON.stringify({ tracker_id: id, payload: { name: 'rice' } }), {});

  const some = String(await executeToolCall('tracker_remove_item', JSON.stringify({ tracker_id: id, name: 'Eggs', amount: 2 }), {}));
  assert.equal(some, 'eggs: 4 pcs left.');
  let read = String(await executeToolCall('tracker_read', JSON.stringify({ tracker_id: id }), {}));
  assert.match(read, /· eggs — qty: 4 pcs \(noted/);
  assert.doesNotMatch(read, /object Object/);

  const miss = String(await executeToolCall('tracker_remove_item', JSON.stringify({ tracker_id: id, name: 'egg' }), {}));
  assert.match(miss, /no "egg" on that list.*What's on it: eggs, rice/);

  const rest = String(await executeToolCall('tracker_remove_item', JSON.stringify({ tracker_id: id, name: 'eggs' }), {}));
  assert.match(rest, /^ok/, 'a full removal is a quiet ok');
  read = String(await executeToolCall('tracker_read', JSON.stringify({ tracker_id: id }), {}));
  assert.doesNotMatch(read, /eggs/, 'the eggs are off the list');
  assert.match(read, /rice/);

  // The Trackers tab's own source is accepted (it used to be refused).
  const ui = await thalamus.logTrackerEntry({ tracker_id: id, payload: { name: 'bread' }, source: 'ui' });
  assert.equal(ui.ok, true, ui.error);
});
