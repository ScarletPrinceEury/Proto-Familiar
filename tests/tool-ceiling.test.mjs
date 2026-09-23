import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SAFE_TOOL_CEILING, toolCeiling, shouldSurface, enforceToolCeiling, TOOL_MODULES, CORE,
} from '../tool-surfacing.js';
import { BUILTIN_TOOLS, composeActiveTools, composeDiscordTools } from '../cerebellum.js';

const namesOf = (tools) => tools.map(t => t.function?.name);

// ── toolCeiling ──────────────────────────────────────────────────────────────

test('toolCeiling: default, settings override, env override precedence', () => {
  assert.equal(toolCeiling({}), SAFE_TOOL_CEILING);
  assert.equal(toolCeiling({ maxToolsPerTurn: 40 }), 40);
  const prev = process.env.PROTO_FAMILIAR_MAX_TOOLS;
  process.env.PROTO_FAMILIAR_MAX_TOOLS = '25';
  try {
    assert.equal(toolCeiling({ maxToolsPerTurn: 40 }), 25, 'env wins over settings');
  } finally {
    if (prev === undefined) delete process.env.PROTO_FAMILIAR_MAX_TOOLS;
    else process.env.PROTO_FAMILIAR_MAX_TOOLS = prev;
  }
});

// ── shouldSurface ────────────────────────────────────────────────────────────

test('shouldSurface: default-ON', () => {
  assert.equal(shouldSurface({ settings: {} }), true, 'unset → surfacing on (safe default)');
});

test('shouldSurface: explicit off + under ceiling → off; over ceiling → forced on', () => {
  assert.equal(shouldSurface({ settings: { toolSurfacingEnabled: false }, fullCount: 20 }), false);
  assert.equal(shouldSurface({ settings: { toolSurfacingEnabled: false }, fullCount: 200 }), true,
    'the ceiling net forces trimming even with the toggle off');
});

test('shouldSurface: the hard env off-switch disables the whole feature', () => {
  const prev = process.env.PROTO_FAMILIAR_TOOL_SURFACING_DISABLED;
  process.env.PROTO_FAMILIAR_TOOL_SURFACING_DISABLED = '1';
  try {
    assert.equal(shouldSurface({ settings: {}, fullCount: 999 }), false);
  } finally {
    if (prev === undefined) delete process.env.PROTO_FAMILIAR_TOOL_SURFACING_DISABLED;
    else process.env.PROTO_FAMILIAR_TOOL_SURFACING_DISABLED = prev;
  }
});

// ── enforceToolCeiling ───────────────────────────────────────────────────────

test('enforceToolCeiling: under the ceiling → unchanged', () => {
  const tools = BUILTIN_TOOLS.slice(0, 10);
  assert.equal(enforceToolCeiling(tools, 64), tools);
});

test('enforceToolCeiling: caps the list but always keeps CORE (safety + request_tools)', () => {
  const full = composeActiveTools(null, { webSearchEnabled: true, trackersEnabled: true }, {});
  assert.ok(full.length > 30, 'precondition: a large registry');
  const capped = enforceToolCeiling(full, 20);
  assert.ok(capped.length <= Math.max(20, capped.filter(t => TOOL_MODULES[t.function?.name] === CORE).length));
  const names = namesOf(capped);
  // The recovery hatch + the crisis tools must survive a hard cap.
  for (const core of ['request_tools', 'flag_distress', 'show_crisis_resources', 'get_datetime']) {
    assert.ok(names.includes(core), `core tool ${core} must survive the ceiling`);
  }
});

// ── The reported bug: the full registry is huge ──────────────────────────────

test('the full ward registry exceeds the default ceiling (why z.ai broke)', () => {
  const full = composeActiveTools(null, { webSearchEnabled: true, trackersEnabled: true, visionEnabled: true, weatherEnabled: true }, {});
  assert.ok(full.length > SAFE_TOOL_CEILING, `full registry (${full.length}) should exceed the ${SAFE_TOOL_CEILING} ceiling`);
  // …and with the toggle off, the ceiling forces surfacing for exactly this case.
  assert.equal(shouldSurface({ settings: { toolSurfacingEnabled: false }, fullCount: full.length }), true);
});

// ── Discord parity: a ward turn can now narrow ───────────────────────────────

test('composeDiscordTools: a ward turn narrows to a module Set (was always full)', () => {
  const settings = { trackersEnabled: true };
  const fullWard = composeDiscordTools({ isWard: true, settings });
  const narrowed = composeDiscordTools({ isWard: true, settings, modules: new Set() });  // core only
  assert.ok(narrowed.length < fullWard.length, 'a module Set narrows the ward Discord tool list');
  // Core survives; a schedule-write tool does not when only core is selected.
  const nn = namesOf(narrowed);
  assert.ok(nn.includes('request_tools') && nn.includes('get_datetime'), 'core stays');
  assert.ok(!nn.includes('schedule_add_event'), 'a non-core module tool is dropped when unselected');
});

test('composeDiscordTools: a villager turn ignores modules (allowlist governs)', () => {
  const base = composeDiscordTools({ isVillager: true, grants: { schedule: 'full' }, settings: {} });
  const withModules = composeDiscordTools({ isVillager: true, grants: { schedule: 'full' }, settings: {}, modules: new Set() });
  assert.deepEqual(namesOf(base), namesOf(withModules), 'villager set is grant-driven, unaffected by modules');
});
