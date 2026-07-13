// Intentions Node-side logic (Initiative Pass 3): budget-cap parsing, the
// trigger describer, and tool surfacing. The store itself is covered by
// unruh/tests/test_intention.py; these cover the Node bridge's pure pieces.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  intentionStandingPerPhaseCap,
  intentionOpenOneShotsCap,
  describeIntentionTrigger,
  BUILTIN_TOOLS,
  TOOL_EXECUTORS,
} from '../cerebellum.js';
import { selectModules, TOOL_MODULES, MODULE_INDEX } from '../tool-surfacing.js';

// ── budget caps: ward-configurable with sane clamps ──────────────────

test('intentionStandingPerPhaseCap: default 3, honours a valid setting, clamps nonsense', () => {
  assert.equal(intentionStandingPerPhaseCap({}), 3);
  assert.equal(intentionStandingPerPhaseCap({ intentionStandingPerPhase: 5 }), 5);
  assert.equal(intentionStandingPerPhaseCap({ intentionStandingPerPhase: 0 }), 3);    // < 1 → default
  assert.equal(intentionStandingPerPhaseCap({ intentionStandingPerPhase: 999 }), 3);  // > 20 → default
  assert.equal(intentionStandingPerPhaseCap({ intentionStandingPerPhase: 2.5 }), 3);  // non-int → default
});

test('intentionOpenOneShotsCap: default 30, configurable, clamped', () => {
  assert.equal(intentionOpenOneShotsCap({}), 30);
  assert.equal(intentionOpenOneShotsCap({ intentionOpenOneShots: 50 }), 50);
  assert.equal(intentionOpenOneShotsCap({ intentionOpenOneShots: 0 }), 30);
  assert.equal(intentionOpenOneShotsCap({ intentionOpenOneShots: 100000 }), 30);
});

// ── describeIntentionTrigger ─────────────────────────────────────────

test('describeIntentionTrigger: renders each trigger kind', () => {
  assert.equal(describeIntentionTrigger({ kind: 'at', at: '2026-07-16T09:00:00' }), 'due 2026-07-16T09:00:00');
  assert.equal(describeIntentionTrigger({ kind: 'phase', phase: 'morning', recurring: true }), 'every morning phase');
  assert.equal(describeIntentionTrigger({ kind: 'phase', phase: 'noon' }), 'next noon phase');
  assert.equal(describeIntentionTrigger({ kind: 'on_next_contact' }), 'next time we talk');
  assert.equal(describeIntentionTrigger({ kind: 'none' }), '');
  assert.equal(describeIntentionTrigger({}), '');
});

// ── surfacing: the intentions module ─────────────────────────────────

test('intentions module surfaces on intent-setting / round language', () => {
  for (const text of [
    'every morning I want to check the calendar',
    'remind myself to follow up with Chen',
    'from now on I check in on them',
    'that\'s one of my rounds',
    'make a habit of it',
  ]) {
    assert.ok(selectModules({ turnText: text }).has('intentions'), `should surface for: ${text}`);
  }
});

test('intentions module surfaces when the due-intentions block is injected', () => {
  const mods = selectModules({ turnText: 'anything', dynamicBlock: 'foo\n[Intentions coming due]\n  - ...' });
  assert.ok(mods.has('intentions'));
});

test('intentions module does NOT surface on unrelated chatter', () => {
  assert.ok(!selectModules({ turnText: 'the weather is nice today' }).has('intentions'));
});

test('all six intention tools map to the intentions module and have executors', () => {
  const names = BUILTIN_TOOLS.map(t => t.function?.name).filter(n => n?.startsWith('intention_'));
  assert.equal(names.length, 6);
  for (const n of names) {
    assert.equal(TOOL_MODULES[n], 'intentions', `${n} → intentions module`);
    assert.equal(typeof TOOL_EXECUTORS[n], 'function', `${n} has an executor`);
  }
});

test('MODULE_INDEX names the intentions module (request_tools discoverability)', () => {
  assert.match(MODULE_INDEX, /intentions \(/);
});
