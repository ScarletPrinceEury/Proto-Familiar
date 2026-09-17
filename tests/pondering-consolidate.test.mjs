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
  consolidateYearlyPonderings, buildYearbookPrompt, MIN_DIGESTS_PER_YEAR,
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

// ── YEARLY tier: fold a completed past year of month-digests into a yearbook ──
// A month-digest as the monthly tier writes it: enabled:false, scope
// 'pondering-digest', carrying the month it summarises in `consolidated_month`.
function monthDigest(consolidated_month, extra = {}) {
  return {
    uid: extra.uid, scope: 'pondering-digest',
    comment: `What I was thinking about in ${consolidated_month}`,
    content: `my digest of ${consolidated_month}`,
    created_at: `${consolidated_month}-28T00:00:00.000Z`,
    consolidated_month, consolidated_count: 3, enabled: false,
    ...extra,
  };
}

test('buildYearbookPrompt: opens in the Familiar\'s own voice over its own already-distilled digests', () => {
  const p = buildYearbookPrompt('2025', [
    monthDigest('2025-03'), monthDigest('2025-08'),
  ]);
  assert.match(p, /^I'm \{\{char\}\}/, 'first-person self-anchor, not a handed-in task (frame-break guard)');
  assert.match(p, /already folded each month/, 'frames the notes as its own prior digests');
  assert.match(p, /"digest":/, 'reuses the same JSON envelope parseDigest expects');
  assert.doesNotMatch(p, /turning over/i, 'no stilted "turning over" phrasing');
});

test('MIN_DIGESTS_PER_YEAR is 2 (a sparse past year still folds, a single digest does not)', () => {
  assert.equal(MIN_DIGESTS_PER_YEAR, 2);
});

test('consolidateYearlyPonderings: folds a completed past year of month-digests into a yearbook, leaves the current year', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const file = await seed(dir, entriesFrom([
      monthDigest('2025-03', { uid: 'd1' }),
      monthDigest('2025-07', { uid: 'd2' }),
      monthDigest('2025-11', { uid: 'd3' }),
      monthDigest('2026-01', { uid: 'cur' }),   // current year — never folded (2026 not yet complete)
    ]));
    const res = await consolidateYearlyPonderings({
      tomesDir: dir, provider: 'x', apiKey: 'k', model: 'm', now: NOW,
      callLLM: async () => JSON.stringify({ digest: '2025 was the year I kept circling the same few questions.' }),
    });
    assert.equal(res.year, '2025');
    assert.equal(res.count, 3);

    const after = await readEntries(file);
    assert.equal(after.d1, undefined);
    assert.equal(after.d2, undefined);
    assert.equal(after.d3, undefined);
    assert.ok(after.cur, 'the current year’s digest is untouched');
    const yb = Object.values(after).find(e => e.scope === 'pondering-yearbook');
    assert.ok(yb, 'yearbook written');
    assert.equal(yb.enabled, false, 'a yearbook is an artifact, never auto-injected');
    assert.equal(yb.consolidated_year, '2025');
    assert.equal(yb.consolidated_count, 3);
    assert.match(yb.comment, /2025/);
    assert.match(yb.content, /circling/);
  } finally { cleanup(); }
});

test('consolidateYearlyPonderings: a digest folded LATE (created_at a later year) still yearbooks by its content year', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    // Both digests summarise 2024 months but were folded in mid-2026 (bulk import).
    const file = await seed(dir, entriesFrom([
      monthDigest('2024-04', { uid: 'a', created_at: '2026-05-01T00:00:00.000Z' }),
      monthDigest('2024-09', { uid: 'b', created_at: '2026-05-01T00:00:00.000Z' }),
    ]));
    const res = await consolidateYearlyPonderings({
      tomesDir: dir, provider: 'x', apiKey: 'k', model: 'm', now: NOW,
      callLLM: async () => JSON.stringify({ digest: '2024, looking back.' }),
    });
    assert.equal(res.year, '2024', 'the fold-time year (2026) is ignored; content year 2024 wins');
    const yb = Object.values(await readEntries(file)).find(e => e.scope === 'pondering-yearbook');
    assert.equal(yb.consolidated_year, '2024');
  } finally { cleanup(); }
});

