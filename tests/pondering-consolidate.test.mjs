// Pondering consolidation (2026-09): fold a past month of ponderings into one
// digest, prune the originals — but never a pondering that still holds an
// unacted deferred intent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { mkdtempSync, rmSync, promises as fsp } from 'fs';

import {
  selectConsolidationTarget, parseDigest, consolidatePonderings, restorePonderingConsolidation,
  buildConsolidationPrompt, MIN_PONDERINGS_PER_MONTH,
} from '../src/pondering/pondering-consolidate.js';
import { findOrCreatePonderingsTome } from '../src/pondering/pondering.js';
import { modifyTomeFile } from '../thalamus.js';

// ── pure: selectConsolidationTarget ──────────────────────────────────────────
function pondering(created_at, extra = {}) {
  return { uid: extra.uid, scope: 'pondering', comment: 'c', content: 'body', created_at, ...extra };
}
function entriesFrom(list) {
  const m = {};
  list.forEach((e, i) => { const uid = e.uid ?? `u${i}`; m[uid] = { ...e, uid }; });
  return m;
}

const NOW = new Date('2026-09-17T12:00:00Z');

test('selectConsolidationTarget: picks the OLDEST past month with ≥min eligible', () => {
  const entries = entriesFrom([
    pondering('2026-07-01'), pondering('2026-07-10'), pondering('2026-07-20'),  // July: 3
    pondering('2026-08-05'), pondering('2026-08-06'), pondering('2026-08-07'),  // Aug: 3
  ]);
  const t = selectConsolidationTarget(entries, { now: NOW });
  assert.equal(t.monthPrefix, '2026-07', 'oldest first');
  assert.equal(t.label, 'July 2026');
  assert.equal(t.uids.length, 3);
});

test('selectConsolidationTarget: the current (still-filling) month is never eligible', () => {
  const entries = entriesFrom([
    pondering('2026-09-01'), pondering('2026-09-02'), pondering('2026-09-03'),
  ]);
  assert.equal(selectConsolidationTarget(entries, { now: NOW }), null);
});

test('selectConsolidationTarget: below the minimum → null', () => {
  const entries = entriesFrom([pondering('2026-07-01'), pondering('2026-07-02')]);   // only 2
  assert.equal(selectConsolidationTarget(entries, { now: NOW }), null);
  assert.equal(MIN_PONDERINGS_PER_MONTH, 3);
});

test('selectConsolidationTarget: excludes reflections, digests, and pending-intent ponderings', () => {
  const entries = entriesFrom([
    pondering('2026-07-01'),
    pondering('2026-07-02'),
    { uid: 'r', scope: 'reflection', created_at: '2026-07-03' },
    { uid: 'd', scope: 'pondering-digest', created_at: '2026-07-04' },
    pondering('2026-07-05', { uid: 'pending', wants_to_save: [{ kind: 'tell', acted_on: false }] }),
  ]);
  // Only 2 real eligible ponderings (the reflection, digest, and pending one don't count).
  assert.equal(selectConsolidationTarget(entries, { now: NOW }), null);
});

// ── pure: buildConsolidationPrompt anchors identity (frame-break regression) ──
test('buildConsolidationPrompt: opens in the Familiar\'s own voice, not as a handed-in task', () => {
  const p = buildConsolidationPrompt('July 2026', [
    { comment: 'On the quiet', content: 'I keep circling what the silence is.' },
  ]);
  // Identity anchor up front — the same lever buildPonderPrompt uses so the model
  // stays in-character instead of interrogating a "roleplay a digest" request.
  assert.match(p, /^I'm \{\{char\}\}\./, 'must open with the {{char}} identity anchor');
  assert.match(p, /my own journal pages/i, 'frames the notes as MINE, not presented material');
  assert.match(p, /I keep circling what the silence is\./, 'includes the note bodies');
  // The self-doubt entries are part of the month, not something to relitigate now.
  assert.match(p, /second-guessing|belongs in the digest/i);
  // Never the presenting-material framing that caused the derail.
  assert.doesNotMatch(p, /These are my own pondering notes from back then/);
  // The stilted "turning over" wording is purged (ward-directed, x3).
  assert.doesNotMatch(p, /turning over/i);
});

// ── pure: parseDigest — STRICT (gates a destructive prune) ───────────────────
test('parseDigest: accepts only a complete JSON object with a digest', () => {
  assert.equal(parseDigest('{"digest": "the gist"}'), 'the gist');
  assert.equal(parseDigest('```json\n{"digest":"x"}\n```'), 'x');
  assert.equal(parseDigest(''), null);
  assert.equal(parseDigest('   '), null);
});

test('parseDigest: a TRUNCATED digest returns null — never a partial store (the data-loss guard)', () => {
  // finish_reason='length' cuts the JSON mid-string: unterminated → refuse.
  assert.equal(parseDigest('{"digest": "June was mostly about the Unruh effect and Eur'), null);
  assert.equal(parseDigest('{"digest": "half a thought'), null);
  // Bare prose with no envelope is no longer accepted for this destructive path.
  assert.equal(parseDigest('just prose, no envelope'), null);
  assert.equal(parseDigest('{"digest": ""}'), null, 'empty digest → null');
});

// ── orchestration: consolidatePonderings over a temp tome ────────────────────
function tempTomesDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ponder-consol-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function seed(dir, entries) {
  const { file } = await findOrCreatePonderingsTome(dir);
  await modifyTomeFile(file, (fresh) => { fresh.entries = entries; return fresh; });
  return file;
}
const readEntries = async (file) => JSON.parse(await fsp.readFile(file, 'utf8')).entries;

test('consolidatePonderings: digests a past month, prunes its ponderings, keeps a pending-intent one', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const file = await seed(dir, entriesFrom([
      pondering('2026-07-01', { uid: 'jul1' }),
      pondering('2026-07-10', { uid: 'jul2' }),
      pondering('2026-07-20', { uid: 'jul3' }),
      pondering('2026-07-25', { uid: 'julPending', wants_to_save: [{ kind: 'tell', acted_on: false }] }),
      pondering('2026-09-05', { uid: 'sep1' }),
    ]));
    const res = await consolidatePonderings({
      tomesDir: dir, provider: 'x', apiKey: 'k', model: 'm', now: NOW,
      callLLM: async () => JSON.stringify({ digest: 'I kept circling back to the same question in July.' }),
    });
    assert.equal(res.monthPrefix, '2026-07');
    assert.equal(res.count, 3);

    const after = await readEntries(file);
    // The 3 plain July ponderings are gone.
    assert.equal(after.jul1, undefined);
    assert.equal(after.jul2, undefined);
    assert.equal(after.jul3, undefined);
    // The pending-intent July one and the current-month one survive.
    assert.ok(after.julPending, 'a pondering with an unacted intent is never pruned');
    assert.ok(after.sep1, 'the current month is untouched');
    // A digest entry now exists: right scope, not injected, carries the month.
    const digest = Object.values(after).find(e => e.scope === 'pondering-digest');
    assert.ok(digest, 'digest written');
    assert.equal(digest.enabled, false, 'a digest is an artifact, never auto-injected');
    assert.equal(digest.consolidated_month, '2026-07');
    assert.equal(digest.consolidated_count, 3);
    assert.match(digest.content, /circling back/);
    assert.match(digest.comment, /July 2026/);
  } finally { cleanup(); }
});

