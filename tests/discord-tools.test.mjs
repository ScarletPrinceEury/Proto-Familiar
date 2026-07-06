import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  villagerToolNames,
  composeDiscordTools,
  discordReadAudiences,
  discordWriteProvenance,
  RELAY_TO_WARD_TOOL_NAME,
  RELAY_TO_WARD_TOOL,
  VILLAGER_WRITE_TOOLS,
  DISCORD_SCHEDULE_WRITE_TOOLS,
  DISCORD_MEMORY_WRITE_TOOLS,
} from '../cerebellum.js';

// ── villagerToolNames: grant-based tool allowlist ────────────────────

test('villagerToolNames: no grants → relay_to_ward and get_datetime only', () => {
  const names = villagerToolNames({});
  assert(names instanceof Set, 'should return a Set');
  assert(names.has(RELAY_TO_WARD_TOOL_NAME), 'should contain relay_to_ward');
  assert(names.has('get_datetime'), 'should contain get_datetime');
  assert(!names.has('recall'), 'should not contain recall');
  assert(!names.has('schedule_availability'), 'should not contain schedule_availability');
  assert(!names.has('schedule_add_event'), 'should not contain schedule_add_event');
  assert(!names.has('update_identity'), 'should not contain update_identity');
  assert(!names.has('save_memory'), 'should not contain save_memory');
  assert(!names.has('contact_trusted_person'), 'should not contain contact_trusted_person');
});

test('villagerToolNames: schedule=coarse → schedule_availability and schedule_find, NOT schedule_export', () => {
  const names = villagerToolNames({ schedule: 'coarse' });
  assert(names.has('schedule_availability'), 'should contain schedule_availability');
  assert(names.has('schedule_find'), 'should contain schedule_find');
  assert(!names.has('schedule_export'), 'should not contain schedule_export');
  assert(!names.has('template_list'), 'should not contain template_list');
  assert(!names.has('schedule_add_event'), 'should not contain schedule_add_event');
});

test('villagerToolNames: schedule=full → all schedule read tools plus template_list, gcal_list_calendars, and write tools', () => {
  const names = villagerToolNames({ schedule: 'full' });
  assert(names.has('schedule_availability'), 'should contain schedule_availability');
  assert(names.has('schedule_find'), 'should contain schedule_find');
  assert(names.has('schedule_export'), 'should contain schedule_export');
  assert(names.has('template_list'), 'should contain template_list');
  assert(names.has('gcal_list_calendars'), 'should contain gcal_list_calendars');
  // Pass 2: write tools now included
  assert(names.has('schedule_add_event'), 'should contain schedule_add_event (write)');
  assert(names.has('template_upsert'), 'should contain template_upsert (write)');
});

test('villagerToolNames: memories=shared → recall but not save_memory', () => {
  const names = villagerToolNames({ memories: 'shared' });
  assert(names.has('recall'), 'should contain recall');
  assert(!names.has('save_memory'), 'should not contain save_memory');
});

test('villagerToolNames: memories=true → recall AND memory write tools', () => {
  const names = villagerToolNames({ memories: true });
  assert(names.has('recall'), 'should contain recall');
  // Pass 2: write tools now included
  assert(names.has('save_memory'), 'should contain save_memory (write)');
  assert(names.has('update_memory_by_id'), 'should contain update_memory_by_id (write)');
});

test('villagerToolNames: contacts=care-visible → get_trusted_contacts but NOT contact_trusted_person', () => {
  const names = villagerToolNames({ contacts: 'care-visible' });
  assert(names.has('get_trusted_contacts'), 'should contain get_trusted_contacts');
  assert(!names.has('contact_trusted_person'), 'should not contain contact_trusted_person');
});

test('villagerToolNames: contacts=true → both get_trusted_contacts and contact_trusted_person', () => {
  const names = villagerToolNames({ contacts: true });
  assert(names.has('get_trusted_contacts'), 'should contain get_trusted_contacts');
  assert(names.has('contact_trusted_person'), 'should contain contact_trusted_person');
});