test('consolidateYearlyPonderings: a year with a still-FOLDABLE month is not yearbooked yet (drained-raw guard)', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const file = await seed(dir, entriesFrom([
      monthDigest('2025-03', { uid: 'd1' }),
      monthDigest('2025-07', { uid: 'd2' }),
      // A whole foldable month of raw 2025 ponderings the monthly tier hasn't reached.
      pondering('2025-09-01', { uid: 'r1' }),
      pondering('2025-09-02', { uid: 'r2' }),
      pondering('2025-09-03', { uid: 'r3' }),
    ]));
    // Blocked: 2025 still has a month the monthly tier will fold. Track whether the
    // LLM is reached at all — a swallowed throw would ALSO return null, so `res ===
    // null` alone can't prove the guard fired. The guard means the model is never
    // even asked to fold, and no yearbook is written.
    let called = false;
    let res = await consolidateYearlyPonderings({
      tomesDir: dir, provider: 'x', apiKey: 'k', model: 'm', now: NOW,
      callLLM: async () => { called = true; return JSON.stringify({ digest: 'should not happen' }); },
    });
    assert.equal(res, null, 'not ready while a foldable month remains');
    assert.equal(called, false, 'the guard blocks before the model is even asked to fold');
    assert.equal(Object.values(await readEntries(file)).some(e => e.scope === 'pondering-yearbook'), false, 'no yearbook written while blocked');

    // Drain that month (as the monthly tier eventually would).
    await modifyTomeFile(file, (fresh) => {
      delete fresh.entries.r1; delete fresh.entries.r2; delete fresh.entries.r3; return fresh;
    });
    res = await consolidateYearlyPonderings({
      tomesDir: dir, provider: 'x', apiKey: 'k', model: 'm', now: NOW,
      callLLM: async () => JSON.stringify({ digest: '2025, now whole.' }),
    });
    assert.equal(res.year, '2025', 'folds once the year is drained');
    assert.equal(res.count, 2);
  } finally { cleanup(); }
});

test('consolidateYearlyPonderings: a sub-threshold straggler month does NOT block the yearbook (never-drainable)', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const file = await seed(dir, entriesFrom([
      monthDigest('2025-03', { uid: 'd1' }),
      monthDigest('2025-07', { uid: 'd2' }),
      // Only two raw notes in a 2025 month — can never reach the monthly min of 3,
      // so they must not starve the yearbook forever.
      pondering('2025-12-01', { uid: 's1' }),
      pondering('2025-12-02', { uid: 's2' }),
    ]));
    const res = await consolidateYearlyPonderings({
      tomesDir: dir, provider: 'x', apiKey: 'k', model: 'm', now: NOW,
      callLLM: async () => JSON.stringify({ digest: '2025, the year in brief.' }),
    });
    assert.equal(res.year, '2025', 'a stray straggler month does not block the fold');
    assert.equal(res.count, 2, 'only the two digests fold');
    const after = await readEntries(file);
    assert.ok(after.s1 && after.s2, 'the sub-threshold raw notes simply ride on, un-deleted');
  } finally { cleanup(); }
});

test('consolidateYearlyPonderings: below MIN_DIGESTS_PER_YEAR → null, nothing folded', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const file = await seed(dir, entriesFrom([ monthDigest('2025-03', { uid: 'only' }) ]));   // just one
    const res = await consolidateYearlyPonderings({
      tomesDir: dir, provider: 'x', apiKey: 'k', model: 'm', now: NOW,
      callLLM: async () => { throw new Error('should not be called'); },
    });
    assert.equal(res, null);
    assert.ok((await readEntries(file)).only, 'the lone digest is untouched');
  } finally { cleanup(); }
});

