import assert from 'assert';
import {
  TOOL_MODULES, CORE, ALL_MODULES, MODULE_INDEX,
  villagerNameRegex, selectModules,
  stickyModulesFor, tickSticky, resetSticky,
  normalizeRequestedModules,
} from '../tool-surfacing.js';
import { BUILTIN_TOOLS, composeActiveTools, executeToolCall, TOOL_EXECUTORS } from '../cerebellum.js';

// ── Parity tests: BUILTIN_TOOLS ↔ TOOL_MODULES coverage ─────────────

const builtinNames = new Set(BUILTIN_TOOLS
  .map(t => t.function?.name)
  .filter(Boolean)
);

const toolModuleNames = new Set(Object.keys(TOOL_MODULES));

console.log(`[parity] ${builtinNames.size} builtin tools, ${toolModuleNames.size} in TOOL_MODULES`);

assert.strictEqual(
  builtinNames.size > 0,
  true,
  'BUILTIN_TOOLS should not be empty',
);

assert.strictEqual(
  toolModuleNames.size > 0,
  true,
  'TOOL_MODULES should not be empty',
);

// Every builtin tool must have a module
for (const name of builtinNames) {
  assert.strictEqual(
    TOOL_MODULES.hasOwnProperty(name),
    true,
    `Builtin tool "${name}" missing from TOOL_MODULES`,
  );
}

// Every tool module entry must exist in builtins — strict both ways, so a
// renamed or removed tool can't leave a phantom module entry behind.
for (const name of toolModuleNames) {
  assert.strictEqual(
    builtinNames.has(name),
    true,
    `TOOL_MODULES entry "${name}" has no corresponding builtin tool`,
  );
}

// ── selectModules tests ────────────────────────────────────────────

{
  // Plain chit-chat → empty set
  const result = selectModules({
    turnText: 'how was your day? I watched a movie',
    dynamicBlock: '',
  });
  assert.strictEqual(
    result.size,
    0,
    'Plain chit-chat should surface no modules',
  );
}

{
  // Schedule reminder → 'schedule-write'
  const result = selectModules({
    turnText: 'remind me tomorrow at 9am to call the dentist',
    dynamicBlock: '',
  });
  assert.strictEqual(
    result.has('schedule-write'),
    true,
    'Reminder text should surface schedule-write',
  );
}

{
  // Web search → 'web'
  const result = selectModules({
    turnText: 'can you look up the weather',
    dynamicBlock: '',
  });
  assert.strictEqual(
    result.has('web'),
    true,
    'Weather lookup should surface web',
  );
}

{
  // Dynamic block: [PENDING MEMORY CONSENT → 'acks'
  const result = selectModules({
    turnText: '',
    dynamicBlock: 'some text [PENDING MEMORY CONSENT more text',
  });
  assert.strictEqual(
    result.has('acks'),
    true,
    'PENDING MEMORY CONSENT block should surface acks',
  );
}

{
  // Dynamic block: [Surface candidates → 'schedule-write'
  const result = selectModules({
    turnText: '',
    dynamicBlock: '[Surface candidates for something',
  });
  assert.strictEqual(
    result.has('schedule-write'),
    true,
    '[Surface candidates block should surface schedule-write',
  );
}

{
  // Dynamic block: [New on my human's calendar → 'schedule-write'
  const result = selectModules({
    turnText: '',
    dynamicBlock: "[New on my human's calendar: item",
  });
  assert.strictEqual(
    result.has('schedule-write'),
    true,
    "[New on my human's calendar block should surface schedule-write",
  );
}

{
  // Villager name in turn text → 'village'
  const result = selectModules({
    turnText: 'I talked to Mira today',
    dynamicBlock: '',
    villagerNames: ['Mira'],
  });
  assert.strictEqual(
    result.has('village'),
    true,
    'Villager name should surface village',
  );
}

{
  // Short villager names (1-2 chars) ignored
  const result = selectModules({
    turnText: 'I talked to Al today',
    dynamicBlock: '',
    villagerNames: ['Al'],  // 2 chars, should be ignored
  });
  assert.strictEqual(
    result.has('village'),
    false,
    '2-char name should be ignored',
  );
}

{
  // Mixed triggers
  const result = selectModules({
    turnText: 'remind me about Alice and look that up',
    dynamicBlock: '',
    villagerNames: ['Alice'],
  });
  assert.strictEqual(
    result.has('schedule-write'),
    true,
    'Should surface schedule-write from reminder',
  );
  assert.strictEqual(
    result.has('web'),
    true,
    'Should surface web from lookup',
  );
  assert.strictEqual(
    result.has('village'),
    true,
    'Should surface village from villager name',
  );
}

