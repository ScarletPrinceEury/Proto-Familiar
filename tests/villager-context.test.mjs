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

// ── Stage 2: the gated recent-memory sub-block ───────────────────────────────
import { formatVillagerMemoryRecall } from '../src/warmth/villager-context.js';

const memItems = [
  { id: 'sam-tea-1', category: 'daily', brief: 'Sam likes strong tea', date: '2026-07-01' },
  { id: 'sam-gig-2', category: 'daily', brief: 'Sam had a gig Friday', date: '2026-07-03' },
];

test('formatVillagerMemoryRecall: names the villager, lists the briefs, plain', () => {
  const block = formatVillagerMemoryRecall('Chen', memItems);
  assert.match(block, /\[What Chen and I have been talking about lately\]/);
  assert.match(block, /Sam likes strong tea/);
  assert.match(block, /Sam had a gig Friday/);
  assert.doesNotMatch(block, /when it fits|if the moment/i);
});

test('formatVillagerMemoryRecall: empty items → empty string', () => {
  assert.equal(formatVillagerMemoryRecall('Chen', []), '');
  assert.equal(formatVillagerMemoryRecall('Chen', null), '');
});

test('buildVillagerContextBlock: combines reach recall AND gated memory when both present', async () => {
  const reader = async () => knocks;                               // reach-out recall (Stage 1)
  const memoryReader = async ({ villagerId }) => ({ ok: true, items: villagerId === 'chen-x1' ? memItems : [] });
  const block = await buildVillagerContextBlock({
    focalVillager: { id: 'chen-x1', name: 'Chen' },
    grants: { proactiveContext: true }, settings: {}, reader, memoryReader,
  });
  assert.match(block, /What I last said to Chen/);                 // Stage 1
  assert.match(block, /What Chen and I have been talking about/);  // Stage 2
});

test('buildVillagerContextBlock: no memoryReader → just Stage 1 (back-compat)', async () => {
  const block = await buildVillagerContextBlock({
    focalVillager: { id: 'chen-x1', name: 'Chen' },
    grants: { proactiveContext: true }, settings: {}, reader: async () => knocks,
  });
  assert.match(block, /What I last said to Chen/);
  assert.doesNotMatch(block, /been talking about/);
});

test('buildVillagerContextBlock: a throwing memoryReader still yields Stage 1, never blocks', async () => {
  const block = await buildVillagerContextBlock({
    focalVillager: { id: 'chen-x1', name: 'Chen' },
    grants: { proactiveContext: true }, settings: {},
    reader: async () => knocks,
    memoryReader: async () => { throw new Error('phylactery down'); },
  });
  assert.match(block, /What I last said to Chen/, 'the memory read failing must not lose the reach recall');
});

test('buildVillagerContextBlock: no grant → neither reader runs', async () => {
  let ranMem = false;
  await buildVillagerContextBlock({
    focalVillager: { id: 'chen-x1', name: 'Chen' }, grants: {}, settings: {},
    reader: async () => knocks, memoryReader: async () => { ranMem = true; return { items: memItems }; },
  });
  assert.equal(ranMem, false);
});

// ── Stage 3: the "meaning to bring up" tells sub-block ───────────────────────
import { formatVillagerTells } from '../src/warmth/villager-context.js';

const tellItems = [
  { id: 't1', content: 'ask how the gig went' },
  { id: 't2', content: 'tell them about the tea place' },
];

test('formatVillagerTells: names the villager, lists the tells, plain and hedge-free', () => {
  const block = formatVillagerTells('Chen', tellItems);
  assert.match(block, /\[What I've been meaning to bring up with Chen\]/);
  assert.match(block, /ask how the gig went/);
  assert.match(block, /tell them about the tea place/);
  assert.doesNotMatch(block, /when it fits|if the moment|say it when/i);
});

test('formatVillagerTells: empty → empty string', () => {
  assert.equal(formatVillagerTells('Chen', []), '');
  assert.equal(formatVillagerTells('Chen', null), '');
});

test('buildVillagerContextBlock: tells lead, then reach recall, then memory', async () => {
  const block = await buildVillagerContextBlock({
    focalVillager: { id: 'chen-x1', name: 'Chen' },
    grants: { proactiveContext: true }, settings: {},
    tellsReader: async () => ({ items: tellItems }),
    reader: async () => knocks,
    memoryReader: async () => ({ items: memItems }),
  });
  const iTell = block.indexOf('meaning to bring up');
  const iReach = block.indexOf('What I last said');
  const iMem = block.indexOf('been talking about');
  assert.ok(iTell >= 0 && iReach >= 0 && iMem >= 0, 'all three present');
  assert.ok(iTell < iReach && iReach < iMem, 'tells → reach → memory order');
});

test('buildVillagerContextBlock: a throwing tellsReader still yields the other blocks', async () => {
  const block = await buildVillagerContextBlock({
    focalVillager: { id: 'chen-x1', name: 'Chen' },
    grants: { proactiveContext: true }, settings: {},
    tellsReader: async () => { throw new Error('phylactery down'); },
    reader: async () => knocks,
  });
  assert.match(block, /What I last said to Chen/, 'a tells read failing never blocks the turn');
});

test('buildVillagerContextBlock: no grant → tellsReader never runs', async () => {
  let ran = false;
  await buildVillagerContextBlock({
    focalVillager: { id: 'chen-x1', name: 'Chen' }, grants: {}, settings: {},
    tellsReader: async () => { ran = true; return { items: tellItems }; },
  });
  assert.equal(ran, false);
});
