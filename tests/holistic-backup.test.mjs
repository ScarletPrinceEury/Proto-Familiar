// Holistic backup (2026-09): passphrase-encrypted whole-self export.
// Covers the raw crypto container (encryptBundle/decryptBundle) and the
// end-to-end createHolisticBackup flow with injected snapshotters, so it's
// hermetic — no MCP, no real Phylactery/Unruh, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { mkdtempSync, rmSync, existsSync, promises as fsp } from 'fs';
import * as tar from 'tar';

import {
  encryptBundle, decryptBundle, createHolisticBackup, BACKUP_MAGIC, BACKUP_VERSION,
} from '../src/backup/holistic-backup.js';

function tmpdir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── encryptBundle / decryptBundle ────────────────────────────────────────────

test('encryptBundle → decryptBundle round-trips a multi-KB buffer', () => {
  const plaintext = crypto_random(20 * 1024); // 20KB of pseudo-random-ish bytes
  const container = encryptBundle(plaintext, 'correct horse battery staple');
  const out = decryptBundle(container, 'correct horse battery staple');
  assert.ok(out.equals(plaintext));
});

test('decryptBundle throws on wrong passphrase', () => {
  const plaintext = Buffer.from('some secret bundle bytes, repeated '.repeat(200), 'utf8');
  const container = encryptBundle(plaintext, 'right-pass');
  assert.throws(() => decryptBundle(container, 'wrong-pass'), /could not decrypt/);
});

test('decryptBundle throws on tampered ciphertext (byte flip near the end)', () => {
  const plaintext = Buffer.from('some secret bundle bytes, repeated '.repeat(200), 'utf8');
  const container = encryptBundle(plaintext, 'a-pass');
  const tampered = Buffer.from(container); // copy
  const lastIdx = tampered.length - 1;
  tampered[lastIdx] = tampered[lastIdx] ^ 0xff; // flip bits in the last byte (part of ciphertext)
  assert.throws(() => decryptBundle(tampered, 'a-pass'), /could not decrypt/);
});

test('decryptBundle throws on a bad magic header', () => {
  const plaintext = Buffer.from('hello world', 'utf8');
  const container = encryptBundle(plaintext, 'a-pass');
  const bad = Buffer.from(container);
  bad.write('XXXXXXX', 0, 'utf8'); // exactly BACKUP_MAGIC.length (7) bytes, so only the header changes
  assert.equal(BACKUP_MAGIC.length, 7);
  assert.equal(bad.length, container.length);
  assert.throws(() => decryptBundle(bad, 'a-pass'), /bad header/);
});

test('decryptBundle throws on a too-short buffer', () => {
  assert.throws(() => decryptBundle(Buffer.from('short'), 'a-pass'), /too short/);
});

test('encryptBundle throws on empty/missing passphrase', () => {
  const plaintext = Buffer.from('hello', 'utf8');
  assert.throws(() => encryptBundle(plaintext, ''), /passphrase is required/);
  assert.throws(() => encryptBundle(plaintext, undefined), /passphrase is required/);
  assert.throws(() => encryptBundle(plaintext, null), /passphrase is required/);
});

test('decryptBundle throws on empty/missing passphrase', () => {
  const container = encryptBundle(Buffer.from('hello'), 'a-pass');
  assert.throws(() => decryptBundle(container, ''), /passphrase is required/);
  assert.throws(() => decryptBundle(container, undefined), /passphrase is required/);
});

function crypto_random(n) {
  // deterministic-ish filler buffer without pulling in node:crypto randomness
  // dependencies for the test — content doesn't matter, only round-trip identity.
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) buf[i] = (i * 37 + 11) % 256;
  return buf;
}

// ── createHolisticBackup end-to-end ──────────────────────────────────────────

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

async function decryptAndExtract(filePath, passphrase, extractDir) {
  const container = await fsp.readFile(filePath);
  const plaintext = decryptBundle(container, passphrase);
  const tgzPath = path.join(extractDir, 'bundle.tgz');
  await fsp.writeFile(tgzPath, plaintext);
  const outDir = path.join(extractDir, 'extracted');
  await fsp.mkdir(outDir, { recursive: true });
  await tar.x({ file: tgzPath, cwd: outDir });
  return outDir;
}

