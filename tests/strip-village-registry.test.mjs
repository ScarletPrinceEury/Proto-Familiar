/**
 * stripVillageRegistry keeps the Village registry (machine routing/gating JSON,
 * stored in Phylactery's meta table now — never identity) out of every identity
 * bucket, so a legacy custom/village-registry.md row can never render into the
 * identity block or the Knowledge editor's Identity tab.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripVillageRegistry } from '../thalamus.js';

test('removes village-registry.md from every identity bucket', () => {
  const id = {
    self: [{ filename: 'base_instructions.md' }, { filename: 'my_persona.md' }],
    ward: [{ filename: 'user_life.md' }],
    relationship: [{ filename: 'village-registry.md', content: '```json\n{}\n```' }], // mis-filed legacy copy
    custom: [{ filename: 'village-registry.md' }, { filename: 'what_lapses_cost.md' }],
  };
  const out = stripVillageRegistry(id);
  assert.deepEqual(out.self.map(f => f.filename), ['base_instructions.md', 'my_persona.md']);
  assert.deepEqual(out.ward.map(f => f.filename), ['user_life.md']);
  assert.deepEqual(out.relationship.map(f => f.filename), [], 'stripped even from a non-custom bucket');
  assert.deepEqual(out.custom.map(f => f.filename), ['what_lapses_cost.md'], 'other custom files survive');
});

test('is a no-op when no registry file is present', () => {
  const id = { self: [{ filename: 'my_persona.md' }], custom: [{ filename: 'what_lapses_cost.md' }] };
  const out = stripVillageRegistry(id);
  assert.deepEqual(out.self.map(f => f.filename), ['my_persona.md']);
  assert.deepEqual(out.custom.map(f => f.filename), ['what_lapses_cost.md']);
});

test('tolerates missing buckets, non-array buckets, and non-object input', () => {
  assert.deepEqual(stripVillageRegistry({ custom: [{ filename: 'village-registry.md' }] }).custom, []);
  assert.doesNotThrow(() => stripVillageRegistry({ self: null, ward: undefined }));
  assert.equal(stripVillageRegistry(null), null);
  assert.equal(stripVillageRegistry('nope'), 'nope');
});
