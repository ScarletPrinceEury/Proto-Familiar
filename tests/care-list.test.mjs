// The Familiar can review its own care list (0.14.73).
//
// Found in the first identity review: 47 facts counted as care, only 8 of them
// flagged on purpose (the rest matched care.py's wording), and the chat-turn
// care block fits about half — with no way for the Familiar to see the list,
// let alone tidy it. list_care_facts shows every fact with its id, how it got
// on the list and whether it's in the block, placed by the SAME rule the block
// uses. Taking a fact off the list is ward-private only: it also takes the fact
// out of triage's view.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { placeCareFacts, formatCareFactsBlock, formatCareFactsReview, CARE_FACTS_FETCH_LIMIT } = await import('../src/safety/care-facts.js');
const { BUILTIN_TOOLS, executeToolCall, VILLAGER_WRITE_TOOLS } = await import('../cerebellum.js');
const { __setPhylacteryClientForTest } = await import('../thalamus.js');
const { TOOL_MODULES } = await import('../tool-surfacing.js');
const { EXCERPT_MARKER } = await import('../src/util/excerpt.js');

const ITEMS = [
  { id: 'support-sister-a1', content: 'Support person: their sister.', category: 'support-map', how: 'flagged' },
  { id: 'long-history-b2', content: 'A long account of how things went. '.repeat(10).trim(), category: 'health_info', how: 'wording' },
  { id: 'eat-before-c3', content: 'Wants a nudge to eat before a long shift.', category: '', how: 'flagged' },
];
const GATED = { discord: true, wardPrivate: false, audiences: [] };

let calls = [];
let items = ITEMS;
beforeEach(() => {
  calls = [];
  items = ITEMS;
  __setPhylacteryClientForTest({
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args });
      const body = name === 'memory_list_care_facts' ? { items } : { ok: true };
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    },
  });
});
const run = (tool, args, ctx) => executeToolCall(tool, JSON.stringify(args), ctx);

test('a fact too long for the room is skipped, and a shorter one after it still fits', () => {
  const placed = placeCareFacts(ITEMS, 120);
  assert.deepEqual(placed.map(p => p.inBlock), [true, false, true]);
});

test('the care block contains exactly the facts placeCareFacts puts in it', () => {
  const block = formatCareFactsBlock(ITEMS, { maxChars: 120 });
  for (const p of placeCareFacts(ITEMS, 120)) assert.equal(block.includes(p.line), p.inBlock, p.item.id);
  assert.match(block, /\(1 more I can recall when they come up\.\)$/);
});

test('the review says how each fact got there and whether it is in the block', () => {
  const out = formatCareFactsReview(ITEMS, { maxChars: 120 });
  assert.match(out, /3 facts/);
  assert.match(out, /2 are flagged high-care; 1 count only because their wording sounds like care/);
  assert.match(out, /1\. \[flagged, in block\] support-sister-a1:/);
  assert.match(out, /2\. \[wording, recall only\] long-history-b2:/);
  assert.match(out, /3\. \[flagged, in block\] eat-before-c3:/);
  assert.match(out, /Triage and noticing see all of them/);
  assert.match(out, /high_care: false/);
});

test('a long fact is shown cut with a marker, never mid-word as if whole', () => {
  const long = [{ id: 'x', content: 'word '.repeat(200).trim(), how: 'wording' }];
  assert.ok(formatCareFactsReview(long).includes(EXCERPT_MARKER));
});

test('past the fetch limit the review says what triage and noticing miss', () => {
  const many = Array.from({ length: CARE_FACTS_FETCH_LIMIT + 3 }, (_, i) => ({ id: `f${i}`, content: `fact ${i}`, how: 'flagged' }));
  assert.match(formatCareFactsReview(many), new RegExp(`see the first ${CARE_FACTS_FETCH_LIMIT}; the last 3 reach neither`));
});

test('triage and noticing still fetch 60 — the review does not change what they see', () => {
  assert.equal(CARE_FACTS_FETCH_LIMIT, 60);
});

test('list_care_facts reads the whole list in my own conversations', async () => {
  const out = await run('list_care_facts', {});
  assert.equal(calls[0].name, 'memory_list_care_facts');
  assert.ok(calls[0].args.limit > CARE_FACTS_FETCH_LIMIT, 'the review sees past the fetch limit');
  assert.match(out, /support-sister-a1/);
});

test('list_care_facts never runs on a group or villager turn', async () => {
  const out = await run('list_care_facts', {}, GATED);
  assert.match(out, /only look at it in our own conversations/);
  assert.equal(calls.length, 0, 'the facts never leave Phylactery');
  assert.ok(!VILLAGER_WRITE_TOOLS.has('list_care_facts'));
});

test('taking a fact off the care list is refused on a villager turn; flagging is not', async () => {
  const off = await run('update_memory_by_id', { id: 'eat-before-c3', high_care: false }, GATED);
  assert.match(off, /only take facts off my care list in my own conversations/);
  assert.equal(calls.length, 0);
  await run('update_memory_by_id', { id: 'eat-before-c3', high_care: true }, GATED);
  assert.equal(calls.find(c => c.name === 'memory_update_by_id')?.args.careWeight, 'high');
  calls = [];
  await run('update_memory_by_id', { id: 'eat-before-c3', high_care: false });
  assert.equal(calls.find(c => c.name === 'memory_update_by_id')?.args.careWeight, 'low', 'fine in my own conversations');
});

test('the review and the flag both say that off the list means out of triage and noticing', () => {
  // Found live: the Familiar unflagged crisis-adjacent facts reasoning "recall
  // still serves it" — true on chat turns, false for triage and noticing, which
  // see only the care list. The tool text now says so wherever unflagging is offered.
  const out = formatCareFactsReview(ITEMS, { maxChars: 120 });
  assert.match(out, /takes it out of triage and noticing too: they don't recall anything/);
  assert.match(out, /triage and noticing still see them/, 'recall-only facts are still in their view');
  const props = BUILTIN_TOOLS.find(t => t.function.name === 'update_memory_by_id').function.parameters.properties;
  assert.match(props.high_care.description, /triage and noticing don't recall/);
  assert.match(BUILTIN_TOOLS.find(t => t.function.name === 'list_care_facts').function.description, /gone from triage and noticing too/);
});

test('I can find the tool and know what to do with what it shows', () => {
  const fn = BUILTIN_TOOLS.find(t => t.function.name === 'list_care_facts')?.function;
  assert.ok(fn);
  assert.equal(TOOL_MODULES.list_care_facts, 'memory-edit');
  assert.match(fn.description, /high_care false \(update_memory_by_id\)/);
});
