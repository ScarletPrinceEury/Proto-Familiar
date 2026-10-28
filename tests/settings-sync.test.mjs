/**
 * Settings saves can't wipe what another page saved (2026-10-28).
 *
 * Saved connections vanished: every page PUT its whole copy of the synced
 * settings, so a page holding an old copy wrote it over the real one. These
 * tests run the real server decision (settings-write.js `putSettings`) against
 * the real page code (public/app.js, extracted into a vm), on a temp file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { writeSettings, putSettings, revisionsOf } from '../settings-write.js';
import { extractFunctionSource } from './_vm-extract.mjs';

const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const PAGE_FNS = ['settingsJson', 'setSettingsBase', 'settingsPatch', 'rebaseSettingValue',
  'mergeConnectionsByIntent', 'applyRemoteSettings', 'flushSettings', 'refreshSettingsFromServer'];

function tempFile(initial) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-settings-'));
  const file = path.join(dir, 'settings.json');
  if (initial !== undefined) writeFileSync(file, typeof initial === 'string' ? initial : JSON.stringify(initial));
  return { file, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

// A page: the real app.js sync functions, a `state`, and a fetch that goes to
// putSettings / the file, exactly like the route does.
function makePage(file, state) {
  const ctx = {
    SERVER_SYNCED_KEYS: ['connections', 'primaryConnectionId', 'streaming'],
    state,
    _settingsBase: null, _settingsFlushing: null, _settingsFlushAgain: false,
    localStorage: { setItem() {} },
    writeSettingsToUI() {}, renderConnectionsList() {},
    console: { log() {}, warn() {} },
    puts: [],
    async fetch(url, opts = {}) {
      if (opts.method === 'PUT') {
        const body = JSON.parse(opts.body);
        ctx.puts.push(body);
        const r = await putSettings(body, { file });
        return { ok: r.status === 200, status: r.status, json: async () => JSON.parse(JSON.stringify(r.body)) };
      }
      return { ok: true, status: 200, json: async () => ({ settings: read(file) }) };
    },
  };
  // extractFunctionSource starts at `function name`, so put back an `async`.
  const src = PAGE_FNS.map(n => {
    const fn = extractFunctionSource(APP, n);
    const at = APP.indexOf(fn);
    return (APP.slice(at - 6, at) === 'async ' ? 'async ' : '') + fn;
  });
  runInNewContext(src.join('\n'), ctx);
  return ctx;
}

const A = { id: 'a', name: 'GLM 5.3' }, B = { id: 'b', name: 'DeepSeek v4 Pro' }, C = { id: 'c', name: 'Muse 1.3' };

// ── The server writer ────────────────────────────────────────────────────────

test('a changed key gets its revision bumped; an unchanged one does not', async () => {
  const t = tempFile({ streaming: true });
  try {
    let w = await writeSettings({ streaming: true, model: 'x' }, { file: t.file });
    assert.deepEqual(w.changed, ['model']);
    assert.deepEqual(revisionsOf(read(t.file)), { model: 1 });
    w = await writeSettings({ model: null }, { file: t.file });
    assert.deepEqual(w.changed, ['model']);
    assert.equal('model' in read(t.file), false, 'null deletes');
    assert.equal(revisionsOf(read(t.file)).model, 2);
  } finally { t.done(); }
});

test('a save based on an old revision of a key is refused, and nothing is written', async () => {
  const t = tempFile({ connections: [A, B, C], _revisions: { connections: 2 } });
  try {
    const w = await writeSettings({ connections: [A] }, { base: { connections: 1 }, file: t.file });
    assert.equal(w.code, 'conflict');
    assert.deepEqual(w.conflicts, ['connections']);
    assert.deepEqual(read(t.file).connections, [A, B, C]);
    // Same value on an old base isn't a conflict: there's nothing to lose.
    assert.equal((await writeSettings({ connections: [A, B, C] }, { base: { connections: 1 }, file: t.file })).ok, true);
  } finally { t.done(); }
});

test('concurrent read-modify-writes both land (the function form runs under the lock)', async () => {
  const t = tempFile({ connections: [A] });
  try {
    const add = (c) => writeSettings(cur => ({ connections: [...(cur.connections ?? []), c] }), { file: t.file });
    await Promise.all([add(B), add(C)]);
    assert.deepEqual(read(t.file).connections.map(c => c.id).sort(), ['a', 'b', 'c']);
  } finally { t.done(); }
});

test('an unreadable settings.json is never overwritten', async () => {
  const t = tempFile('{"connections": [');
  try {
    const w = await writeSettings({ streaming: false }, { file: t.file });
    assert.equal(w.ok, false);
    assert.equal(w.code, 'unreadable');
    assert.equal(readFileSync(t.file, 'utf8'), '{"connections": [');
  } finally { t.done(); }
});

test('a page running the old code (no base) is refused', async () => {
  const t = tempFile({ connections: [A, B, C] });
  try {
    const r = await putSettings({ settings: { connections: [A] } }, { file: t.file });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'stale-page');
    assert.deepEqual(read(t.file).connections, [A, B, C]);
  } finally { t.done(); }
});

// ── The page ─────────────────────────────────────────────────────────────────

test('the incident: a page with an old copy toggles something, and the connections survive', async () => {
  const t = tempFile({ connections: [A], primaryConnectionId: 'a', streaming: true });
  try {
    const page = makePage(t.file, { connections: [A], primaryConnectionId: 'a', streaming: true });
    page.setSettingsBase(read(t.file));
    // Meanwhile, elsewhere: DeepSeek and Muse are added and made primary.
    await writeSettings({ connections: [A, B, C], primaryConnectionId: 'b' }, { file: t.file });
    page.state.streaming = false;
    await page.flushSettings();
    const s = read(t.file);
    assert.deepEqual(s.connections, [A, B, C], 'the old page did not send its connections');
    assert.equal(s.primaryConnectionId, 'b');
    assert.equal(s.streaming, false);
    assert.deepEqual(Object.keys(page.puts[0].settings), ['streaming'], 'only the changed key went out');
  } finally { t.done(); }
});

test('an old page that edits its connections merges by id instead of overwriting', async () => {
  const t = tempFile({ connections: [A] });
  try {
    const page = makePage(t.file, { connections: [A] });
    page.setSettingsBase(read(t.file));
    await writeSettings({ connections: [A, B, C] }, { file: t.file });
    const D = { id: 'd', name: 'New one' };
    page.state.connections = [{ ...A, name: 'GLM 5.3 (renamed)' }, D];
    await page.flushSettings();
    assert.deepEqual(read(t.file).connections, [{ ...A, name: 'GLM 5.3 (renamed)' }, B, C, D]);
    assert.deepEqual(JSON.parse(JSON.stringify(page.state.connections)), read(t.file).connections, 'the page shows the merged list');
  } finally { t.done(); }
});

test('removing a connection here still removes it, without touching ones added elsewhere', async () => {
  const t = tempFile({ connections: [A, B] });
  try {
    const page = makePage(t.file, { connections: [A, B] });
    page.setSettingsBase(read(t.file));
    await writeSettings({ connections: [A, B, C] }, { file: t.file });
    page.state.connections = [B];
    await page.flushSettings();
    assert.deepEqual(read(t.file).connections, [B, C]);
  } finally { t.done(); }
});

test('nothing is saved before the page has read the server\'s copy', async () => {
  const t = tempFile({ connections: [A, B, C] });
  try {
    const page = makePage(t.file, { connections: [A], streaming: true });   // a stale local cache
    await page.flushSettings();                                              // the startup save
    assert.equal(page.puts.length, 0);
    assert.deepEqual(read(t.file).connections, [A, B, C]);
  } finally { t.done(); }
});

test('coming back to an open tab picks up changes made elsewhere', async () => {
  const t = tempFile({ connections: [A], primaryConnectionId: 'a' });
  try {
    const page = makePage(t.file, { connections: [A], primaryConnectionId: 'a' });
    page.setSettingsBase(read(t.file));
    await writeSettings({ connections: [A, B], primaryConnectionId: 'b' }, { file: t.file });
    await page.refreshSettingsFromServer();
    assert.deepEqual(JSON.parse(JSON.stringify(page.state.connections)), [A, B]);
    assert.equal(page.state.primaryConnectionId, 'b');
    assert.equal(page.puts.length, 0, 'nothing of its own to send');
  } finally { t.done(); }
});
