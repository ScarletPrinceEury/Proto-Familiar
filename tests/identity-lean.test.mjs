// Identity stays lean (0.14.70, ward-signed — docs/identity-lean-build-spec.md).
//
// Identity is for the Familiar's own self and the shape of the bond: it rides
// every turn and reaches group chats. Situational detail and care data about my
// human live as standing facts; care facts are put back in front of the Familiar
// directly (own turns, triage, noticing) and never in a group room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { formatCareFactsBlock, careFactsBlockForTurn, CARE_FACTS_CHAT_MAX_CHARS } = await import('../src/safety/care-facts.js');
const budget = await import('../src/memory/identity-budget.js');
const { BUILTIN_TOOLS } = await import('../cerebellum.js');
const { buildNoticingPrompt } = await import('../src/safety/noticing.js');
const { buildGraduationPrompt } = await import('../src/tomes/tome-graduation-loop.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTS = [
  { content: 'Support person: their sister, 555-0100.' },
  { content: 'Allergic to penicillin.' },
  { content: 'What helps when they spiral: a walk outside.' },
];

// ── The care block ─────────────────────────────────────────────────────────
test('the care block lists my human\'s care facts under a plain header', () => {
  const block = formatCareFactsBlock(FACTS);
  assert.match(block, /^\[What I keep in mind about caring for my human\]/);
  for (const f of FACTS) assert.ok(block.includes(`- ${f.content}`));
  assert.equal(formatCareFactsBlock([]), '');
});

test('on a chat turn the block is capped, and says how many more it left out', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ content: `Care fact number ${i}: ` + 'some detail about what helps. '.repeat(6) }));
  const block = formatCareFactsBlock(many, { maxChars: CARE_FACTS_CHAT_MAX_CHARS });
  assert.ok(block.length < CARE_FACTS_CHAT_MAX_CHARS + 400);
  assert.match(block, /\(\d+ more I can recall when they come up\.\)$/);
});

test('a group / villager room never gets the care block — the facts are not even fetched', async () => {
  let fetched = 0;
  const fetchFacts = async () => { fetched++; return FACTS; };
  assert.equal(await careFactsBlockForTurn({ gated: true, staticOnly: false, fetchFacts }), '');
  assert.equal(await careFactsBlockForTurn({ gated: false, staticOnly: true, fetchFacts }), '');
  assert.equal(fetched, 0);
  assert.match(await careFactsBlockForTurn({ gated: false, staticOnly: false, fetchFacts }), /Allergic to penicillin/);
  assert.equal(fetched, 1);
});

test('a failed fetch is no block, never an error in the turn', async () => {
  assert.equal(await careFactsBlockForTurn({ gated: false, staticOnly: false, fetchFacts: async () => { throw new Error('down'); } }), '');
});

test('noticing reads the care facts', () => {
  const p = buildNoticingPrompt({ careFacts: formatCareFactsBlock(FACTS) });
  assert.ok(p.includes('Allergic to penicillin.'));
});

// ── The budget ─────────────────────────────────────────────────────────────
const big = (n) => [{ content: 'x'.repeat(n) }];

test('update_identity is nudged only when a category is over its share', () => {
  const t = budget.IDENTITY_BUDGET_DEFAULT_TOKENS;
  assert.equal(budget.identityBudgetNote({ ward: big(1000) }, 'ward', t), '');
  const note = budget.identityBudgetNote({ ward: big(14000) }, 'ward', t);
  assert.match(note, /files about my human/i);
  assert.match(note, /save_memory, register ward/);
  assert.match(budget.identityBudgetNote({ self: big(30000) }, 'self', t), /register me/);
});

test('the budget is my human\'s setting, clamped', () => {
  assert.equal(budget.identityBudgetTokens({}), 6000);
  assert.equal(budget.identityBudgetTokens({ identityBudgetTokens: 8000 }), 8000);
  assert.equal(budget.identityBudgetTokens({ identityBudgetTokens: 10 }), budget.IDENTITY_BUDGET_MIN_TOKENS);
  assert.equal(budget.identityBudgetTokens({ identityBudgetTokens: 1e9 }), budget.IDENTITY_BUDGET_MAX_TOKENS);
});

test('the JS budget mirrors Phylactery\'s graduation.py (split, clamps, protected core)', () => {
  const py = readFileSync(path.join(ROOT, 'phylactery/src/phylactery/graduation.py'), 'utf8');
  const num = (name) => Number(py.match(new RegExp(`^${name} = (\\d+)`, 'm'))?.[1]);
  assert.equal(num('IDENTITY_BUDGET_DEFAULT_TOKENS'), budget.IDENTITY_BUDGET_DEFAULT_TOKENS);
  assert.equal(num('IDENTITY_BUDGET_MIN_TOKENS'), budget.IDENTITY_BUDGET_MIN_TOKENS);
  assert.equal(num('IDENTITY_BUDGET_MAX_TOKENS'), budget.IDENTITY_BUDGET_MAX_TOKENS);
  assert.equal(num('CHARS_PER_TOKEN'), budget.CHARS_PER_TOKEN);
  const shares = py.match(/^CATEGORY_SHARES = \{(.+)\}/m)[1];
  for (const [cat, share] of Object.entries(budget.CATEGORY_SHARES)) {
    const m = shares.match(new RegExp(`"${cat}": (\\d+) / (\\d+)`));
    assert.ok(m, cat);
    assert.equal(Number(m[1]) / Number(m[2]), share, cat);
  }
  // The core named in update_identity's description is the protected core.
  for (const f of ['my_identity.md', 'my_persona.md', 'my_personhood.md', 'my_wants.md', 'my_boundaries.md']) {
    assert.ok(py.includes(`"${f}"`), f);
  }
});

// ── The steering ───────────────────────────────────────────────────────────
const desc = (name) => BUILTIN_TOOLS.find(t => t.function?.name === name).function.description;

test('no writer sends facts about my human into identity any more', () => {
  assert.doesNotMatch(desc('save_to_tome'), /update_identity/, 'save_to_tome used to route durable facts about my human to identity');
  assert.match(desc('update_identity'), /group chats/);
  assert.match(desc('update_identity'), /save_memory/);
  assert.match(desc('save_memory'), /care details/);
  const tomeRubric = buildGraduationPrompt({ items: [] });
  assert.doesNotMatch(tomeRubric, /A standing fact about who \{\{user\}\} is → their identity/);
  assert.match(tomeRubric, /"register": "for a standing fact in memory: ward\|me/);
});

test('a tome-graduation decision can land as a standing fact (register parsed and kept)', async () => {
  const { routeDecision, parseGraduationDecision } = await import('../src/tomes/tome-graduation.js');
  const decision = parseGraduationDecision(JSON.stringify([
    { uid: 'u1', home: 'memory', content: 'My human prefers tea in the evening.', granularity: 'significant', register: 'ward' },
  ])).get('u1');
  assert.equal(decision.register, 'ward');
  let args;
  const out = await routeDecision(decision, { uid: 'u1' }, { createMemoryFull: async (a) => { args = a; return { ok: true }; } });
  assert.equal(out.ok, true);
  assert.equal(args.register, 'ward');
  assert.equal(args.consent_pending, true, 'still through the consent greenlight');
});
