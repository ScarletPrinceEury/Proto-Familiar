// Holistic backup — RESTORE half (2026-09): extractBackup + layDownFileStores.
// Covers the decrypt+untar+manifest-validate step and the file-store lay-down
// step (fresh rootDir, existing rootDir with pre-restore backup-aside, and
// optional media/logs), hermetic — no MCP, no real Phylactery/Unruh, no network.
// New file; does not touch tests/holistic-backup.test.mjs (owned elsewhere).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { mkdtempSync, rmSync, existsSync, promises as fsp } from 'fs';

import {
  createHolisticBackup, extractBackup, layDownFileStores,
} from '../src/backup/holistic-backup.js';

function tmpdir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function setupRoot() {
  const rootDir = tmpdir('pf-root-');
  await fsp.mkdir(path.join(rootDir, 'tomes'), { recursive: true });
  await fsp.writeFile(path.join(rootDir, 'tomes', 'ponderings.json'), JSON.stringify({ a: 1 }), 'utf8');
  await fsp.writeFile(path.join(rootDir, 'tomes', 'session-memories.json'), JSON.stringify({ b: 2 }), 'utf8');
  await fsp.writeFile(path.join(rootDir, 'settings.json'), JSON.stringify({ userName: 'Test' }), 'utf8');
  return rootDir;
}

function okSnapshotter(bytes) {
  return async (dest) => {
    await fsp.writeFile(dest, bytes);
    return { ok: true, filePath: dest };
  };
}

async function buildBackup({ rootDir, workDir, passphrase = 'pw1234', includeMedia = false, includeLogs = false } = {}) {
  const outPath = path.join(workDir, 'backup.pfbackup');
  const result = await createHolisticBackup({
    rootDir,
    outPath,
    passphrase,
    appVersion: '9.9.9',
    includeMedia,
    includeLogs,
    snapshotPhylactery: okSnapshotter('PHYL-DB-BYTES'),
    snapshotUnruh: okSnapshotter('UNRUH-DB-BYTES'),
  });
  return { outPath, result };
}

// ── extractBackup ────────────────────────────────────────────────────────────

