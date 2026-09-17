// The Familiar's own-tome tools (2026-09): save_to_tome targeting a named tome,
// create_tome, list_tomes — executor behaviour with stubbed deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initCerebellumTools, executeToolCall } from '../cerebellum.js';

function stubTomeDeps(over = {}) {
  const calls = { named: [], def: [], created: [] };
  initCerebellumTools({
    addDefaultTomeEntry: async (a) => { calls.def.push(a); return { uid: 'def-1' }; },
    addTomeEntryByName: async (a) => { calls.named.push(a); return { uid: 'named-1', created: a.name === 'New Tome' }; },
    createNamedTome: async (a) => { calls.created.push(a); return { created: a.name !== 'Existing' }; },
    listTomes: async () => over.tomes ?? [
      { name: 'General', description: '', entries: 3, enabled: true, protected: false },
      { name: 'Familiar Manual', description: 'how I work', entries: 12, enabled: true, protected: true },
    ],
  });
  return calls;
}

test('save_to_tome with a tome name routes to addTomeEntryByName, not the default', async () => {
  const calls = stubTomeDeps();
  const out = await executeToolCall('save_to_tome',
    JSON.stringify({ title: 'A poem', content: 'the poem', keywords: ['poem'], tome: 'Poems' }), {});
  assert.equal(calls.named.length, 1);
  assert.equal(calls.named[0].name, 'Poems');
  assert.equal(calls.def.length, 0, 'default path not used when a tome is named');
  assert.match(out, /named-1/, 'terse quietOk carries the entry id');
});

test('save_to_tome creating a new named tome routes with created:true', async () => {
  const calls = stubTomeDeps();
  await executeToolCall('save_to_tome',
    JSON.stringify({ title: 't', content: 'c', keywords: ['k'], tome: 'New Tome' }), {});
  assert.equal(calls.named[0].name, 'New Tome');   // stub returns created:true for this name
});

test('save_to_tome without a tome name keeps the default path', async () => {
  const calls = stubTomeDeps();
  const out = await executeToolCall('save_to_tome',
    JSON.stringify({ title: 't', content: 'c', keywords: ['k'] }), {});
  assert.equal(calls.def.length, 1);
  assert.equal(calls.named.length, 0);
  assert.match(out, /def-1/, 'default path, terse id');
});

test('save_to_tome still rejects empty content', async () => {
  stubTomeDeps();
  const out = await executeToolCall('save_to_tome', JSON.stringify({ title: 't', content: '   ', keywords: [] }), {});
  assert.match(out, /content is required/);
});

test('create_tome: new vs existing wording', async () => {
  stubTomeDeps();
  const made = await executeToolCall('create_tome', JSON.stringify({ name: 'Recipes', description: 'food' }), {});
  assert.match(made, /Started a new tome, "Recipes"/);
  const dup = await executeToolCall('create_tome', JSON.stringify({ name: 'Existing' }), {});
  assert.match(dup, /already keep a tome called "Existing"/);
});

test('create_tome without a name asks for one', async () => {
  stubTomeDeps();
  const out = await executeToolCall('create_tome', JSON.stringify({ description: 'x' }), {});
  assert.match(out, /need a name/);
});

test('list_tomes formats names, counts, and the protected tag', async () => {
  stubTomeDeps();
  const out = await executeToolCall('list_tomes', '{}', {});
  assert.match(out, /General \(3 entries\)/);
  assert.match(out, /Familiar Manual \(12 entries\) — how I work \[protected\]/);
});

test('list_tomes when there are none', async () => {
  stubTomeDeps({ tomes: [] });
  const out = await executeToolCall('list_tomes', '{}', {});
  assert.match(out, /don't keep any tomes yet/);
});
