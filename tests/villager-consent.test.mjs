import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isConsentCommand,
  parseConsentCommand,
  buildConsentMenu,
  consentHelpText,
  CATEGORY_LABELS,
} from '../villager-consent.js';

describe('isConsentCommand', () => {
  it('matches !consent with and without arguments', () => {
    assert.equal(isConsentCommand('!consent'), true);
    assert.equal(isConsentCommand('  !consent keep all'), true);
    assert.equal(isConsentCommand('!CONSENT'), true);
  });
  it('does not match ordinary chat', () => {
    assert.equal(isConsentCommand('I consent to nothing'), false);
    assert.equal(isConsentCommand('!consenting'), false);
    assert.equal(isConsentCommand(''), false);
  });
});

describe('parseConsentCommand', () => {
  it('bare command → menu', () => {
    assert.deepEqual(parseConsentCommand('!consent'), { action: 'menu' });
  });
  it('keep/ask/never map to true/"ask"/false', () => {
    assert.deepEqual(parseConsentCommand('!consent keep health'),
      { action: 'set', gate: true, categories: ['health_info'] });
    assert.deepEqual(parseConsentCommand('!consent ask feelings'),
      { action: 'set', gate: 'ask', categories: ['emotional_content'] });
    assert.deepEqual(parseConsentCommand('!consent never whereabouts'),
      { action: 'set', gate: false, categories: ['whereabouts'] });
  });
  it('"all" expands to every category', () => {
    const cmd = parseConsentCommand('!consent keep all');
    assert.equal(cmd.action, 'set');
    assert.equal(cmd.categories.length, Object.keys(CATEGORY_LABELS).length);
  });
  it('multiple categories in one command', () => {
    const cmd = parseConsentCommand('!consent never health whereabouts');
    assert.deepEqual(cmd.categories, ['health_info', 'whereabouts']);
  });
  it('unknown verb or category → help with a message', () => {
    assert.equal(parseConsentCommand('!consent frobnicate all').action, 'help');
    assert.equal(parseConsentCommand('!consent keep nonsense').action, 'help');
    assert.equal(parseConsentCommand('!consent keep').action, 'help');
  });
  it('non-command → null', () => {
    assert.equal(parseConsentCommand('hello there'), null);
  });
});

describe('buildConsentMenu', () => {
  const villager = { id: 'v-sam', name: 'Sam', remember: { health_info: false, basics: true } };
  it('shows memories, pending, settings, and the how-to line', () => {
    const menu = buildConsentMenu({
      villager,
      memories: [{ id: 'm1', brief: 'Sam started a pottery class', date: '2026-07-01', category: 'basics' }],
      pending:  [{ id: 'p1', brief: 'Sam mentioned a clinic visit', date: '2026-07-15', category: 'health_info' }],
    });
    assert.match(menu, /Sam started a pottery class/);
    assert.match(menu, /clinic visit/);
    assert.match(menu, /health: \*\*never\*\*/);
    assert.match(menu, /basics.*\*\*keep\*\*/);
    assert.match(menu, /!consent keep\|ask\|never/);
  });
  it('unset categories default to ask', () => {
    const menu = buildConsentMenu({ villager: { id: 'v', name: 'Kim' }, memories: [], pending: [] });
    assert.match(menu, /relationships: \*\*ask\*\*/);
  });
  it('empty stores say so plainly instead of rendering nothing', () => {
    const menu = buildConsentMenu({ villager: { id: 'v', name: 'Kim' }, memories: [], pending: [] });
    assert.match(menu, /nothing right now/);
    assert.match(menu, /nothing pending/);
  });
  it('long lists truncate with a count instead of flooding the DM', () => {
    const memories = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, brief: `fact ${i}`, category: 'basics' }));
    const menu = buildConsentMenu({ villager, memories, pending: [] });
    assert.match(menu, /and 12 more/);
  });
});

describe('consentHelpText', () => {
  it('carries the error and the usage line', () => {
    const t = consentHelpText('I don\'t know "frobnicate".');
    assert.match(t, /frobnicate/);
    assert.match(t, /keep\|ask\|never/);
  });
});