test('villagerToolNames: combined grants', () => {
  const names = villagerToolNames({
    schedule: 'full',
    memories: true,
    contacts: true,
  });
  // All the reads
  assert(names.has('schedule_availability'), 'should have schedule_availability');
  assert(names.has('schedule_export'), 'should have schedule_export');
  assert(names.has('recall'), 'should have recall');
  assert(names.has('get_trusted_contacts'), 'should have get_trusted_contacts');
  assert(names.has('contact_trusted_person'), 'should have contact_trusted_person');
  // And the relay
  assert(names.has(RELAY_TO_WARD_TOOL_NAME), 'should have relay_to_ward');
  // Pass 2: writes now included when granted
  assert(names.has('save_memory'), 'should contain save_memory (write)');
  assert(names.has('schedule_add_event'), 'should contain schedule_add_event (write)');
  // But NOT ward-only or identity operations
  assert(!names.has('update_identity'), 'should not contain update_identity (ward-only)');
  assert(!names.has('delete_memory_by_id'), 'should not contain delete_memory_by_id (ward-only delete)');
});

// ── composeDiscordTools: ward vs villager vs stranger ────────────────

test('composeDiscordTools: isWard=true → non-empty array with ward-only tools, NO relay_to_ward', () => {
  const tools = composeDiscordTools({ isWard: true });
  assert(Array.isArray(tools), 'should return an array');
  assert(tools.length > 0, 'should not be empty for ward');
  // Ward should have write tools like update_identity
  const names = tools.map(t => t.function?.name);
  assert(names.includes('update_identity'), 'ward should have update_identity');
  assert(names.includes('save_memory'), 'ward should have save_memory');
  // But NOT relay_to_ward (villager-only)
  assert(!names.includes(RELAY_TO_WARD_TOOL_NAME), 'ward should not have relay_to_ward');
});

test('composeDiscordTools: isVillager=true with schedule=coarse → array with exactly those tools', () => {
  const tools = composeDiscordTools({
    isVillager: true,
    grants: { schedule: 'coarse' },
  });
  assert(Array.isArray(tools), 'should return an array');
  const names = new Set(tools.map(t => t.function?.name));
  // Verify it matches the allowlist
  const expected = villagerToolNames({ schedule: 'coarse' });
  assert.deepEqual(names, expected, 'tool names should match villagerToolNames allowlist');
  // Must include relay_to_ward
  assert(names.has(RELAY_TO_WARD_TOOL_NAME), 'should include relay_to_ward');
  // Must NOT include write tools or ward-only tools
  assert(!names.has('update_identity'), 'should not include update_identity');
  assert(!names.has('save_memory'), 'should not include save_memory');
  assert(!names.has('create_graph_node'), 'should not include create_graph_node');
});

test('composeDiscordTools: stranger (no flags) → empty array', () => {
  const tools = composeDiscordTools({ isVillager: false, isWard: false });
  assert(Array.isArray(tools), 'should return an array');
  assert.equal(tools.length, 0, 'stranger should have no tools');
});

test('composeDiscordTools: villager with no grants → relay_to_ward and get_datetime', () => {
  const tools = composeDiscordTools({ isVillager: true, grants: {} });
  assert(Array.isArray(tools), 'should return an array');
  const names = new Set(tools.map(t => t.function?.name));
  assert.equal(names.size, 2, 'should have exactly 2 tools');
  assert(names.has(RELAY_TO_WARD_TOOL_NAME), 'should have relay_to_ward');
  assert(names.has('get_datetime'), 'should have get_datetime');
});

// ── Tool structure and macros ─────────────────────────────────────────

test('composeDiscordTools: returned tools have valid structure (name, description, parameters)', () => {
  const tools = composeDiscordTools({ isVillager: true, grants: { schedule: 'coarse' } });
  for (const tool of tools) {
    assert.equal(tool.type, 'function', 'type should be "function"');
    assert(tool.function, 'should have function field');
    assert(typeof tool.function.name === 'string', 'function.name should be string');
    assert(tool.function.name.length > 0, 'function.name should not be empty');
    assert(typeof tool.function.description === 'string', 'function.description should be string');
    assert(tool.function.parameters, 'should have parameters field');
  }
});

