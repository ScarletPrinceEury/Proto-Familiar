// Holistic backup — the whole Familiar in one passphrase-encrypted, importable
// file (2026-09). The data-loss incident showed the gap: Phylactery had its own
// encrypted backup, but nothing covered tomes / Unruh / settings together, so a
// destroyed ponderings tome had no backstop. This bundles the WHOLE self —
// Phylactery + Unruh (clean VACUUM'd db snapshots), tomes/, settings.json (which
// carries connections + the chosen voice), optionally media/ and logs/ — into
// one file, encrypted so the API keys inside settings.json can't leak from a
// stray backup.
//
// Format `.pfbackup`:
//   "PFBKP1\n" (7) | version:1 (1) | salt (16) | iv (12) | authTag (16) | AES-256-GCM(ciphertext)
// where the plaintext is a gzipped tar of a staging tree:
//   manifest.json | phylactery.db | unruh.db | tomes/… | settings.json | [media/…] | [logs/…]
//
// The db snapshots are produced by each service's own `db_snapshot` MCP tool
// (VACUUM INTO — WAL-safe, consistent) so this never copies a live db raw. Stage
// 1 is EXPORT only; restore/import (which overwrites a live install) is a
// separate, deliberately careful pass.

import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import * as tar from 'tar';

export const BACKUP_MAGIC = Buffer.from('PFBKP1\n', 'utf8');   // 7 bytes
export const BACKUP_VERSION = 1;
const SALT_LEN = 16, IV_LEN = 12, TAG_LEN = 16, KEY_LEN = 32;
// scrypt cost. maxmem raised because 128*N*r for N=2^15 (~33MB) exceeds Node's
// 32MB default and would otherwise throw.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(Buffer.from(String(passphrase), 'utf8'), salt, KEY_LEN, SCRYPT);
}

// Encrypt an arbitrary buffer into the .pfbackup container. Random salt+iv per
// call; GCM auth tag detects tampering and a wrong passphrase.
export function encryptBundle(plaintext, passphrase) {
  if (!passphrase || typeof passphrase !== 'string') throw new Error('a passphrase is required');
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([BACKUP_MAGIC, Buffer.from([BACKUP_VERSION]), salt, iv, tag, ct]);
}

// Decrypt a .pfbackup container back to the plaintext buffer. Throws on a bad
// magic/version, and — via GCM — on a wrong passphrase or a tampered file.
export function decryptBundle(container, passphrase) {
  if (!passphrase || typeof passphrase !== 'string') throw new Error('a passphrase is required');
  const buf = Buffer.isBuffer(container) ? container : Buffer.from(container);
  let off = 0;
  if (buf.length < BACKUP_MAGIC.length + 1 + SALT_LEN + IV_LEN + TAG_LEN) throw new Error('not a Proto-Familiar backup (too short)');
  if (!buf.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw new Error('not a Proto-Familiar backup (bad header)');
  off += BACKUP_MAGIC.length;
  const version = buf[off]; off += 1;
  if (version !== BACKUP_VERSION) throw new Error(`unsupported backup version ${version}`);
  const salt = buf.subarray(off, off += SALT_LEN);
  const iv = buf.subarray(off, off += IV_LEN);
  const tag = buf.subarray(off, off += TAG_LEN);
  const ct = buf.subarray(off);
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('could not decrypt — wrong passphrase or the file is damaged');
  }
}

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

/**
 * Build the encrypted holistic backup. Returns { ok, filePath, sizeBytes, manifest }.
 *
 * Snapshotters are injected so this is testable without MCP:
 *   snapshotPhylactery(destPath) / snapshotUnruh(destPath) → { ok, filePath?, error? }
 *
 * @param {object} o
 * @param {string} o.rootDir      install root (holds tomes/, settings.json, media/, logs/)
 * @param {string} o.outPath      where to write the .pfbackup
 * @param {string} o.passphrase   encryption passphrase
 * @param {boolean} [o.includeMedia] bundle media/ (bulky; default false)
 * @param {boolean} [o.includeLogs]  bundle logs/ (session history; default false)
 * @param {string} [o.appVersion]  stamped in the manifest
 */
export async function createHolisticBackup({
  rootDir, outPath, passphrase, includeMedia = false, includeLogs = false,
  appVersion = 'unknown', snapshotPhylactery, snapshotUnruh, now = new Date(),
}) {
  if (!passphrase || typeof passphrase !== 'string' || passphrase.length < 1) throw new Error('a passphrase is required');
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'pf-backup-'));
  const included = [];
  try {
    // 1. Clean db snapshots via each service's VACUUM INTO tool.
    if (typeof snapshotPhylactery === 'function') {
      const r = await snapshotPhylactery(path.join(staging, 'phylactery.db'));
      if (r?.ok && await exists(path.join(staging, 'phylactery.db'))) included.push('phylactery.db');
      else throw new Error(`Phylactery snapshot failed: ${r?.error ?? 'unknown'}`);
    }
    if (typeof snapshotUnruh === 'function') {
      const r = await snapshotUnruh(path.join(staging, 'unruh.db'));
      if (r?.ok && await exists(path.join(staging, 'unruh.db'))) included.push('unruh.db');
      else throw new Error(`Unruh snapshot failed: ${r?.error ?? 'unknown'}`);
    }

    // 2. Copy the file/dir stores into the staging tree.
    const copyIn = async (relSrc, relDst = relSrc) => {
      const src = path.join(rootDir, relSrc);
      if (!await exists(src)) return false;
      await fsp.cp(src, path.join(staging, relDst), { recursive: true });
      included.push(relDst);
      return true;
    };
    await copyIn('tomes');
    await copyIn('settings.json');
    if (includeMedia) await copyIn('media');
    if (includeLogs)  await copyIn('logs');

    // 3. Manifest — what's inside, so a future restore/import knows the layout
    //    and the version, and so `list`ing a backup doesn't need to decrypt-untar
    //    guess. (It lives INSIDE the encrypted tar, not in the clear.)
    const manifest = {
      format: 'proto-familiar-holistic-backup',
      version: BACKUP_VERSION,
      appVersion,
      createdAt: now.toISOString(),
      includes: included.slice().sort(),
      includedMedia: includeMedia && included.includes('media'),
      includedLogs: includeLogs && included.includes('logs'),
    };
    await fsp.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // 4. gzipped tar of the whole staging tree → encrypt → write.
    const tarPath = path.join(staging, '.bundle.tgz');
    await tar.c({ gzip: true, file: tarPath, cwd: staging, portable: true },
      ['manifest.json', ...included]);
    const plaintext = await fsp.readFile(tarPath);
    const container = encryptBundle(plaintext, passphrase);
    await fsp.writeFile(outPath, container);
    const { size } = await fsp.stat(outPath);
    return { ok: true, filePath: outPath, sizeBytes: size, manifest };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