test('createHolisticBackup: end-to-end bundle contains manifest, db snapshots, tomes, settings', async () => {
  const rootDir = await setupRoot();
  const workDir = tmpdir('pf-work-');
  const outPath = path.join(workDir, 'backup.pfbackup');
  try {
    const result = await createHolisticBackup({
      rootDir,
      outPath,
      passphrase: 'pw1234',
      appVersion: '9.9.9',
      snapshotPhylactery: okSnapshotter('PHYL-DB-BYTES'),
      snapshotUnruh: okSnapshotter('UNRUH-DB-BYTES'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.filePath, outPath);
    assert.ok(result.sizeBytes > 0);
    assert.ok(existsSync(outPath));

    // manifest returned directly
    assert.equal(result.manifest.appVersion, '9.9.9');
    assert.equal(result.manifest.version, BACKUP_VERSION);
    for (const inc of ['tomes', 'settings.json', 'phylactery.db', 'unruh.db']) {
      assert.ok(result.manifest.includes.includes(inc), `manifest.includes should have ${inc}`);
    }
    assert.ok(!Number.isNaN(new Date(result.manifest.createdAt).getTime()), 'createdAt parses as a date');
    assert.equal(result.manifest.includedMedia, false);
    assert.equal(result.manifest.includedLogs, false);

    // decrypt + extract and verify the tree on disk
    const extractDir = await decryptAndExtract(outPath, 'pw1234', workDir);
    const manifestOnDisk = JSON.parse(await fsp.readFile(path.join(extractDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifestOnDisk, result.manifest);

    const phylBytes = await fsp.readFile(path.join(extractDir, 'phylactery.db'), 'utf8');
    assert.equal(phylBytes, 'PHYL-DB-BYTES');
    const unruhBytes = await fsp.readFile(path.join(extractDir, 'unruh.db'), 'utf8');
    assert.equal(unruhBytes, 'UNRUH-DB-BYTES');

    const tome1 = JSON.parse(await fsp.readFile(path.join(extractDir, 'tomes', 'ponderings.json'), 'utf8'));
    assert.deepEqual(tome1, { a: 1 });
    const tome2 = JSON.parse(await fsp.readFile(path.join(extractDir, 'tomes', 'session-memories.json'), 'utf8'));
    assert.deepEqual(tome2, { b: 2 });

    const settings = JSON.parse(await fsp.readFile(path.join(extractDir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings, { userName: 'Test' });

    // media/logs absent by default
    assert.ok(!existsSync(path.join(extractDir, 'media')));
    assert.ok(!existsSync(path.join(extractDir, 'logs')));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('createHolisticBackup: includeMedia/includeLogs bundle those dirs when set, omitted by default', async () => {
  const rootDir = await setupRoot();
  await fsp.mkdir(path.join(rootDir, 'media'), { recursive: true });
  await fsp.writeFile(path.join(rootDir, 'media', 'clip.bin'), 'MEDIA-BYTES', 'utf8');
  await fsp.mkdir(path.join(rootDir, 'logs'), { recursive: true });
  await fsp.writeFile(path.join(rootDir, 'logs', 'events.jsonl'), '{"a":1}\n', 'utf8');

  const workDir = tmpdir('pf-work-');
  const outPath = path.join(workDir, 'backup.pfbackup');
  try {
    const result = await createHolisticBackup({
      rootDir,
      outPath,
      passphrase: 'pw1234',
      appVersion: '1.0.0',
      includeMedia: true,
      includeLogs: true,
      snapshotPhylactery: okSnapshotter('PHYL'),
      snapshotUnruh: okSnapshotter('UNRUH'),
    });

    assert.ok(result.manifest.includes.includes('media'));
    assert.ok(result.manifest.includes.includes('logs'));
    assert.equal(result.manifest.includedMedia, true);
    assert.equal(result.manifest.includedLogs, true);

    const extractDir = await decryptAndExtract(outPath, 'pw1234', workDir);
    const mediaBytes = await fsp.readFile(path.join(extractDir, 'media', 'clip.bin'), 'utf8');
    assert.equal(mediaBytes, 'MEDIA-BYTES');
    const logBytes = await fsp.readFile(path.join(extractDir, 'logs', 'events.jsonl'), 'utf8');
    assert.equal(logBytes, '{"a":1}\n');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('createHolisticBackup: media/logs are NOT bundled by default even when present on disk', async () => {
  const rootDir = await setupRoot();
  await fsp.mkdir(path.join(rootDir, 'media'), { recursive: true });
  await fsp.writeFile(path.join(rootDir, 'media', 'clip.bin'), 'MEDIA-BYTES', 'utf8');
  await fsp.mkdir(path.join(rootDir, 'logs'), { recursive: true });
  await fsp.writeFile(path.join(rootDir, 'logs', 'events.jsonl'), '{"a":1}\n', 'utf8');

  const workDir = tmpdir('pf-work-');
  const outPath = path.join(workDir, 'backup.pfbackup');
  try {
    const result = await createHolisticBackup({
      rootDir,
      outPath,
      passphrase: 'pw1234',
      snapshotPhylactery: okSnapshotter('PHYL'),
      snapshotUnruh: okSnapshotter('UNRUH'),
    });

    assert.ok(!result.manifest.includes.includes('media'));
    assert.ok(!result.manifest.includes.includes('logs'));
    assert.equal(result.manifest.includedMedia, false);
    assert.equal(result.manifest.includedLogs, false);

    const extractDir = await decryptAndExtract(outPath, 'pw1234', workDir);
    assert.ok(!existsSync(path.join(extractDir, 'media')));
    assert.ok(!existsSync(path.join(extractDir, 'logs')));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('createHolisticBackup: a failing snapshotter rejects and leaves no leftover file at outPath', async () => {
  const rootDir = await setupRoot();
  const workDir = tmpdir('pf-work-');
  const outPath = path.join(workDir, 'backup.pfbackup');
  try {
    await assert.rejects(
      createHolisticBackup({
        rootDir,
        outPath,
        passphrase: 'pw1234',
        snapshotPhylactery: async () => ({ ok: false, error: 'boom' }),
        snapshotUnruh: okSnapshotter('UNRUH'),
      }),
      /Phylactery snapshot failed: boom/,
    );
    assert.ok(!existsSync(outPath), 'no leftover file should exist at outPath');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('createHolisticBackup: a failing Unruh snapshotter also rejects with no leftover file', async () => {
  const rootDir = await setupRoot();
  const workDir = tmpdir('pf-work-');
  const outPath = path.join(workDir, 'backup.pfbackup');
  try {
    await assert.rejects(
      createHolisticBackup({
        rootDir,
        outPath,
        passphrase: 'pw1234',
        snapshotPhylactery: okSnapshotter('PHYL'),
        snapshotUnruh: async () => ({ ok: false, error: 'unruh-boom' }),
      }),
      /Unruh snapshot failed: unruh-boom/,
    );
    assert.ok(!existsSync(outPath));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('createHolisticBackup: missing passphrase throws', async () => {
  const rootDir = await setupRoot();
  const workDir = tmpdir('pf-work-');
  const outPath = path.join(workDir, 'backup.pfbackup');
  try {
    await assert.rejects(
      createHolisticBackup({
        rootDir,
        outPath,
        passphrase: '',
        snapshotPhylactery: okSnapshotter('PHYL'),
        snapshotUnruh: okSnapshotter('UNRUH'),
      }),
      /passphrase is required/,
    );
    assert.ok(!existsSync(outPath));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('createHolisticBackup: works with no snapshotters injected (tomes/settings only)', async () => {
  const rootDir = await setupRoot();
  const workDir = tmpdir('pf-work-');
  const outPath = path.join(workDir, 'backup.pfbackup');
  try {
    const result = await createHolisticBackup({ rootDir, outPath, passphrase: 'pw1234' });
    assert.equal(result.ok, true);
    assert.ok(!result.manifest.includes.includes('phylactery.db'));
    assert.ok(!result.manifest.includes.includes('unruh.db'));
    assert.ok(result.manifest.includes.includes('tomes'));
    assert.ok(result.manifest.includes.includes('settings.json'));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});