test('composeDiscordTools: returned tools have no literal {{user}} or {{char}} in descriptions', () => {
  const tools = composeDiscordTools({ isVillager: true, grants: { contacts: true } });
  for (const tool of tools) {
    const desc = tool.function?.description ?? '';
    assert(!desc.includes('{{user}}'), `tool ${tool.function?.name} should not have {{user}} in description`);
    assert(!desc.includes('{{char}}'), `tool ${tool.function?.name} should not have {{char}} in description`);
  }
});

test('composeDiscordTools: relay_to_ward tool has no literals in its description', () => {
  const tools = composeDiscordTools({ isVillager: true });
  const relayTool = tools.find(t => t.function?.name === RELAY_TO_WARD_TOOL_NAME);
  assert(relayTool, 'should have relay_to_ward tool');
  const desc = relayTool.function?.description ?? '';
  assert(!desc.includes('{{user}}'), 'relay_to_ward description should not have {{user}} literal');
  assert(!desc.includes('{{char}}'), 'relay_to_ward description should not have {{char}} literal');
  assert(desc.length > 0, 'relay_to_ward description should not be empty');
});

test('RELAY_TO_WARD_TOOL_NAME is the correct constant', () => {
  assert.equal(RELAY_TO_WARD_TOOL_NAME, 'relay_to_ward');
});

test('RELAY_TO_WARD_TOOL has correct structure', () => {
  assert.equal(RELAY_TO_WARD_TOOL.type, 'function');
  assert(RELAY_TO_WARD_TOOL.function, 'should have function');
  assert.equal(RELAY_TO_WARD_TOOL.function.name, RELAY_TO_WARD_TOOL_NAME);
  assert(RELAY_TO_WARD_TOOL.function.description, 'should have description');
  assert(RELAY_TO_WARD_TOOL.function.parameters, 'should have parameters');
  assert.equal(
    RELAY_TO_WARD_TOOL.function.parameters.type,
    'object',
    'parameters.type should be object'
  );
  assert.equal(
    RELAY_TO_WARD_TOOL.function.parameters.required[0],
    'summary',
    'summary should be in required'
  );
});

test('composeDiscordTools with settings argument resolves macros', () => {
  // Test that settings are passed through and used for macro resolution
  const tools = composeDiscordTools({
    isVillager: true,
    grants: { contacts: true },
    settings: { userName: 'TestUser', charName: 'TestFamiliar' },
  });
  // All descriptions should be resolved (no literals)
  for (const tool of tools) {
    const desc = tool.function?.description ?? '';
    assert(!desc.includes('{{user}}'), `${tool.function?.name} should have resolved {{user}}`);
    assert(!desc.includes('{{char}}'), `${tool.function?.name} should have resolved {{char}}`);
  }
});

test('composeDiscordTools: isWard takes precedence over isVillager', () => {
  // If somehow both are true, ward should win (full parity)
  const tools = composeDiscordTools({
    isWard: true,
    isVillager: true,
    grants: {},
  });
  const names = tools.map(t => t.function?.name);
  // Ward tools should be present
  assert(names.includes('update_identity'), 'ward should have update_identity');
  assert(names.includes('save_memory'), 'ward should have save_memory');
});

// ── discordReadAudiences: safety-critical fail-closed audience gate ────

test('discordReadAudiences: ward/web (no discord flag) → undefined (unscoped)', () => {
  assert.equal(discordReadAudiences({}), undefined);
});

test('discordReadAudiences: ward DM on discord (wardPrivate:true) → undefined (unscoped)', () => {
  assert.equal(discordReadAudiences({ discord: true, wardPrivate: true }), undefined);
});

test('discordReadAudiences: wardPrivate:false but no discord flag → undefined (unscoped)', () => {
  assert.equal(discordReadAudiences({ wardPrivate: false }), undefined);
});

test('discordReadAudiences: gated turn with audiences array → returns that same array', () => {
  const ctx = { discord: true, wardPrivate: false, audiences: ['villager:bob'] };
  assert.deepEqual(discordReadAudiences(ctx), ['villager:bob']);
});

test('discordReadAudiences: gated turn, missing audiences → [] (fail-closed, NOT undefined)', () => {
  const result = discordReadAudiences({ discord: true, wardPrivate: false });
  assert.deepEqual(result, []);
  assert.notEqual(result, undefined, 'must be [] not undefined — fail-closed');
});

