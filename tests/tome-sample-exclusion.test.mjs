import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTomeFile, readAllTomes } from '../src/tomes/tome-store.js';

// A Sample/reference lorebook must never reach an injection site: it's a
// reference to read on disk, not a live tome.

test('isTomeFile rejects Sample* files, dotfiles, and non-json; accepts real tomes', () => {
  assert.equal(isTomeFile('SampleLB.json'), false);
  assert.equal(isTomeFile('Sample-Lorebook.json'), false);
  assert.equal(isTomeFile('.consent-pending.json'), false);
  assert.equal(isTomeFile('notes.txt'), false);
  assert.equal(isTomeFile('ADHD-Tome.json'), true);
  assert.equal(isTomeFile('b1f2c3d4-0000-4000-8000-000000000000.json'), true);
});

test('readAllTomes skips a Sample lorebook sitting in the tomes dir', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-tome-'));
  await fs.writeFile(path.join(dir, 'ADHD-Tome.json'),
    JSON.stringify({ name: 'ADHD Support', entries: {} }), 'utf8');
  await fs.writeFile(path.join(dir, 'SampleLB.json'),
    JSON.stringify({ name: 'Sample Lorebook', entries: { x: { uid: 'x', content: 'REFERENCE ONLY' } } }), 'utf8');

  const tomes = await readAllTomes(dir);
  const names = tomes.map(t => t.name).sort();
  assert.deepEqual(names, ['ADHD Support'], 'the Sample lorebook must not load as a tome');
  assert.ok(!JSON.stringify(tomes).includes('REFERENCE ONLY'),
    'no content from the Sample lorebook reaches the loaded set');
});
