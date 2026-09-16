// Villager proactive context (v1) — reach-out recall for a warm villager DM,
// gated behind the proactiveContext grant. The villager-side mirror of the
// ward's "[I reached out first]" continuity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  villagerContextOn, villagerContextEligible,
  formatVillagerReachRecall, buildVillagerContextBlock,
} from '../src/warmth/villager-context.js';

// ── off-switch ───────────────────────────────────────────────────────────────
test('villagerContextOn: default on; setting false or env kill-switch turns it off', () => {
  assert.equal(villagerContextOn({}), true);
  assert.equal(villagerContextOn({ villagerContextEnabled: false }), false);
  const saved = process.env.PROTO_FAMILIAR_VILLAGER_CONTEXT_DISABLED;
  process.env.PROTO_FAMILIAR_VILLAGER_CONTEXT_DISABLED = '1';
  try { assert.equal(villagerContextOn({ villagerContextEnabled: true }), false); }
  finally { if (saved === undefined) delete process.env.PROTO_FAMILIAR_VILLAGER_CONTEXT_DISABLED; else process.env.PROTO_FAMILIAR_VILLAGER_CONTEXT_DISABLED = saved; }
});

// ── eligibility: focal villager + the grant, both required ───────────────────
test('villagerContextEligible: needs a focal villager AND the proactiveContext grant', () => {
  const v = { id: 'chen-x1', name: 'Chen' };
  assert.equal(villagerContextEligible({ focalVillager: v, grants: { proactiveContext: true } }), true);
  assert.equal(villagerContextEligible({ focalVillager: v, grants: {} }), false, 'no grant → no');
  assert.equal(villagerContextEligible({ focalVillager: v, grants: { proactiveContext: false } }), false);
  assert.equal(villagerContextEligible({ focalVillager: null, grants: { proactiveContext: true } }), false, 'no focal person → no');
  assert.equal(villagerContextEligible({ focalVillager: { name: 'x' }, grants: { proactiveContext: true } }), false, 'focal needs an id');
});

// ── the rendered recall ──────────────────────────────────────────────────────
const knocks = [
  { at: new Date(Date.now() - 2 * 3600_000).toISOString(), message: 'hey, how did the gig go?', about: 'their Friday gig', recipientId: 'chen-x1', shown: 0 },
];

test('formatVillagerReachRecall: names the villager, recalls the message, plain and hedge-free', () => {
  const block = formatVillagerReachRecall('Chen', knocks);
  assert.match(block, /\[What I last said to Chen\]/);
  assert.match(block, /how did the gig go\?/);
  assert.match(block, /Chen replies to something I did not just say/);
  // No ward framing leaks in, and no timing-hedge language.
  assert.doesNotMatch(block, /my human/);
  assert.doesNotMatch(block, /when it fits|if the moment/i);
});

test('formatVillagerReachRecall: empty knocks → empty string', () => {
  assert.equal(formatVillagerReachRecall('Chen', []), '');
  assert.equal(formatVillagerReachRecall('Chen', null), '');
});

test('formatVillagerReachRecall: the ward-session provenance line is never carried in', () => {
  const withSource = [{
    at: new Date(Date.now() - 3600_000).toISOString(), message: 'x', recipientId: 'chen-x1', shown: 0,
    source: { sessionId: 's-ward-secret', kind: 'conversation', roster: ['Maus'] },
  }];
  const block = formatVillagerReachRecall('Chen', withSource);
  assert.doesNotMatch(block, /where this came from/);
  assert.doesNotMatch(block, /s-ward-secret/);
  assert.doesNotMatch(block, /Maus/);
});

// ── the gated orchestrator ───────────────────────────────────────────────────
test('buildVillagerContextBlock: renders for an eligible DM via the injected reader', async () => {
  const reader = async ({ recipientId }) => (recipientId === 'chen-x1' ? knocks : []);
  const block = await buildVillagerContextBlock({
    focalVillager: { id: 'chen-x1', name: 'Chen' },
    grants: { proactiveContext: true },
    settings: {}, reader,
  });
  assert.match(block, /What I last said to Chen/);
});

test('buildVillagerContextBlock: no grant → empty (reader never even runs)', async () => {
  let ran = false;
  const reader = async () => { ran = true; return knocks; };
  const block = await buildVillagerContextBlock({
    focalVillager: { id: 'chen-x1', name: 'Chen' }, grants: {}, settings: {}, reader,
  });
  assert.equal(block, '');
  assert.equal(ran, false, 'gate short-circuits before any read');
});

test('buildVillagerContextBlock: off-switch → empty', async () => {
  const block = await buildVillagerContextBlock({
    focalVillager: { id: 'chen-x1', name: 'Chen' },
    grants: { proactiveContext: true },
    settings: { villagerContextEnabled: false },
    reader: async () => knocks,
  });
  assert.equal(block, '');
});

test('buildVillagerContextBlock: a throwing reader degrades to empty, never blocks the turn', async () => {
  const block = await buildVillagerContextBlock({
    focalVillager: { id: 'chen-x1', name: 'Chen' },
    grants: { proactiveContext: true },
    settings: {}, reader: async () => { throw new Error('disk gone'); },
  });
  assert.equal(block, '');
});
