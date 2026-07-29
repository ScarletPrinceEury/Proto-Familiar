import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeSettings } from '../settings-merge.js';

/**
 * These exist because this code silently destroyed data.
 *
 * PUT /api/settings wrote the body wholesale. `voiceTts` was on disk, the UI
 * synced once without it, and it was gone — which sent a whole voice test
 * through the wrong engine before anyone noticed.
 */

test('a key the client never mentioned survives', () => {
  // The exact shape that ate voiceTts: a UI sync carrying only what the
  // browser knows about.
  const out = mergeSettings(
    { userName: 'old', voiceTts: { backend: 'pocket', voice: 'vctk/p255_023/enhanced' } },
    { userName: 'Broeckchen', charName: 'Familiar' },
  );
  assert.deepEqual(out.voiceTts, { backend: 'pocket', voice: 'vctk/p255_023/enhanced' });
  assert.equal(out.userName, 'Broeckchen', 'and the client key still applies');
  assert.equal(out.charName, 'Familiar');
});

test('a key the client DID send is replaced wholesale, not deep-merged', () => {
  // Deep-merging would make removing a sub-key impossible and would resurrect
  // settings somebody deliberately cleared.
  const out = mergeSettings(
    { voiceTts: { backend: 'pocket', voice: 'a', speed: 0.5 } },
    { voiceTts: { backend: 'sherpa' } },
  );
  assert.deepEqual(out.voiceTts, { backend: 'sherpa' },
    'the sharp edge callers must know about: send the object whole');
});

test('an explicit null deletes, so a client can still remove what it owns', () => {
  const out = mergeSettings({ a: 1, b: 2 }, { b: null });
  assert.deepEqual(out, { a: 1 });
});

test('undefined is not a deletion — only null is', () => {
  // `{b: undefined}` survives JSON as an absent key, but a direct caller could
  // pass it. Absence must mean "no opinion".
  const out = mergeSettings({ a: 1, b: 2 }, { b: undefined });
  assert.equal(out.a, 1);
  assert.ok('b' in out, 'undefined is not a delete instruction');
});

test('arrays are replaced, never merged', () => {
  // Connections are an array sent whole; index-merging would create hybrids
  // that were never a real configuration.
  const out = mergeSettings(
    { connections: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    { connections: [{ id: 'z' }] },
  );
  assert.deepEqual(out.connections, [{ id: 'z' }]);
});

test('falsy values are kept — they are real settings, not absence', () => {
  const out = mergeSettings(
    { voiceEnabled: true, speed: 1, label: 'x' },
    { voiceEnabled: false, speed: 0, label: '' },
  );
  assert.equal(out.voiceEnabled, false, 'false is a choice');
  assert.equal(out.speed, 0, '0 is a value');
  assert.equal(out.label, '', 'empty string is a value');
});

test('no prior settings — the first write stands alone', () => {
  assert.deepEqual(mergeSettings(null, { a: 1 }), { a: 1 });
  assert.deepEqual(mergeSettings(undefined, { a: 1 }), { a: 1 });
  assert.deepEqual(mergeSettings('not json', { a: 1 }), { a: 1 });
  assert.deepEqual(mergeSettings([], { a: 1 }), { a: 1 }, 'an array prior is not settings');
});

test('an unusable payload preserves what exists rather than blanking it', () => {
  // A malformed request is not an instruction to erase someone's setup.
  const prior = { voiceTts: { voice: 'keep me' }, userName: 'Broeckchen' };
  for (const bad of [null, undefined, [], 'string', 42]) {
    assert.deepEqual(mergeSettings(prior, bad), prior, `payload ${JSON.stringify(bad)}`);
  }
});

test('the prior object is never mutated', () => {
  // The caller diffs prior against next to decide whether to respawn
  // Phylactery. Mutating it would make that comparison lie.
  const prior = { a: 1, voiceTts: { voice: 'x' } };
  const snapshot = JSON.parse(JSON.stringify(prior));
  mergeSettings(prior, { a: 2, b: null });
  assert.deepEqual(prior, snapshot);
});

test('merging is idempotent — replaying a PUT changes nothing further', () => {
  const prior = { a: 1, voiceTts: { voice: 'x' } };
  const once = mergeSettings(prior, { a: 2 });
  const twice = mergeSettings(once, { a: 2 });
  assert.deepEqual(twice, once);
});

test('a null for a key that does not exist is harmless', () => {
  assert.deepEqual(mergeSettings({ a: 1 }, { missing: null }), { a: 1 });
});
