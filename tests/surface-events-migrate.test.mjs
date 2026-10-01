import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from '../repo-root.js';
import {
  DEFAULT_TOMES_DIR,
  migrateStraySurfaceEvents,
  loadSurfaceEvents,
} from '../src/pondering/surface-events.js';

// §2 — the path must resolve from the repo root, not src/pondering/ (the
// 2026-09-07 __dirname bug), and the boot migration must fold the stray file in.

test('§2: DEFAULT_TOMES_DIR resolves to <repo>/tomes, not src/pondering/tomes', () => {
  assert.equal(DEFAULT_TOMES_DIR, path.join(REPO_ROOT, 'tomes'));
  assert.ok(!DEFAULT_TOMES_DIR.includes('pondering'),
    `path still points inside src/pondering: ${DEFAULT_TOMES_DIR}`);
});

async function mkStore(dir, store) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.surface-events.json'), JSON.stringify(store, null, 2), 'utf8');
}
const ev = (id, extra = {}) => ({ id, task_id: id + '-task', offered_at: Date.now(), outcome: 'cancelled', outcome_at: Date.now(), raised: true, ...extra });

test('§2: migration merges stray events, dedupes by id, keeps the newer reflection mark, removes the stray', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-se-'));
  const strayDir = path.join(base, 'stray');
  const tomesDir = path.join(base, 'canonical');

  // Stray holds A and B, reflected at t=100. Canonical holds B (overlap) and C, reflected at t=200.
  await mkStore(strayDir,  { version: 2, last_reflection_at: 100, events: [ev('A'), ev('B')] });
  await mkStore(tomesDir,  { version: 2, last_reflection_at: 200, events: [ev('B'), ev('C')] });

  const r = await migrateStraySurfaceEvents({ tomesDir, strayDir });
  assert.equal(r.migrated, 1, 'only A is new; B is a dup of canonical');

  const after = await loadSurfaceEvents(tomesDir);
  const ids = after.events.map(e => e.id).sort();
  assert.deepEqual(ids, ['A', 'B', 'C'], 'A folded in, B not duplicated, C kept');
  assert.equal(after.last_reflection_at, 200, 'keeps the newer reflection watermark');

  // Stray file is gone so a later boot can't re-merge.
  await assert.rejects(fs.access(path.join(strayDir, '.surface-events.json')));
});

test('§2: migration is a clean no-op when there is no stray file', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-se-'));
  const tomesDir = path.join(base, 'canonical');
  const strayDir = path.join(base, 'stray'); // never created
  await mkStore(tomesDir, { version: 2, last_reflection_at: null, events: [ev('X')] });

  const r = await migrateStraySurfaceEvents({ tomesDir, strayDir });
  assert.equal(r.migrated, 0);
  const after = await loadSurfaceEvents(tomesDir);
  assert.deepEqual(after.events.map(e => e.id), ['X'], 'canonical untouched');
});

test('§2: migration refuses to act when stray and canonical dirs coincide (never deletes the live store)', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-se-'));
  await mkStore(base, { version: 2, last_reflection_at: null, events: [ev('Z')] });
  const r = await migrateStraySurfaceEvents({ tomesDir: base, strayDir: base });
  assert.equal(r.migrated, 0);
  // The file must still be there.
  await fs.access(path.join(base, '.surface-events.json'));
});
