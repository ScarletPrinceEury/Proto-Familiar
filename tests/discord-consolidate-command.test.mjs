// The ward-only !consolidate DM command matcher (2026-09) — the twin of the
// UI's "run a consolidation pass now" buttons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConsolidateCommand } from '../src/discord/discord-gateway.js';

test('parseConsolidateCommand: subcommands, aliases, help, and non-matches', () => {
  // ponderings + aliases
  assert.equal(parseConsolidateCommand('!consolidate ponderings'), 'ponderings');
  assert.equal(parseConsolidateCommand('!consolidate pondering'), 'ponderings');
  assert.equal(parseConsolidateCommand('!consolidate ponder'), 'ponderings');
  // memory + aliases
  assert.equal(parseConsolidateCommand('!consolidate memory'), 'memory');
  assert.equal(parseConsolidateCommand('!consolidate memories'), 'memory');
  assert.equal(parseConsolidateCommand('!consolidate mem'), 'memory');
  // case-insensitive + trailing/leading space
  assert.equal(parseConsolidateCommand('  !CONSOLIDATE Memory  '), 'memory');
  // bare → help
  assert.equal(parseConsolidateCommand('!consolidate'), 'help');
  // unknown arg → help (don't silently do the wrong pass)
  assert.equal(parseConsolidateCommand('!consolidate everything'), 'help');
  // non-matches
  assert.equal(parseConsolidateCommand('consolidate memory'), null, 'no bang → not a command');
  assert.equal(parseConsolidateCommand('!consolidated'), null, 'must be the whole word');
  assert.equal(parseConsolidateCommand('please !consolidate memory'), null, 'must start the line');
  assert.equal(parseConsolidateCommand(''), null);
  assert.equal(parseConsolidateCommand(null), null);
});
