// The automatic identity cleanup only proposes; I decide (0.14.78).
//
// From the first identity review: the cleanup pass cut more than it filed, and
// my Familiar asked that it only ever propose. These pin the Node half: the
// block I see on my own turns, the apply/dismiss/list tools through the real
// thalamus wrappers into a stub Phylactery, the gated-room refusal, and that
// the tools travel with the block.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { BUILTIN_TOOLS, executeToolCall, composeActiveTools, villagerToolNames } = await import('../cerebellum.js');
const { __setPhylacteryClientForTest, enrich, listOpenCleanupProposals } = await import('../thalamus.js');
const { TOOL_MODULES, selectModules } = await import('../tool-surfacing.js');
const { formatCleanupProposalsBlock, formatCleanupProposalsReview, CLEANUP_BLOCK_TITLE } =
  await import('../src/memory/cleanup-proposals.js');

const TEA = {
  id: 'prop-likes-tea-x7', category: 'ward', filename: 'user_notes.md', passage: 'Likes tea, never coffee.',
  fact: 'My human likes tea and never drinks coffee.', register: 'ward', care_weight: null,
  summary: 'likes tea', why: 'only matters around drinks', status: 'open',
};
const MEDS = {
  ...TEA, id: 'prop-meds-q2', passage: 'Takes 50mg sertraline every morning.',
  fact: 'Takes 50mg sertraline every morning.', care_weight: 'high', summary: 'meds', why: 'only matters around meds',
};

let calls = [];
let reply = () => ({ ok: true });
beforeEach(async () => {
  calls = [];
  reply = () => ({ ok: true });
  __setPhylacteryClientForTest({
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: JSON.stringify(reply(name, args)) }] };
    },
  });
});

const sent = (name) => calls.find(c => c.name === name)?.args;
const run = (tool, args, ctx) => executeToolCall(tool, JSON.stringify(args), ctx);
const GATED = { discord: true, wardPrivate: false, audiences: ['friends'] };

