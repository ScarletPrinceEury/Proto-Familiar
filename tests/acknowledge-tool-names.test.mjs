// Tool-name consistency in the acknowledge family (verb_noun, matching
// acknowledge_deferred_intent/snooze_deferred_intent/drop_deferred_intent).
// graduation_acknowledge / disclosure_acknowledge were the odd ones out
// (noun_verb) — renamed to acknowledge_graduation / acknowledge_disclosure.
// The old names lived on briefly as executor-only aliases ("remove after 0.12");
// they were fully retired in the 2026-09 audit sweep (now well past 0.12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TOOLS, TOOL_EXECUTORS } from '../cerebellum.js';
import { TOOL_MODULES } from '../tool-surfacing.js';

test('the new acknowledge_* names are advertised, first-person tools', () => {
  for (const name of ['acknowledge_graduation', 'acknowledge_disclosure']) {
    const def = BUILTIN_TOOLS.find(t => t.function?.name === name)?.function;
    assert.ok(def, `${name} tool definition present`);
    assert.match(def.description, /^I /);
    assert.equal(TOOL_MODULES[name], 'acks');
  }
});

test('the old noun_verb names are NOT advertised', () => {
  for (const oldName of ['graduation_acknowledge', 'disclosure_acknowledge']) {
    assert.equal(
      BUILTIN_TOOLS.find(t => t.function?.name === oldName),
      undefined,
      `${oldName} must not be in BUILTIN_TOOLS`,
    );
  }
});

test('the new names execute; the old aliases are fully retired (gone from TOOL_EXECUTORS)', () => {
  // The canonical verb_noun names run.
  assert.equal(typeof TOOL_EXECUTORS.acknowledge_graduation, 'function');
  assert.equal(typeof TOOL_EXECUTORS.acknowledge_disclosure, 'function');
  // The retired noun_verb aliases no longer exist as executors either (not just
  // unadvertised) — the "remove after 0.12" contract, honoured.
  assert.equal(TOOL_EXECUTORS.graduation_acknowledge, undefined);
  assert.equal(TOOL_EXECUTORS.disclosure_acknowledge, undefined);
});
