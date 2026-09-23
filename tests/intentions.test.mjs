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

// ── intentions are CORE / always exposed (ward directive 2026-09) ────────────

test('all six intention tools map to CORE (always exposed, never behind a module)', () => {
  const names = BUILTIN_TOOLS.map(t => t.function?.name).filter(n => n?.startsWith('intention_'));
  assert.equal(names.length, 6);
  for (const n of names) {
    assert.equal(TOOL_MODULES[n], 'core', `${n} → core`);
    assert.equal(typeof TOOL_EXECUTORS[n], 'function', `${n} has an executor`);
  }
});

test('intentions no longer surface as a module — the tools ride every turn instead', () => {
  // Intent-setting language used to surface an `intentions` module; now the tools
  // are core, so nothing needs to (and there is no `intentions` module to add).
  assert.ok(!selectModules({ turnText: 'every morning I check in on them' }).has('intentions'));
  assert.ok(!selectModules({ turnText: 'anything', dynamicBlock: '[Intentions coming due]\n - ...' }).has('intentions'));
});

test('MODULE_INDEX no longer lists intentions (they are core, not a request_tools module)', () => {
  assert.doesNotMatch(MODULE_INDEX, /intentions \(/);
});
