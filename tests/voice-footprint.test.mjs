import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  preflightDecision, dirSize, measureFootprint, volumeSpace,
  RESERVE_BYTES, FOOTPRINT_CATEGORIES,
} from '../voice-footprint.js';

const MB = 1024 * 1024;

test('a download that fits with room to spare is allowed', () => {
  const d = preflightDecision({ needBytes: 100 * MB, freeBytes: 2000 * MB });
  assert.equal(d.ok, true);
  assert.equal(d.reason, 'fits');
  assert.equal(d.remainingAfter, 1900 * MB);
});

test('a download larger than free space is refused before anything is written', () => {
  const d = preflightDecision({ needBytes: 500 * MB, freeBytes: 100 * MB });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'insufficient-space');
});

test('a download that would technically fit but leave the drive gasping is refused too', () => {
  const d = preflightDecision({ needBytes: 300 * MB, freeBytes: 400 * MB });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'below-reserve');
  assert.ok(d.remainingAfter < RESERVE_BYTES);
});

test('the reserve is a floor that must remain, not a percentage of the download', () => {
  // A small download and a large one endanger a nearly-full drive equally.
  const small = preflightDecision({ needBytes: 40 * MB, freeBytes: 200 * MB });
  const large = preflightDecision({ needBytes: 240 * MB, freeBytes: 400 * MB });
  assert.equal(small.ok, false);
  assert.equal(large.ok, false);
  assert.equal(small.reason, 'below-reserve');
});

test('exactly at the reserve boundary is allowed; one byte under is not', () => {
  const atEdge = preflightDecision({ needBytes: 100 * MB, freeBytes: 100 * MB + RESERVE_BYTES });
  assert.equal(atEdge.ok, true);
  const under = preflightDecision({ needBytes: 100 * MB, freeBytes: 100 * MB + RESERVE_BYTES - 1 });
  assert.equal(under.ok, false);
});

test('unreadable free space fails CLOSED — it never guesses that a download will fit', () => {
  const d = preflightDecision({ needBytes: 100 * MB, freeBytes: null });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'unknown-space');
  assert.match(d.message, /free/i);
});

test('an unknown download size fails closed as well', () => {
  assert.equal(preflightDecision({ needBytes: NaN, freeBytes: 9999 * MB }).reason, 'unknown-size');
  assert.equal(preflightDecision({ needBytes: -5, freeBytes: 9999 * MB }).ok, false);
});

test('the estimated flag rides through, so a refusal resting on an estimate is legible as one', () => {
  const d = preflightDecision({ needBytes: 500 * MB, freeBytes: 100 * MB, estimated: true });
  assert.equal(d.estimated, true);
  assert.equal(preflightDecision({ needBytes: 1, freeBytes: 9999 * MB }).estimated, false);
});

test('a caller may tighten or loosen the reserve without editing the module', () => {
  const d = preflightDecision({ needBytes: 300 * MB, freeBytes: 400 * MB, reserveBytes: 50 * MB });
  assert.equal(d.ok, true);
});

test('dirSize measures a real tree, and a missing directory is zero rather than an error', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vf-'));
  try {
    await fs.mkdir(path.join(root, 'nested', 'deep'), { recursive: true });
    await fs.writeFile(path.join(root, 'a.bin'), Buffer.alloc(1000));
    await fs.writeFile(path.join(root, 'nested', 'b.bin'), Buffer.alloc(2000));
    await fs.writeFile(path.join(root, 'nested', 'deep', 'c.bin'), Buffer.alloc(3000));

    const got = await dirSize(root);
    assert.equal(got.bytes, 6000);
    assert.equal(got.files, 3);
    assert.equal(got.exists, true);
    assert.equal(got.partial, false);

    const missing = await dirSize(path.join(root, 'not-here'));
    assert.deepEqual(missing, { bytes: 0, files: 0, exists: false, partial: false });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dirSize stays bounded on a large tree and reports the truncation instead of hiding it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vf-'));
  try {
    for (let i = 0; i < 20; i++) await fs.writeFile(path.join(root, `f${i}`), Buffer.alloc(10));
    const got = await dirSize(root, { maxEntries: 5 });
    assert.equal(got.partial, true);
    assert.ok(got.files <= 5);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('only re-fetchable machine artifacts are ever marked reclaimable', () => {
  const reclaimable = FOOTPRINT_CATEGORIES.filter((c) => c.reclaimable);
  assert.deepEqual(reclaimable.map((c) => c.key), ['audio-models']);
  for (const c of FOOTPRINT_CATEGORIES) {
    if (c.kind === 'self') {
      assert.equal(c.reclaimable, false, `${c.key} is mine and must never offer a delete affordance`);
    }
  }
});

test('nothing the Familiar persists is classified as machine', () => {
  const self = new Set(['media', 'tomes', 'logs', 'phylactery-store', 'unruh-store']);
  for (const c of FOOTPRINT_CATEGORIES) {
    if (self.has(c.key)) assert.equal(c.kind, 'self');
  }
});

test('measureFootprint separates what is mine from what is the machine\'s, and totals both', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vf-'));
  try {
    await fs.mkdir(path.join(root, 'models', 'audio'), { recursive: true });
    await fs.writeFile(path.join(root, 'models', 'audio', 'm.onnx'), Buffer.alloc(4000));
    await fs.mkdir(path.join(root, 'tomes'), { recursive: true });
    await fs.writeFile(path.join(root, 'tomes', 't.md'), Buffer.alloc(1000));

    const f = await measureFootprint(root);
    assert.equal(f.totals.machineBytes, 4000);
    assert.equal(f.totals.selfBytes, 1000);
    assert.equal(f.totals.totalBytes, 5000);
    assert.equal(f.totals.reclaimableBytes, 4000, 'only the models are reclaimable');

    const tomes = f.items.find((i) => i.key === 'tomes');
    assert.equal(tomes.bytes, 1000, 'my own state is shown, not hidden');
    assert.equal(tomes.reclaimable, false, 'and never sweepable from here');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('measureFootprint reports absent directories as zero rather than failing the whole picture', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vf-'));
  try {
    const f = await measureFootprint(root);
    assert.equal(f.totals.totalBytes, 0);
    assert.equal(f.items.length, FOOTPRINT_CATEGORIES.length);
    assert.ok(f.items.every((i) => i.exists === false));
    assert.equal(f.partial, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('volumeSpace walks up to an existing ancestor, so it works before the target directory exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vf-'));
  try {
    const s = await volumeSpace(path.join(root, 'does', 'not', 'exist', 'yet'));
    assert.equal(s.ok, true);
    assert.ok(s.freeBytes > 0);
    assert.ok(s.totalBytes > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