test('discordReadAudiences: gated turn, audiences:null → [] (fail-closed)', () => {
  assert.deepEqual(discordReadAudiences({ discord: true, wardPrivate: false, audiences: null }), []);
});

test('discordReadAudiences: gated turn, audiences non-array (string) → [] (fail-closed)', () => {
  assert.deepEqual(discordReadAudiences({ discord: true, wardPrivate: false, audiences: 'oops' }), []);
});

test('discordReadAudiences: no argument → undefined (unscoped default)', () => {
  assert.equal(discordReadAudiences(), undefined);
});

// ── Pass 2: Write tools, provenance, audit logging ──────────────────────

test('VILLAGER_WRITE_TOOLS is a Set containing schedule and memory writes', () => {
  assert(VILLAGER_WRITE_TOOLS instanceof Set, 'should be a Set');
  // Schedule writes
  assert(VILLAGER_WRITE_TOOLS.has('schedule_add_event'), 'should have schedule_add_event');
  assert(VILLAGER_WRITE_TOOLS.has('schedule_add_hold'), 'should have schedule_add_hold');
  assert(VILLAGER_WRITE_TOOLS.has('schedule_delete'), 'should have schedule_delete');
  assert(VILLAGER_WRITE_TOOLS.has('template_upsert'), 'should have template_upsert');
  // Memory writes
  assert(VILLAGER_WRITE_TOOLS.has('save_memory'), 'should have save_memory');
  assert(VILLAGER_WRITE_TOOLS.has('update_memory_by_id'), 'should have update_memory_by_id');
  // Non-writes should NOT be in VILLAGER_WRITE_TOOLS
  assert(!VILLAGER_WRITE_TOOLS.has('recall'), 'should not have recall (read-only)');
  assert(!VILLAGER_WRITE_TOOLS.has('schedule_availability'), 'should not have schedule_availability (read-only)');
  assert(!VILLAGER_WRITE_TOOLS.has('relay_to_ward'), 'should not have relay_to_ward (notification)');
});

test('DISCORD_SCHEDULE_WRITE_TOOLS is an array of schedule mutations', () => {
  assert(Array.isArray(DISCORD_SCHEDULE_WRITE_TOOLS), 'should be an array');
  assert(DISCORD_SCHEDULE_WRITE_TOOLS.includes('schedule_add_event'), 'should include schedule_add_event');
  assert(DISCORD_SCHEDULE_WRITE_TOOLS.includes('schedule_add_hold'), 'should include schedule_add_hold');
  assert(DISCORD_SCHEDULE_WRITE_TOOLS.includes('schedule_delete'), 'should include schedule_delete');
  assert(DISCORD_SCHEDULE_WRITE_TOOLS.includes('template_upsert'), 'should include template_upsert');
  // No memory writes should be in schedule array
  assert(!DISCORD_SCHEDULE_WRITE_TOOLS.includes('save_memory'), 'should not have save_memory');
});

test('DISCORD_MEMORY_WRITE_TOOLS is an array of memory mutations', () => {
  assert(Array.isArray(DISCORD_MEMORY_WRITE_TOOLS), 'should be an array');
  assert(DISCORD_MEMORY_WRITE_TOOLS.includes('save_memory'), 'should include save_memory');
  assert(DISCORD_MEMORY_WRITE_TOOLS.includes('update_memory_by_id'), 'should include update_memory_by_id');
  assert(DISCORD_MEMORY_WRITE_TOOLS.includes('move_memory_date'), 'should include move_memory_date');
  assert(DISCORD_MEMORY_WRITE_TOOLS.includes('memorize_now'), 'should include memorize_now');
  // Deletes are ward-only
  assert(!DISCORD_MEMORY_WRITE_TOOLS.includes('delete_memory_by_id'), 'should not have delete_memory_by_id (ward-only)');
  assert(!DISCORD_MEMORY_WRITE_TOOLS.includes('delete_memory'), 'should not have delete_memory (ward-only)');
});

test('villagerToolNames: schedule=full includes all schedule write tools', () => {
  const names = villagerToolNames({ schedule: 'full' });
  for (const tool of DISCORD_SCHEDULE_WRITE_TOOLS) {
    assert(names.has(tool), `should include ${tool}`);
  }
});