// ── Sticky TTL tests ──────────────────────────────────────────────

{
  resetSticky();
  const sid = 'test-session-1';

  // Initially empty
  let sticky = stickyModulesFor(sid);
  assert.strictEqual(sticky.size, 0, 'New session should have no sticky');

  // Tick with a module, TTL=2
  tickSticky(sid, new Set(['graph']), 2);
  sticky = stickyModulesFor(sid);
  assert.strictEqual(sticky.has('graph'), true, 'Module should stick after first tick');

  // After one more tick with empty surfaced set, it should decay
  tickSticky(sid, new Set(), 2);
  sticky = stickyModulesFor(sid);
  assert.strictEqual(sticky.has('graph'), true, 'Module should still be present after one decay');

  // After second tick, it should be gone (TTL exhausted)
  tickSticky(sid, new Set(), 2);
  sticky = stickyModulesFor(sid);
  assert.strictEqual(sticky.has('graph'), false, 'Module should be gone after TTL exhausted');
}

{
  // stickyTurns=0 never sticks
  resetSticky();
  const sid = 'test-session-2';
  tickSticky(sid, new Set(['web', 'village']), 0);
  const sticky = stickyModulesFor(sid);
  assert.strictEqual(sticky.size, 0, 'stickyTurns=0 should not stick anything');
}

{
  // Sticky persists across selectModules calls
  resetSticky();
  const sid = 'test-session-3';
  tickSticky(sid, new Set(['graph']), 2);

  const result = selectModules({
    turnText: 'hello',
    dynamicBlock: '',
    sticky: stickyModulesFor(sid),
  });

  assert.strictEqual(result.has('graph'), true, 'Sticky module should be included in result');
}

// ── normalizeRequestedModules tests ────────────────────────────────

{
  // 'all' expands to every non-core module
  const result = normalizeRequestedModules('all');
  const expected = ALL_MODULES.filter(m => m !== CORE);
  assert.strictEqual(
    result.modules.length,
    expected.length,
    '"all" should expand to all non-core modules',
  );
  for (const m of expected) {
    assert.strictEqual(
      result.modules.includes(m),
      true,
      `"all" should include ${m}`,
    );
  }
  assert.strictEqual(result.unknown.length, 0, '"all" should have no unknown');
}

{
  // String with multiple modules
  const result = normalizeRequestedModules('graph, village');
  assert.deepStrictEqual(
    new Set(result.modules),
    new Set(['graph', 'village']),
    'Should parse comma-separated list',
  );
  assert.deepStrictEqual(result.unknown, [], 'Should have no unknowns');
}

{
  // Array input
  const result = normalizeRequestedModules(['graph', 'web']);
  assert.deepStrictEqual(
    new Set(result.modules),
    new Set(['graph', 'web']),
    'Should accept array input',
  );
}

{
  // Unknown modules
  const result = normalizeRequestedModules('graph, nonsense, village');
  assert.deepStrictEqual(
    new Set(result.modules),
    new Set(['graph', 'village']),
    'Should filter out unknown modules',
  );
  assert.deepStrictEqual(
    result.unknown,
    ['nonsense'],
    'Should list unknown modules',
  );
}

{
  // Empty input
  const result = normalizeRequestedModules('');
  assert.deepStrictEqual(result.modules, [], 'Empty input should give empty modules');
  assert.deepStrictEqual(result.unknown, [], 'Empty input should give empty unknown');
}

{
  // 'core' requested (should be filtered out)
  const result = normalizeRequestedModules('core, graph');
  assert.strictEqual(result.modules.includes('core'), false, 'core should be filtered');
  assert.strictEqual(result.modules.includes('graph'), true, 'graph should remain');
}

// ── composeActiveTools with surfacing ──────────────────────────────

{
  // With no modules set, all tools present
  const tools = composeActiveTools([], {}, {});
  const toolNames = new Set(tools.map(t => t.function?.name));
  assert.strictEqual(
    toolNames.has('create_graph_node'),
    true,
    'Full set should include graph tools',
  );
  assert.strictEqual(
    toolNames.has('request_tools'),
    true,
    'Full set should include request_tools',
  );
  assert.strictEqual(
    toolNames.has('contact_trusted_person'),
    true,
    'Full set should include crisis tools',
  );
}

