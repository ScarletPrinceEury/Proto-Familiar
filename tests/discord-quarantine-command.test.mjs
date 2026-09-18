// The ward-only !quarantine DM command matcher — the twin of the UI's "Review
// held memories" (memory-integrity Stage 1). Lists / releases / discards the
// facts the memorization scan set aside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuarantineCommand } from '../src/discord/discord-gateway.js';

test('parseQuarantineCommand: list, release, discard, aliases, help, non-matches', () => {
  // bare + explicit list
  assert.deepEqual(parseQuarantineCommand('!quarantine'), { action: 'list' });
  assert.deepEqual(parseQuarantineCommand('!quarantine list'), { action: 'list' });
  assert.deepEqual(parseQuarantineCommand('  !QUARANTINE  '), { action: 'list' }, 'case-insensitive + trimmed');

  // release + aliases, carrying the id
  assert.deepEqual(parseQuarantineCommand('!quarantine release pantry-lie-x7'), { action: 'release', id: 'pantry-lie-x7' });
  assert.deepEqual(parseQuarantineCommand('!quarantine keep quar-abc123'), { action: 'release', id: 'quar-abc123' });
  assert.deepEqual(parseQuarantineCommand('!quarantine restore some-slug-9k'), { action: 'release', id: 'some-slug-9k' });

  // discard + aliases
  assert.deepEqual(parseQuarantineCommand('!quarantine discard bad-fact-z2'), { action: 'discard', id: 'bad-fact-z2' });
  assert.deepEqual(parseQuarantineCommand('!quarantine drop bad-fact-z2'), { action: 'discard', id: 'bad-fact-z2' });
  assert.deepEqual(parseQuarantineCommand('!quarantine reject bad-fact-z2'), { action: 'discard', id: 'bad-fact-z2' });

  // release/discard WITHOUT an id → the action, id null (the handler asks for one)
  assert.deepEqual(parseQuarantineCommand('!quarantine release'), { action: 'release', id: null });
  assert.deepEqual(parseQuarantineCommand('!quarantine discard'), { action: 'discard', id: null });

  // a hyphenated slug id survives intact (ids are slugs, not bare words)
  assert.equal(parseQuarantineCommand('!quarantine release a-b-c-d-e2').id, 'a-b-c-d-e2');

  // unknown subcommand → help (never guess an action)
  assert.deepEqual(parseQuarantineCommand('!quarantine wat'), { action: 'help' });

  // non-matches
  assert.equal(parseQuarantineCommand('quarantine list'), null, 'no bang → not a command');
  assert.equal(parseQuarantineCommand('!quarantined'), null, 'must be the whole word');
  assert.equal(parseQuarantineCommand('please !quarantine'), null, 'must start the line');
  assert.equal(parseQuarantineCommand(''), null);
  assert.equal(parseQuarantineCommand(null), null);
});