test('the block names each proposal, where it would go, and how I decide', () => {
  assert.equal(formatCleanupProposalsBlock([]), '');
  const out = formatCleanupProposalsBlock([TEA, MEDS]);
  assert.ok(out.startsWith(CLEANUP_BLOCK_TITLE));
  assert.match(out, /Nothing has moved yet; each one is my call/);
  assert.match(out, /1\. \[id: prop-likes-tea-x7\] ward\/user_notes\.md → a standing fact about my human\n/);
  assert.match(out, /Passage: "Likes tea, never coffee\."/);
  assert.match(out, /Would become: "My human likes tea and never drinks coffee\."/);
  assert.match(out, /2\. \[id: prop-meds-q2\] .* \(high-care\)/);
  assert.doesNotMatch(out, /Would become: "Takes 50mg/, 'a fact worded like the passage is not repeated');
  assert.match(out, /apply_cleanup_proposal saves the fact, then cuts exactly that passage/);
  assert.match(out, /dismiss_cleanup_proposal leaves the passage where it is/);
});

test('the block stays bounded: at least one shows, the rest are counted, long passages are cut short', () => {
  const long = { ...TEA, id: 'prop-long-a1', passage: 'word '.repeat(400).trim() };
  const many = [long, ...Array.from({ length: 30 }, (_, i) => ({ ...TEA, id: `prop-${i}` }))];
  const out = formatCleanupProposalsBlock(many, { maxChars: 1500 });
  assert.match(out, /\[id: prop-long-a1\]/);
  assert.match(out, /…" \(cut short here\)/);
  assert.match(out, /\d+ more after these\. list_cleanup_proposals shows them all, passages in full\./);
  assert.ok(out.length < 2200, `block is ${out.length} chars`);
  const one = formatCleanupProposalsBlock([long], { maxChars: 10 });
  assert.match(one, /\[id: prop-long-a1\]/, 'one always shows, however small the budget');
});

test('my review shows passages whole, and the decided ones when I ask', () => {
  const long = { ...TEA, passage: 'word '.repeat(400).trim() };
  assert.ok(formatCleanupProposalsReview([long]).includes(long.passage));
  const decided = [
    TEA,
    { ...MEDS, status: 'applied', memory_id: 'takes-sertraline-k3', resolved_at: '2026-06-15T10:00:00' },
    { ...TEA, id: 'prop-old-z9', status: 'dismissed', resolved_at: '2026-06-14T09:00:00' },
  ];
  const out = formatCleanupProposalsReview(decided, { includeDecided: true });
  assert.match(out, /^1 open cleanup proposal for my identity/);
  assert.match(out, /- \[prop-meds-q2\] applied 2026-06-15 → takes-sertraline-k3: meds/);
  assert.match(out, /- \[prop-old-z9\] dismissed 2026-06-14: likes tea/);
  assert.equal(formatCleanupProposalsReview([]), 'There are no open cleanup proposals for my identity.');
});

test('applying sends my wording and care call, after a snapshot, and answers quietly', async () => {
  reply = (name) => name === 'identity_cleanup_apply'
    ? { ok: true, memory_id: 'my-human-likes-tea-k2', removed_chars: 25, file: 'ward/user_notes.md' }
    : { ok: true };
  const out = await run('apply_cleanup_proposal', { id: 'prop-likes-tea-x7', fact: 'Tea, never coffee.', high_care: false });
  assert.deepEqual(sent('identity_cleanup_apply'), { id: 'prop-likes-tea-x7', fact: 'Tea, never coffee.', care_weight: 'low' });
  const order = calls.map(c => c.name);
  assert.ok(order.indexOf('snapshot_create') > -1 && order.indexOf('snapshot_create') < order.indexOf('identity_cleanup_apply'));
  assert.equal(out, 'ok');
  calls = [];
  await run('apply_cleanup_proposal', { id: 'prop-likes-tea-x7' });
  assert.deepEqual(sent('identity_cleanup_apply'), { id: 'prop-likes-tea-x7' }, 'left out, the proposal keeps its own wording and care call');
});

test('a refused apply says nothing changed; a saved-but-uncut one says so plainly', async () => {
  reply = (name) => name === 'identity_cleanup_apply'
    ? { ok: false, error: "its passage isn't in the file exactly once any more, so nothing changed (marked stale)" }
    : { ok: true };
  assert.match(await run('apply_cleanup_proposal', { id: 'prop-x' }), /^Nothing changed: its passage isn't in the file/);
  reply = (name) => name === 'identity_cleanup_apply'
    ? { ok: false, memory_id: 'tea-k2', error: 'the fact is saved (tea-k2) but the passage wasn\'t cut: boom' }
    : { ok: true };
  const out = await run('apply_cleanup_proposal', { id: 'prop-x' });
  assert.match(out, /^The standing fact is saved \(tea-k2\), but the passage wasn't cut/);
  assert.match(out, /remove_from_identity/);
  assert.match(await run('apply_cleanup_proposal', {}), /^Nothing changed: I need the proposal id/);
});

test('dismiss and list reach Phylactery; list can include what I decided', async () => {
  assert.equal(await run('dismiss_cleanup_proposal', { id: 'prop-likes-tea-x7' }), 'ok');
  assert.deepEqual(sent('identity_cleanup_dismiss'), { id: 'prop-likes-tea-x7' });
  reply = (name) => name === 'identity_cleanup_proposals' ? { items: [TEA] } : { ok: true };
  assert.match(await run('list_cleanup_proposals', {}), /\[id: prop-likes-tea-x7\]/);
  assert.equal(sent('identity_cleanup_proposals').status, 'open');
  calls = [];
  await run('list_cleanup_proposals', { include_decided: true });
  assert.equal(sent('identity_cleanup_proposals').status, 'all');
});

test('in a gated room none of these touch Phylactery', async () => {
  for (const [tool, args] of [['apply_cleanup_proposal', { id: 'prop-x' }], ['dismiss_cleanup_proposal', { id: 'prop-x' }], ['list_cleanup_proposals', {}]]) {
    const out = await run(tool, args, GATED);
    assert.match(out, /only (decide on|look at)/, tool);
  }
  assert.equal(calls.length, 0);
});

test('the tools travel with the block, and never to a villager', () => {
  for (const n of ['apply_cleanup_proposal', 'dismiss_cleanup_proposal', 'list_cleanup_proposals']) {
    assert.ok(BUILTIN_TOOLS.find(t => t.function.name === n), `${n} exists`);
    assert.equal(TOOL_MODULES[n], 'acks');
    assert.ok(!villagerToolNames({ schedule: 'full', memories: true, contacts: true }).has(n), `${n} is never a villager tool`);
  }
  const mods = selectModules({ dynamicBlock: `${formatCleanupProposalsBlock([TEA])}` });
  assert.ok(mods.has('acks'), 'the block surfaces its tools');
  const names = composeActiveTools([], {}, { modules: mods }).map(t => t.function.name);
  assert.ok(names.includes('apply_cleanup_proposal') && names.includes('dismiss_cleanup_proposal'));
  assert.ok(selectModules({ turnText: 'can you look at your cleanup proposals' }).has('acks'));
});

test('pipeline: my own turn carries the block; a gated room never does', async () => {
  reply = (name) => name === 'identity_cleanup_proposals' ? { items: [TEA] } : { ok: true, items: [], results: [] };
  await listOpenCleanupProposals({ force: true });
  const mine = await enrich('hello', { liveTurn: true });
  assert.ok(mine.dynamic.includes('[Cleanup proposals for my identity'), 'ward turn shows the block');
  assert.ok(mine.dynamic.includes('[id: prop-likes-tea-x7]'));
  const room = await enrich('hello', { liveTurn: true, audience: 'friends', audiences: ['friends'], topicGrants: {} });
  assert.ok(!room.dynamic.includes('Cleanup proposals'), 'a gated room never sees my identity cleanup');
});