test('consolidatePonderings: nothing eligible → null, tome untouched', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const file = await seed(dir, entriesFrom([pondering('2026-09-01'), pondering('2026-09-02')]));
    const before = JSON.stringify(await readEntries(file));
    const res = await consolidatePonderings({
      tomesDir: dir, provider: 'x', apiKey: 'k', model: 'm', now: NOW,
      callLLM: async () => { throw new Error('should not be called'); },
    });
    assert.equal(res, null);
    assert.equal(JSON.stringify(await readEntries(file)), before, 'untouched');
  } finally { cleanup(); }
});

test('consolidatePonderings: an LLM failure prunes nothing (month stays eligible for next tick)', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const file = await seed(dir, entriesFrom([
      pondering('2026-07-01', { uid: 'a' }), pondering('2026-07-02', { uid: 'b' }), pondering('2026-07-03', { uid: 'c' }),
    ]));
    const res = await consolidatePonderings({
      tomesDir: dir, provider: 'x', apiKey: 'k', model: 'm', now: NOW,
      callLLM: async () => { throw new Error('provider down'); },
    });
    assert.equal(res, null);
    const after = await readEntries(file);
    assert.ok(after.a && after.b && after.c, 'sources survive a failed digest');
    assert.equal(Object.values(after).some(e => e.scope === 'pondering-digest'), false, 'no digest written');
  } finally { cleanup(); }
});

// ── archive-before-delete + restore (the reversibility the data loss demanded) ─
test('a fold archives the originals, and restore puts them back and drops the digest', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const file = await seed(dir, entriesFrom([
      pondering('2026-07-01', { uid: 'jul1', content: 'the Unruh thought' }),
      pondering('2026-07-10', { uid: 'jul2', content: 'about Eury' }),
      pondering('2026-07-20', { uid: 'jul3', content: 'the cheese one' }),
    ]));
    const res = await consolidatePonderings({
      tomesDir: dir, provider: 'x', apiKey: 'k', model: 'm', now: NOW,
      callLLM: async () => JSON.stringify({ digest: 'July digest.' }),
    });
    assert.equal(res.count, 3);
    let after = await readEntries(file);
    assert.equal(after.jul1, undefined, 'originals pruned after fold');
    const digestUid = Object.keys(after).find(u => after[u].scope === 'pondering-digest');
    assert.ok(digestUid);

    // Undo it.
    const r = await restorePonderingConsolidation({ tomesDir: dir });
    assert.equal(r.restored, 3);
    assert.equal(r.monthPrefix, '2026-07');
    after = await readEntries(file);
    assert.ok(after.jul1 && after.jul2 && after.jul3, 'all three originals restored, verbatim');
    assert.equal(after.jul1.content, 'the Unruh thought');
    assert.equal(after[digestUid], undefined, 'the digest is gone — the fold is undone');
  } finally { cleanup(); }
});

test('restore with nothing archived → {restored:0}, never throws', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    await seed(dir, entriesFrom([pondering('2026-09-01')]));
    const r = await restorePonderingConsolidation({ tomesDir: dir });
    assert.equal(r, null);
  } finally { cleanup(); }
});

test('a fold whose digest came back TRUNCATED prunes nothing (originals survive)', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const file = await seed(dir, entriesFrom([
      pondering('2026-07-01', { uid: 'a' }), pondering('2026-07-02', { uid: 'b' }), pondering('2026-07-03', { uid: 'c' }),
    ]));
    const res = await consolidatePonderings({
      tomesDir: dir, provider: 'x', apiKey: 'k', model: 'm', now: NOW,
      callLLM: async () => '{"digest": "cut off mid-sen',   // finish_reason=length shape
    });
    assert.equal(res, null, 'truncated digest → refuse the fold');
    const after = await readEntries(file);
    assert.ok(after.a && after.b && after.c, 'originals untouched');
    assert.equal(Object.values(after).some(e => e.scope === 'pondering-digest'), false, 'no digest stored');
  } finally { cleanup(); }
});