{
  // With empty modules set, only core tools
  const tools = composeActiveTools([], {}, { modules: new Set() });
  const toolNames = new Set(tools.map(t => t.function?.name));

  assert.strictEqual(
    toolNames.has('create_graph_node'),
    false,
    'Empty modules should exclude graph tools',
  );
  assert.strictEqual(
    toolNames.has('request_tools'),
    true,
    'Empty modules should still include request_tools (core)',
  );
  assert.strictEqual(
    toolNames.has('contact_trusted_person'),
    true,
    'Empty modules should still include crisis tools (core)',
  );
  assert.strictEqual(
    toolNames.has('show_crisis_resources'),
    true,
    'Empty modules should still include crisis resources (core)',
  );
}

{
  // With 'graph' module
  const tools = composeActiveTools([], {}, { modules: new Set(['graph']) });
  const toolNames = new Set(tools.map(t => t.function?.name));

  assert.strictEqual(
    toolNames.has('create_graph_node'),
    true,
    'graph module should include create_graph_node',
  );
  assert.strictEqual(
    toolNames.has('web_search'),
    false,
    'graph module should not include web tools',
  );
}

{
  // Web tools gated by webSearchEnabled setting
  const toolsDisabled = composeActiveTools([], { webSearchEnabled: false }, { modules: new Set(['web']) });
  const toolNamesDisabled = new Set(toolsDisabled.map(t => t.function?.name));
  assert.strictEqual(
    toolNamesDisabled.has('web_search'),
    false,
    'web_search should be absent when webSearchEnabled=false',
  );

  const toolsEnabled = composeActiveTools([], { webSearchEnabled: true }, { modules: new Set(['web']) });
  const toolNamesEnabled = new Set(toolsEnabled.map(t => t.function?.name));
  assert.strictEqual(
    toolNamesEnabled.has('web_search'),
    true,
    'web_search should be present when webSearchEnabled=true',
  );
}

{
  // schedule_push_to_google gated by gcalWriteEnabled + gcalWriteCommand
  const toolsDisabled = composeActiveTools([], { gcalWriteEnabled: false }, { modules: new Set(['schedule-write']) });
  const toolNamesDisabled = new Set(toolsDisabled.map(t => t.function?.name));
  assert.strictEqual(
    toolNamesDisabled.has('schedule_push_to_google'),
    false,
    'schedule_push_to_google should be absent when gcalWriteEnabled=false',
  );

  const toolsEnabledNoCmd = composeActiveTools([], { gcalWriteEnabled: true }, { modules: new Set(['schedule-write']) });
  const toolNamesEnabledNoCmd = new Set(toolsEnabledNoCmd.map(t => t.function?.name));
  assert.strictEqual(
    toolNamesEnabledNoCmd.has('schedule_push_to_google'),
    false,
    'schedule_push_to_google should be absent without gcalWriteCommand',
  );

  const toolsEnabledWithCmd = composeActiveTools(
    [],
    { gcalWriteEnabled: true, gcalWriteCommand: 'some_cmd' },
    { modules: new Set(['schedule-write']) }
  );
  const toolNamesEnabledWithCmd = new Set(toolsEnabledWithCmd.map(t => t.function?.name));
  assert.strictEqual(
    toolNamesEnabledWithCmd.has('schedule_push_to_google'),
    true,
    'schedule_push_to_google should be present when both gates are met',
  );
}

// ── request_tools executor ────────────────────────────────────────

{
  // Clean context
  const ctx = {};
  const result = await TOOL_EXECUTORS.request_tools({ modules: 'graph' }, ctx);

  assert.strictEqual(
    ctx._requestedModules instanceof Set,
    true,
    'Should create _requestedModules Set',
  );
  assert.strictEqual(
    ctx._requestedModules.has('graph'),
    true,
    'Should add graph to _requestedModules',
  );
  assert.strictEqual(
    typeof result,
    'string',
    'Should return a string',
  );
  assert.strictEqual(
    result.startsWith('ok'),
    true,
    'Success should start with "ok"',
  );
}

{
  // Unknown modules
  const ctx = {};
  const result = await TOOL_EXECUTORS.request_tools({ modules: 'bogus_module' }, ctx);

  assert.strictEqual(
    ctx._requestedModules?.size ?? 0,
    0,
    'Unknown modules should not add to _requestedModules',
  );
  assert.strictEqual(
    result.includes("don't have module"),
    true,
    'Error should mention missing module',
  );
}

{
  // Multiple modules in one call
  const ctx = {};
  const result = await TOOL_EXECUTORS.request_tools({ modules: ['graph', 'village'] }, ctx);

  assert.strictEqual(ctx._requestedModules.has('graph'), true);
  assert.strictEqual(ctx._requestedModules.has('village'), true);
  assert.strictEqual(result.startsWith('ok'), true);
}