test('villagerToolNames: schedule=coarse excludes all schedule write tools', () => {
  const names = villagerToolNames({ schedule: 'coarse' });
  for (const tool of DISCORD_SCHEDULE_WRITE_TOOLS) {
    assert(!names.has(tool), `should not include ${tool}`);
  }
});

test('villagerToolNames: memories=true includes all memory write tools', () => {
  const names = villagerToolNames({ memories: true });
  for (const tool of DISCORD_MEMORY_WRITE_TOOLS) {
    assert(names.has(tool), `should include ${tool}`);
  }
});

test('villagerToolNames: memories=shared excludes all memory write tools', () => {
  const names = villagerToolNames({ memories: 'shared' });
  for (const tool of DISCORD_MEMORY_WRITE_TOOLS) {
    assert(!names.has(tool), `should not include ${tool}`);
  }
  // But should still have recall
  assert(names.has('recall'), 'should still have recall');
});

test('villagerToolNames: schedule=full does NOT include schedule_push_to_google (ward-only)', () => {
  const names = villagerToolNames({ schedule: 'full' });
  assert(!names.has('schedule_push_to_google'), 'should not have schedule_push_to_google (ward-only external write)');
});

// ── discordWriteProvenance: audit trail for villager-caused writes ────────────

test('discordWriteProvenance: empty context → null', () => {
  assert.equal(discordWriteProvenance({}), null);
});

test('discordWriteProvenance: ward private turn (wardPrivate:true) → null', () => {
  const result = discordWriteProvenance({
    discord: true,
    wardPrivate: true,
    viaVillager: { id: 'v1', name: 'Bob' },
  });
  assert.equal(result, null, 'ward-private turns have no provenance');
});

test('discordWriteProvenance: no discord flag → null', () => {
  const result = discordWriteProvenance({
    wardPrivate: false,
    viaVillager: { id: 'v1', name: 'Bob' },
  });
  assert.equal(result, null);
});

test('discordWriteProvenance: gated villager turn with viaVillager → provenance object', () => {
  const result = discordWriteProvenance({
    discord: true,
    wardPrivate: false,
    audienceTag: 'villager:v1',
    viaVillager: { id: 'v1', name: 'Bob' },
  });
  assert(result !== null, 'should return an object');
  assert.equal(result.audience, 'villager:v1', 'audience should match audienceTag');
  assert.equal(result.sourceMeta.via, 'discord-villager', 'via should be discord-villager');
  assert.equal(result.sourceMeta.villager, 'Bob', 'villager should be the name');
  assert.equal(result.sourceMeta.villagerId, 'v1', 'villagerId should be the id');
});

test('discordWriteProvenance: villager with missing id → sourceMeta has via and villager, no villagerId', () => {
  const result = discordWriteProvenance({
    discord: true,
    wardPrivate: false,
    viaVillager: { name: 'Alice' },
  });
  assert(result !== null, 'should return an object');
  assert.equal(result.sourceMeta.via, 'discord-villager');
  assert.equal(result.sourceMeta.villager, 'Alice');
  assert(!('villagerId' in result.sourceMeta), 'should not have villagerId key when id is missing');
});

test('discordWriteProvenance: gated turn but no viaVillager → null', () => {
  const result = discordWriteProvenance({
    discord: true,
    wardPrivate: false,
    audienceTag: 'villager:v1',
  });
  assert.equal(result, null, 'requires viaVillager to return provenance');
});

test('discordWriteProvenance: villager with no name in viaVillager → defaults to "a villager"', () => {
  const result = discordWriteProvenance({
    discord: true,
    wardPrivate: false,
    viaVillager: { id: 'v99' },
  });
  assert(result !== null, 'should return an object');
  assert.equal(result.sourceMeta.villager, 'a villager', 'should use default name');
});

test('discordWriteProvenance: no audienceTag → audience is undefined', () => {
  const result = discordWriteProvenance({
    discord: true,
    wardPrivate: false,
    viaVillager: { id: 'v1', name: 'Bob' },
  });
  assert(result !== null, 'should return an object');
  assert.equal(result.audience, undefined, 'audience should be undefined when audienceTag is missing');
});
