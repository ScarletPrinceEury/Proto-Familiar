// buildTomeEntry + listTomesSummary — the shared pieces behind the Familiar's
// own themed tomes (2026-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';

import { buildTomeEntry, listTomesSummary } from '../src/tomes/tome-store.js';

test('buildTomeEntry: shapes an ST entry, normalizes keys, defaults comment', () => {
  const { uid, entry } = buildTomeEntry({ title: undefined, content: '  a note  ', keys: ' a , b ,, c ', comment: 'Label' });
  assert.equal(entry.uid, uid);
  assert.equal(entry.content, 'a note', 'content trimmed');
  assert.deepEqual(entry.keys, ['a', 'b', 'c'], 'comma-string split + trimmed + blanks dropped');
  assert.equal(entry.comment, 'Label');
  assert.equal(entry.enabled, true);
  assert.equal(entry.depth, 4, 'at-depth, not a system position');
  assert.ok(entry.created_at && entry.learnedAt);
});

test('buildTomeEntry: array keys pass through; blank comment falls back', () => {
  const { entry } = buildTomeEntry({ content: 'x', keys: ['k1', ' k2 '], comment: '   ' });
  assert.deepEqual(entry.keys, ['k1', 'k2']);
  assert.equal(entry.comment, 'Auto-saved entry', 'blank comment → fallback');
});

test('buildTomeEntry: learnedAt honored when given', () => {
  const { entry } = buildTomeEntry({ content: 'x', keys: [], learnedAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(entry.learnedAt, '2020-01-01T00:00:00.000Z');
});

function tmpTomes(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tomesum-'));
  for (const [name, obj] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), JSON.stringify(obj));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('listTomesSummary: names, counts, sort, and the manual marked protected', async () => {
  const { dir, cleanup } = tmpTomes({
    'a.json': { id: 'a', name: 'Zebra facts', description: 'stripes', enabled: true, entries: { e1: {}, e2: {} } },
    'b.json': { id: 'b', name: 'Apple notes', enabled: true, entries: { e1: {} } },
    'm.json': { id: 'm', name: 'Familiar Manual', graduationExempt: true, enabled: true, entries: {} },
    '.hidden.json': { id: 'h', name: 'bookkeeping', entries: {} },   // dotfile → not a tome
  });
  try {
    const got = await listTomesSummary(dir);
    assert.deepEqual(got.map(t => t.name), ['Apple notes', 'Familiar Manual', 'Zebra facts'], 'sorted, dotfile excluded');
    const zebra = got.find(t => t.name === 'Zebra facts');
    assert.equal(zebra.entries, 2);
    assert.equal(zebra.description, 'stripes');
    const manual = got.find(t => t.name === 'Familiar Manual');
    assert.equal(manual.protected, true, 'graduationExempt + /manual/ name → protected');
    assert.equal(got.find(t => t.name === 'Apple notes').protected, false);
  } finally { cleanup(); }
});

test('listTomesSummary: missing dir → [] (never throws)', async () => {
  assert.deepEqual(await listTomesSummary('/no/such/tomes/dir/xyz'), []);
});