{
  // 'all' expands
  const ctx = {};
  const result = await TOOL_EXECUTORS.request_tools({ modules: 'all' }, ctx);

  const allModules = ALL_MODULES.filter(m => m !== CORE);
  for (const m of allModules) {
    assert.strictEqual(
      ctx._requestedModules.has(m),
      true,
      `"all" should add ${m}`,
    );
  }
  assert.strictEqual(result.startsWith('ok'), true);
}

// ── runToolCallLoop with getTools ──────────────────────────────────

{
  const recordedCalls = [];

  const fakeCallUpstream = async (messages, tools) => {
    recordedCalls.push({ messages: messages.length, tools });

    // First round: request_tools
    if (recordedCalls.length === 1) {
      return {
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [{
              id: 'a',
              function: {
                name: 'request_tools',
                arguments: '{"modules":"graph"}',
              },
            }],
          },
        }],
      };
    }

    // Second round: finish
    return {
      choices: [{
        finish_reason: 'stop',
        message: { content: 'Done' },
      }],
    };
  };

  let getToolsCallCount = 0;
  const fakeGetTools = () => {
    getToolsCallCount++;
    // getTools returns a tool name for the next round if modules were requested
    return undefined; // on round 1 the set is empty
  };

  const toolCtx = {};

  // Import runToolCallLoop
  const { runToolCallLoop } = await import('../cerebellum.js');

  const result = await runToolCallLoop({
    callUpstream: fakeCallUpstream,
    baseMessages: [{ role: 'user', content: 'test' }],
    executeTool: executeToolCall,
    toolCtx,
    getTools: fakeGetTools,
  });

  // Verify getTools was called twice (once per round)
  assert.strictEqual(getToolsCallCount, 2, 'getTools should be called each round');

  // Verify recorded upstream calls
  assert.strictEqual(recordedCalls.length, 2, 'Should have 2 upstream calls');
  assert.strictEqual(recordedCalls[0].tools, undefined, 'Round 1 should pass undefined tools');
  // Round 2: since request_tools was called, _requestedModules should now contain 'graph'
  // so the 2nd call to getTools would return something if we had the logic for it
  // But since we're not actually checking for module growth in our fake getTools,
  // this test just verifies the contract that getTools is called.
}

{
  // More detailed test: verify the grown module set appears in next round
  const recordedTools = [];

  const fakeCallUpstream2 = async (messages, tools) => {
    recordedTools.push(tools);

    if (recordedTools.length === 1) {
      return {
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [{
              id: 'call1',
              function: {
                name: 'request_tools',
                arguments: '{"modules":"graph"}',
              },
            }],
          },
        }],
      };
    }

    return {
      choices: [{
        finish_reason: 'stop',
        message: { content: 'done' },
      }],
    };
  };

  const ctx2 = {};
  const fakeGetTools2 = () => {
    // After request_tools, the set has 'graph'
    return ctx2._requestedModules?.size ? ['GREW'] : undefined;
  };

  const { runToolCallLoop } = await import('../cerebellum.js');

  await runToolCallLoop({
    callUpstream: fakeCallUpstream2,
    baseMessages: [{ role: 'user', content: 'test' }],
    executeTool: executeToolCall,
    toolCtx: ctx2,
    getTools: fakeGetTools2,
  });

  // Verify the pattern
  assert.strictEqual(recordedTools[0], undefined, 'Round 1 should have no tools');
  assert.deepStrictEqual(recordedTools[1], ['GREW'], 'Round 2 should have grown tools');
}

// ── villagerNameRegex edge cases ──────────────────────────────────

{
  // Empty array
  const re = villagerNameRegex([]);
  assert.strictEqual(re, null, 'Empty array should return null');
}

{
  // Regex escaping - test with a name that has special chars but still word-boundary-friendly
  const re = villagerNameRegex(['Alice-Marie']);
  assert.strictEqual(
    re.test('I talked to Alice-Marie today'),
    true,
    'Hyphen (special regex char) should be escaped properly',
  );
  assert.strictEqual(
    re.test('alice-marie'),  // case insensitive
    true,
    'Match should be case-insensitive',
  );
}

{
  // Case insensitive
  const re = villagerNameRegex(['alice']);
  assert.strictEqual(
    re.test('I talked to ALICE'),
    true,
    'Match should be case-insensitive',
  );
}

console.log('[tool-surfacing] All tests passed');