test('extractBackup: round-trips a backup into a fresh staging dir with a valid manifest', async () => {
  const rootDir = await setupRoot();
  const workDir = tmpdir('pf-work-');
  let stagingDir;
  try {
    const { outPath } = await buildBackup({ rootDir, workDir });
    const extracted = await extractBackup(outPath, 'pw1234');
    stagingDir = extracted.stagingDir;

    assert.equal(extracted.manifest.format, 'proto-familiar-holistic-backup');
    for (const inc of ['tomes', 'settings.json', 'phylactery.db', 'unruh.db']) {
      assert.ok(extracted.manifest.includes.includes(inc), `manifest.includes should have ${inc}`);
    }

    assert.ok(existsSync(path.join(stagingDir, 'phylactery.db')));
    assert.ok(existsSync(path.join(stagingDir, 'unruh.db')));
    assert.ok(existsSync(path.join(stagingDir, 'tomes', 'ponderings.json')));
    assert.ok(existsSync(path.join(stagingDir, 'tomes', 'session-memories.json')));
    assert.ok(existsSync(path.join(stagingDir, 'settings.json')));

    const phylBytes = await fsp.readFile(path.join(stagingDir, 'phylactery.db'), 'utf8');
    assert.equal(phylBytes, 'PHYL-DB-BYTES');
    const settings = JSON.parse(await fsp.readFile(path.join(stagingDir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings, { userName: 'Test' });

    await extracted.cleanup();
    assert.ok(!existsSync(stagingDir), 'cleanup() should remove the staging dir');
    stagingDir = null;
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('extractBackup: throws on wrong passphrase', async () => {
  const rootDir = await setupRoot();
  const workDir = tmpdir('pf-work-');
  try {
    const { outPath } = await buildBackup({ rootDir, workDir, passphrase: 'right-pass' });
    await assert.rejects(extractBackup(outPath, 'wrong-pass'), /could not decrypt/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('extractBackup: throws on a tampered container (flipped byte)', async () => {
  const rootDir = await setupRoot();
  const workDir = tmpdir('pf-work-');
  try {
    const { outPath } = await buildBackup({ rootDir, workDir });
    const bytes = await fsp.readFile(outPath);
    const tampered = Buffer.from(bytes);
    const lastIdx = tampered.length - 1;
    tampered[lastIdx] = tampered[lastIdx] ^ 0xff;
    const tamperedPath = path.join(workDir, 'tampered.pfbackup');
    await fsp.writeFile(tamperedPath, tampered);
    await assert.rejects(extractBackup(tamperedPath, 'pw1234'), /could not decrypt/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('extractBackup: throws on a random non-backup file (bad header)', async () => {
  const workDir = tmpdir('pf-work-');
  try {
    const randomPath = path.join(workDir, 'not-a-backup.bin');
    await fsp.writeFile(randomPath, Buffer.from('this is just some random file content, not a pfbackup at all'.repeat(5), 'utf8'));
    await assert.rejects(extractBackup(randomPath, 'whatever'), /bad header/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

// ── layDownFileStores ────────────────────────────────────────────────────────

test('layDownFileStores: into an EMPTY rootDir lays down tomes + settings, no dbs, nothing backed up', async () => {
  const srcRoot = await setupRoot();
  const workDir = tmpdir('pf-work-');
  const destRoot = tmpdir('pf-dest-');
  let stagingDir;
  try {
    const { outPath } = await buildBackup({ rootDir: srcRoot, workDir });
    const extracted = await extractBackup(outPath, 'pw1234');
    stagingDir = extracted.stagingDir;

    const { restored, backedUp } = await layDownFileStores({ rootDir: destRoot, stagingDir });

    assert.ok(restored.includes('tomes'));
    assert.ok(restored.includes('settings.json'));
    assert.deepEqual(backedUp, []);

    const tome1 = JSON.parse(await fsp.readFile(path.join(destRoot, 'tomes', 'ponderings.json'), 'utf8'));
    assert.deepEqual(tome1, { a: 1 });
    const settings = JSON.parse(await fsp.readFile(path.join(destRoot, 'settings.json'), 'utf8'));
    assert.deepEqual(settings, { userName: 'Test' });

    // dbs are handled separately — layDownFileStores must never write them.
    assert.ok(!existsSync(path.join(destRoot, 'phylactery.db')));
    assert.ok(!existsSync(path.join(destRoot, 'unruh.db')));

    await extracted.cleanup();
  } finally {
    rmSync(srcRoot, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    rmSync(destRoot, { recursive: true, force: true });
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('layDownFileStores: over an EXISTING rootDir backs the current ones aside before overwriting', async () => {
  const srcRoot = await setupRoot();
  const workDir = tmpdir('pf-work-');
  const destRoot = tmpdir('pf-dest-');
  let stagingDir;
  try {
    // pre-populate destRoot with different content
    await fsp.mkdir(path.join(destRoot, 'tomes'), { recursive: true });
    await fsp.writeFile(path.join(destRoot, 'tomes', 'old.json'), JSON.stringify({ old: true }), 'utf8');
    await fsp.writeFile(path.join(destRoot, 'settings.json'), JSON.stringify({ userName: 'OldUser' }), 'utf8');

    const { outPath } = await buildBackup({ rootDir: srcRoot, workDir });
    const extracted = await extractBackup(outPath, 'pw1234');
    stagingDir = extracted.stagingDir;
    const fixedNow = new Date('2026-09-17T12:34:56.000Z');

    const { restored, backedUp } = await layDownFileStores({ rootDir: destRoot, stagingDir, now: fixedNow });

    assert.ok(restored.includes('tomes'));
    assert.ok(restored.includes('settings.json'));

    const stamp = fixedNow.toISOString().replace(/[:.]/g, '-');
    const expectedTomesAside = `tomes.pre-restore-${stamp}`;
    const expectedSettingsAside = `settings.json.pre-restore-${stamp}`;
    assert.ok(backedUp.includes(expectedTomesAside), `backedUp should include ${expectedTomesAside}, got ${JSON.stringify(backedUp)}`);
    assert.ok(backedUp.includes(expectedSettingsAside), `backedUp should include ${expectedSettingsAside}, got ${JSON.stringify(backedUp)}`);

    // the old content survives under the pre-restore name
    assert.ok(existsSync(path.join(destRoot, expectedTomesAside)));
    const oldTome = JSON.parse(await fsp.readFile(path.join(destRoot, expectedTomesAside, 'old.json'), 'utf8'));
    assert.deepEqual(oldTome, { old: true });
    assert.ok(existsSync(path.join(destRoot, expectedSettingsAside)));
    const oldSettings = JSON.parse(await fsp.readFile(path.join(destRoot, expectedSettingsAside), 'utf8'));
    assert.deepEqual(oldSettings, { userName: 'OldUser' });

    // the new content is in place at the live path
    assert.ok(!existsSync(path.join(destRoot, 'tomes', 'old.json')), 'old.json should not be at the live path anymore');
    const newTome = JSON.parse(await fsp.readFile(path.join(destRoot, 'tomes', 'ponderings.json'), 'utf8'));
    assert.deepEqual(newTome, { a: 1 });
    const newSettings = JSON.parse(await fsp.readFile(path.join(destRoot, 'settings.json'), 'utf8'));
    assert.deepEqual(newSettings, { userName: 'Test' });

    await extracted.cleanup();
  } finally {
    rmSync(srcRoot, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    rmSync(destRoot, { recursive: true, force: true });
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  }
});

// ── media / logs ─────────────────────────────────────────────────────────────

test('layDownFileStores: media/logs extract and lay down when included in the backup', async () => {
  const srcRoot = await setupRoot();
  await fsp.mkdir(path.join(srcRoot, 'media'), { recursive: true });
  await fsp.writeFile(path.join(srcRoot, 'media', 'clip.bin'), 'MEDIA-BYTES', 'utf8');
  await fsp.mkdir(path.join(srcRoot, 'logs'), { recursive: true });
  await fsp.writeFile(path.join(srcRoot, 'logs', 'events.jsonl'), '{"a":1}\n', 'utf8');

  const workDir = tmpdir('pf-work-');
  const destRoot = tmpdir('pf-dest-');
  let stagingDir;
  try {
    const { outPath } = await buildBackup({ rootDir: srcRoot, workDir, includeMedia: true, includeLogs: true });
    const extracted = await extractBackup(outPath, 'pw1234');
    stagingDir = extracted.stagingDir;

    assert.ok(existsSync(path.join(stagingDir, 'media', 'clip.bin')));
    assert.ok(existsSync(path.join(stagingDir, 'logs', 'events.jsonl')));

    const { restored } = await layDownFileStores({ rootDir: destRoot, stagingDir });
    assert.ok(restored.includes('media'));
    assert.ok(restored.includes('logs'));

    const mediaBytes = await fsp.readFile(path.join(destRoot, 'media', 'clip.bin'), 'utf8');
    assert.equal(mediaBytes, 'MEDIA-BYTES');
    const logBytes = await fsp.readFile(path.join(destRoot, 'logs', 'events.jsonl'), 'utf8');
    assert.equal(logBytes, '{"a":1}\n');

    await extracted.cleanup();
  } finally {
    rmSync(srcRoot, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    rmSync(destRoot, { recursive: true, force: true });
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('layDownFileStores: a backup WITHOUT media/logs does not produce them in staging or at lay-down', async () => {
  const srcRoot = await setupRoot();
  const workDir = tmpdir('pf-work-');
  const destRoot = tmpdir('pf-dest-');
  let stagingDir;
  try {
    const { outPath } = await buildBackup({ rootDir: srcRoot, workDir, includeMedia: false, includeLogs: false });
    const extracted = await extractBackup(outPath, 'pw1234');
    stagingDir = extracted.stagingDir;

    assert.ok(!existsSync(path.join(stagingDir, 'media')));
    assert.ok(!existsSync(path.join(stagingDir, 'logs')));

    const { restored } = await layDownFileStores({ rootDir: destRoot, stagingDir });
    assert.ok(!restored.includes('media'));
    assert.ok(!restored.includes('logs'));
    assert.ok(!existsSync(path.join(destRoot, 'media')));
    assert.ok(!existsSync(path.join(destRoot, 'logs')));

    await extracted.cleanup();
  } finally {
    rmSync(srcRoot, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    rmSync(destRoot, { recursive: true, force: true });
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  }
});
