import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImport, parseTimestampedText, toIso } from '../log-import.js';

test('toIso handles epoch seconds, ms, and ISO; rejects junk', () => {
  assert.equal(toIso(1_750_000_000).slice(0, 4), '2025');       // seconds
  assert.equal(toIso(1_750_000_000_000).slice(0, 4), '2025');   // ms
  assert.equal(toIso('2026-06-20T14:35:00Z'), '2026-06-20T14:35:00.000Z');
  assert.equal(toIso('not a date'), null);
  assert.equal(toIso(null), null);
});

test('parses a Proto-Familiar session-log JSON object', () => {
  const raw = JSON.stringify({
    sessionId: 's1',
    messages: [
      { role: 'user', content: 'hi', timestamp: '2026-06-20T09:00:00Z' },
      { role: 'assistant', content: 'hello', timestamp: '2026-06-20T09:01:00Z' },
    ],
  });
  const r = parseImport(raw);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'Proto-Familiar JSON');
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[1].role, 'assistant');
});

test('parses a bundle (array of session logs)', () => {
  const raw = JSON.stringify([
    { messages: [{ role: 'user', content: 'a', timestamp: '2026-06-20T09:00:00Z' }] },
    { messages: [{ role: 'assistant', content: 'b', timestamp: '2026-06-21T09:00:00Z' }] },
  ]);
  const r = parseImport(raw);
  assert.equal(r.ok, true);
  assert.equal(r.messages.length, 2);
});

test('timestamped text: role mapping via selfNames, continuation lines', () => {
  const raw = [
    '[2026-06-20 14:35] Ada: hey there',
    'this line continues Ada',
    '[2026-06-20 14:36] Sage: hello Ada',
  ].join('\n');
  const r = parseImport(raw, { selfNames: ['Sage'] });
  assert.equal(r.ok, true);
  assert.equal(r.format, 'timestamped text');
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].role, 'user');           // Ada → human
  assert.match(r.messages[0].content, /continues Ada/); // continuation folded in
  assert.equal(r.messages[1].role, 'assistant');      // Sage → self
});

test('timestamped text with no parseable timestamp anywhere is rejected', () => {
  const raw = '[whenever] Ada: hi\n[later] Sage: yo';
  // parseImport falls through both parsers → error
  const direct = parseTimestampedText(raw);
  assert.equal(direct, null);
});

test('unknown format → loud structured error listing what is supported', () => {
  const r = parseImport('just some prose with no structure at all');
  assert.equal(r.ok, false);
  assert.match(r.error, /Supported:/);
});

test('empty input is rejected', () => {
  assert.equal(parseImport('').ok, false);
  assert.equal(parseImport('   ').ok, false);
});
