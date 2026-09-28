// The one low-level settings.json reader (settings-store.js), extracted so
// cerebellum.js and thalamus.js share ONE implementation instead of each
// inlining `JSON.parse(readFileSync(SETTINGS_FILE))`. The {}-on-failure
// contract is what lets all 19 call sites read a field with their own default
// and never guard the parse — so it's pinned here against real fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SETTINGS_FILE, readSettingsSync } from '../settings-store.js';
import * as cerebellum from '../cerebellum.js';

test('SETTINGS_FILE points at the canonical settings.json', () => {
  assert.equal(path.basename(SETTINGS_FILE), 'settings.json');
});

test('valid JSON is parsed and returned', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-settings-'));
  const f = path.join(dir, 'settings.json');
  try {
    writeFileSync(f, JSON.stringify({ userName: 'Sam', trackersEnabled: false }));
    const s = readSettingsSync(f);
    assert.equal(s.userName, 'Sam');
    assert.equal(s.trackersEnabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing file yields {} (fresh install), never throws', () => {
  const missing = path.join(tmpdir(), 'pf-settings-does-not-exist-' + Date.now(), 'settings.json');
  const s = readSettingsSync(missing);
  assert.deepEqual(s, {});
});

test('malformed JSON yields {} (torn write), never throws', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-settings-'));
  const f = path.join(dir, 'settings.json');
  try {
    writeFileSync(f, '{ this is not valid json ');
    assert.deepEqual(readSettingsSync(f), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the default (no-arg) read returns a plain object and never throws', () => {
  const s = readSettingsSync();
  assert.equal(typeof s, 'object');
  assert.ok(s !== null && !Array.isArray(s));
});

test('cerebellum re-exports the SAME reader (one implementation, not a copy)', () => {
  // The re-export is what keeps server.js + the loops importing readSettingsSync
  // from cerebellum while the implementation lives in the leaf module.
  assert.equal(cerebellum.readSettingsSync, readSettingsSync);
});
