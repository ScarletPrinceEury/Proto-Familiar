// The server-owned PID file (2026-09-17): the process writes its own pid so
// stop.sh/stop.bat kill the real node, not a launcher's wrapper/subshell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';

import { writePidFile, clearPidFile } from '../src/server/pid-file.js';

function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pidfile-'));
  return { file: path.join(dir, '.proto-familiar.pid'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('writePidFile writes the given pid (trailing newline, parseable)', () => {
  const { file, cleanup } = tmp();
  try {
    assert.equal(writePidFile(file, 4242), true);
    assert.equal(readFileSync(file, 'utf8').trim(), '4242');
  } finally { cleanup(); }
});

test('writePidFile defaults to this process pid', () => {
  const { file, cleanup } = tmp();
  try {
    writePidFile(file);
    assert.equal(readFileSync(file, 'utf8').trim(), String(process.pid));
  } finally { cleanup(); }
});

test('clearPidFile removes the file when it names the given pid', () => {
  const { file, cleanup } = tmp();
  try {
    writePidFile(file, 4242);
    assert.equal(clearPidFile(file, 4242), true);
    assert.equal(existsSync(file), false);
  } finally { cleanup(); }
});

test('clearPidFile does NOT remove a file that names a DIFFERENT pid (successor-race guard)', () => {
  const { file, cleanup } = tmp();
  try {
    // A successor instance already wrote its own pid; my shutdown must not eat it.
    writePidFile(file, 9999);
    assert.equal(clearPidFile(file, 4242), false, 'not mine → left alone');
    assert.equal(existsSync(file), true);
    assert.equal(readFileSync(file, 'utf8').trim(), '9999');
  } finally { cleanup(); }
});

test('clearPidFile on a missing file is a no-op that never throws', () => {
  const { file, cleanup } = tmp();
  try {
    assert.equal(clearPidFile(file, 4242), false);
  } finally { cleanup(); }
});

test('clearPidFile tolerates a whitespace/newline-padded pid', () => {
  const { file, cleanup } = tmp();
  try {
    writeFileSync(file, '  4242\n\n');
    assert.equal(clearPidFile(file, 4242), true);
    assert.equal(existsSync(file), false);
  } finally { cleanup(); }
});

test('writePidFile to an unwritable path returns false, never throws (best-effort)', () => {
  // A path whose parent directory does not exist can't be written.
  const bogus = path.join(os.tmpdir(), 'pidfile-does-not-exist-xyz', 'nested', '.proto-familiar.pid');
  assert.equal(writePidFile(bogus, 4242), false);
});