test('consolidateYearlyPonderings: a TRUNCATED yearbook prunes nothing (digests survive)', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const file = await seed(dir, entriesFrom([
      monthDigest('2025-03', { uid: 'd1' }), monthDigest('2025-07', { uid: 'd2' }),
    ]));
    const res = await consolidateYearlyPonderings({
      tomesDir: dir, provider: 'x', apiKey: 'k', model: 'm', now: NOW,
      callLLM: async () => '{"digest": "2025 was cut off mid-sen',
    });
    assert.equal(res, null, 'truncated yearbook → refuse the fold');
    const after = await readEntries(file);
    assert.ok(after.d1 && after.d2, 'digests untouched');
    assert.equal(Object.values(after).some(e => e.scope === 'pondering-yearbook'), false, 'no yearbook stored');
  } finally { cleanup(); }
});

test('yearbook archives its digests, and restore puts them back and drops the yearbook (LIFO across tiers)', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    // A completed 2025 with two month-digests, folded to a yearbook.
    const file = await seed(dir, entriesFrom([
      monthDigest('2025-03', { uid: 'd1', content: 'the spring thread' }),
      monthDigest('2025-09', { uid: 'd2', content: 'the autumn thread' }),
    ]));
    const y = await consolidateYearlyPonderings({
      tomesDir: dir, provider: 'x', apiKey: 'k', model: 'm', now: NOW,
      callLLM: async () => JSON.stringify({ digest: '2025 in one page.' }),
    });
    assert.equal(y.count, 2);
    let after = await readEntries(file);
    assert.equal(after.d1, undefined, 'digests pruned after the yearbook fold');
    const ybUid = Object.keys(after).find(u => after[u].scope === 'pondering-yearbook');
    assert.ok(ybUid);

    // Undo the yearbook: the two month-digests come back, verbatim, yearbook gone.
    const r = await restorePonderingConsolidation({ tomesDir: dir });
    assert.equal(r.restored, 2);
    assert.equal(r.monthPrefix, '2025', 'restore reports the folded period key (the year)');
    after = await readEntries(file);
    assert.ok(after.d1 && after.d2, 'both month-digests restored');
    assert.equal(after.d1.content, 'the spring thread');
    assert.equal(after.d1.scope, 'pondering-digest', 'restored as digests, not raw ponderings');
    assert.equal(after[ybUid], undefined, 'the yearbook is gone — the fold is undone');
  } finally { cleanup(); }
});

test('monthly then yearly fold, restored newest-first: undo the yearbook, then undo the month', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    // Year 2025: three raw July ponderings, plus a pre-existing Feb digest.
    const file = await seed(dir, entriesFrom([
      monthDigest('2025-02', { uid: 'feb' }),
      pondering('2025-07-01', { uid: 'j1' }),
      pondering('2025-07-02', { uid: 'j2' }),
      pondering('2025-07-03', { uid: 'j3' }),
    ]));
    const llm = { tomesDir: dir, provider: 'x', apiKey: 'k', model: 'm', now: NOW };
    // Monthly fold July → a digest. Now 2025 has two digests and no foldable month.
    const m = await consolidatePonderings({ ...llm, callLLM: async () => JSON.stringify({ digest: 'July 2025.' }) });
    assert.equal(m.monthPrefix, '2025-07');
    // Yearly fold 2025 → a yearbook over both digests.
    const y = await consolidateYearlyPonderings({ ...llm, callLLM: async () => JSON.stringify({ digest: 'All of 2025.' }) });
    assert.equal(y.year, '2025');
    assert.equal(y.count, 2);

    // Undo #1 → the yearbook is undone (both digests back).
    let r = await restorePonderingConsolidation({ tomesDir: dir });
    assert.equal(r.monthPrefix, '2025');
    let after = await readEntries(file);
    assert.equal(Object.values(after).filter(e => e.scope === 'pondering-digest').length, 2, 'both digests restored');
    assert.equal(Object.values(after).some(e => e.scope === 'pondering-yearbook'), false);

    // Undo #2 → the July monthly fold is undone (the three raw ponderings back).
    r = await restorePonderingConsolidation({ tomesDir: dir });
    assert.equal(r.monthPrefix, '2025-07');
    after = await readEntries(file);
    assert.ok(after.j1 && after.j2 && after.j3, 'raw July ponderings restored');
  } finally { cleanup(); }
});
