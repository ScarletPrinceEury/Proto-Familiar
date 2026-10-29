// Retired limits (known-issues A5): when the app fixes a limit a rule of mine
// may cover for, it tells me once, as a plain app note on my next live turn
// with my human. The app never touches my rules; letting one go is mine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { RETIRED_LIMITS, retiredLimitsNote, takeRetiredLimitsNote, __setRetiredLimitsPathsForTest } = await import('../src/self/retired-limits.js');
const { __setPhylacteryClientForTest, enrich } = await import('../thalamus.js');

// A store and a logs dir; `old` gives the install a conversation older than a day.
function store({ old }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-retired-'));
  const logsDir = path.join(dir, 'logs');
  mkdirSync(logsDir);
  const log = path.join(logsDir, 's-20261001-ab12.json');
  writeFileSync(log, '{}');
  if (old) { const t = (Date.now() - 3 * 86_400_000) / 1000; utimesSync(log, t, t); }
  return { file: path.join(dir, 'seen.json'), logsDir };
}

test('an install with history hears every limit once, then nothing', async () => {
  const s = store({ old: true });
  const first = await takeRetiredLimitsNote(s);
  assert.ok(first.startsWith('[App note (just this once): the app handles these now. If I keep a rule only to work around one of them, I can let it go.'));
  for (const l of RETIRED_LIMITS) assert.ok(first.includes(`· ${l.text}`), l.id);
  assert.equal(await takeRetiredLimitsNote(s), '');
});

test('a fresh install never had these limits: nothing now, only ones added later', async () => {
  const s = store({ old: false });
  assert.equal(await takeRetiredLimitsNote(s), '');
  const later = [...RETIRED_LIMITS, { id: 'new-one', version: '9.9.9', text: 'Something new works now.' }];
  assert.equal(await takeRetiredLimitsNote({ ...s, limits: later }), '[App note (just this once): the app handles these now. If I keep a rule only to work around one of them, I can let it go.\n· Something new works now.]');
  assert.equal(JSON.parse(readFileSync(s.file, 'utf8')).seen['new-one'] !== undefined, true);
});

test('every limit has an id, a version and one plain line; ids are unique', () => {
  const ids = new Set();
  for (const l of RETIRED_LIMITS) {
    assert.match(l.id, /^[a-z0-9-]+$/);
    assert.match(l.version, /^\d+\.\d+\.\d+$/);
    assert.ok(l.text.length > 10 && !/\bNOT\b|failure|mistake/.test(l.text), `${l.id} states a plain fact`);
    assert.ok(!ids.has(l.id)); ids.add(l.id);
  }
  assert.equal(retiredLimitsNote([]), '');
});

// ── Through enrich(), with a stub Phylactery ────────────────────────────────

beforeEach(() => {
  __setPhylacteryClientForTest({
    callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, items: [], results: [] }) }] }),
  });
});

test('pipeline: my live turn carries the note once; a gated room or a background call never does', async () => {
  const s = store({ old: true });
  __setRetiredLimitsPathsForTest(s);
  try {
    const room = await enrich('hello', { liveTurn: true, audience: 'friends', audiences: ['friends'], topicGrants: {} });
    assert.ok(!room.dynamic.includes('[App note (just this once)'), 'never in a gated room');
    const background = await enrich('hello', { liveTurn: false });
    assert.ok(!background.dynamic.includes('[App note (just this once)'), 'never on a background call');
    const mine = await enrich('hello', { liveTurn: true });
    assert.ok(mine.dynamic.includes('[App note (just this once)'), 'my own live turn shows it');
    const again = await enrich('hello', { liveTurn: true });
    assert.ok(!again.dynamic.includes('[App note (just this once)'), 'only once');
  } finally {
    __setRetiredLimitsPathsForTest(null);
  }
});
