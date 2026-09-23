import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_MODULES, CORE } from '../tool-surfacing.js';
import { composeActiveTools, executeToolCall } from '../cerebellum.js';

const INTENTION_TOOLS = ['intention_set', 'intention_list', 'intention_drop', 'intention_done', 'intention_mark_fired', 'intention_visibility'];
const namesOf = (tools) => tools.map(t => t.function?.name);

// ── Intentions are always exposed (ward directive) ───────────────────────────

test('every intention tool maps to CORE', () => {
  for (const name of INTENTION_TOOLS) {
    assert.equal(TOOL_MODULES[name], CORE, `${name} should be core (always exposed)`);
  }
});

test('intention tools ride a core-only surfaced turn (no module needed)', () => {
  // modules = empty Set → only CORE tools advertised.
  const tools = namesOf(composeActiveTools(null, {}, { modules: new Set() }));
  for (const name of INTENTION_TOOLS) {
    assert.ok(tools.includes(name), `${name} must be present with only core surfaced`);
  }
});

// ── get_session_info reflects ctx.sessionInfo (the Discord null bug) ──────────

test('get_session_info returns populated fields from ctx.sessionInfo', async () => {
  const ctx = { sessionInfo: {
    sessionId: 's-1', startedAt: '2026-09-23T10:00:00Z', messageCount: 7,
    provider: 'zai', model: 'glm', elapsedMsSinceLastMessage: 1234,
  } };
  const out = JSON.parse(await executeToolCall('get_session_info', '{}', ctx));
  assert.equal(out.sessionId, 's-1');
  assert.equal(out.messageCount, 7);
  assert.equal(out.provider, 'zai');
  assert.equal(out.model, 'glm');
  assert.equal(out.elapsedMsSinceLastMessage, 1234);
});

test('get_session_info degrades to nulls when ctx carries no sessionInfo (never throws)', async () => {
  const out = JSON.parse(await executeToolCall('get_session_info', '{}', {}));
  assert.equal(out.sessionId, null);
  assert.equal(out.model, null);
});
