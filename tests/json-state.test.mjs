import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readJsonStateSync, readJsonState, writeJsonState } from '../src/util/json-state.js';

async function tmpFile(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-jsonstate-'));
  const file = path.join(dir, 'state.json');
  if (contents !== undefined) await fs.writeFile(file, contents, 'utf8');
  return file;
}

// ── readJsonStateSync — the boot-time / per-check sibling ──────────────────────

test('readJsonStateSync returns the parsed object for valid JSON', async () => {
  const file = await tmpFile('{"a":1,"b":[2,3]}');
  assert.deepEqual(readJsonStateSync(file), { a: 1, b: [2, 3] });
});

test('readJsonStateSync returns the fallback when the file is missing', () => {
  const missing = path.join(os.tmpdir(), 'pf-jsonstate-does-not-exist', 'nope.json');
  assert.deepEqual(readJsonStateSync(missing), {});
  assert.equal(readJsonStateSync(missing, null), null);
});

test('readJsonStateSync returns the fallback on corrupt JSON', async () => {
  const file = await tmpFile('{ not valid json');
  assert.deepEqual(readJsonStateSync(file, { fresh: true }), { fresh: true });
});

test('readJsonStateSync returns the fallback for non-object JSON (null/number/string)', async () => {
  // A bare null, number, or string parses fine but is not the object shape the
  // callers expect — it must fall back, so a caller never gets a surprise scalar.
  for (const raw of ['null', '42', '"hi"']) {
    const file = await tmpFile(raw);
    assert.equal(readJsonStateSync(file, null), null, `raw=${raw}`);
  }
});

test('readJsonStateSync passes arrays through (arrays are objects — caller validates shape)', async () => {
  // Matches the async sibling: an array clears the typeof check, so callers that
  // expect an object keep their own Array.isArray / field guards on top.
  const file = await tmpFile('[1,2,3]');
  assert.deepEqual(readJsonStateSync(file, {}), [1, 2, 3]);
});

test('readJsonStateSync and readJsonState agree on the same inputs', async () => {
  for (const raw of ['{"x":1}', 'null', 'garbage', '[9]']) {
    const file = await tmpFile(raw);
    const sync = readJsonStateSync(file, null);
    const asyncVal = await readJsonState(file, null);
    assert.deepEqual(sync, asyncVal, `raw=${raw}`);
  }
});

// ── round-trip with the atomic writer ──────────────────────────────────────────

test('writeJsonState then readJsonStateSync round-trips', async () => {
  const file = await tmpFile();
  await writeJsonState(file, { saved: 'yes', n: 7 });
  assert.deepEqual(readJsonStateSync(file), { saved: 'yes', n: 7 });
});
