import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listProviderModels, modelsUrlFor } from '../provider-models.js';

test('modelsUrlFor derives the sibling /models URL per provider', () => {
  assert.strictEqual(modelsUrlFor('nanogpt'), 'https://nano-gpt.com/api/v1/models');
  assert.strictEqual(modelsUrlFor('zai'), 'https://api.z.ai/api/paas/v4/models');
  assert.strictEqual(modelsUrlFor('google'), 'https://generativelanguage.googleapis.com/v1beta/openai/models');
  assert.strictEqual(modelsUrlFor('nope'), null);
});

test('listProviderModels normalises the OpenAI data shape, dedupes, sorts', async () => {
  const httpFetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'b-model' }] }),
  });
  const r = await listProviderModels({ provider: 'nanogpt', apiKey: 'k', httpFetch });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.models.map(m => m.id), ['a-model', 'b-model']);
});

test('listProviderModels accepts bare-array and {models:[…]} shapes', async () => {
  for (const body of [['x1', 'x2'], { models: [{ id: 'x1' }, { id: 'x2' }] }]) {
    const httpFetch = async () => ({ ok: true, json: async () => body });
    const r = await listProviderModels({ provider: 'zai', apiKey: 'k', httpFetch });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.models.map(m => m.id), ['x1', 'x2']);
  }
});

test('listProviderModels: auth failure surfaces a key hint, never throws', async () => {
  const httpFetch = async () => ({ ok: false, status: 401 });
  const r = await listProviderModels({ provider: 'zai', apiKey: 'bad', httpFetch });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /401.*check the API key/);
});

test('listProviderModels: missing key / unknown provider fail closed', async () => {
  assert.strictEqual((await listProviderModels({ provider: 'zai', apiKey: '' })).ok, false);
  assert.strictEqual((await listProviderModels({ provider: 'zzz', apiKey: 'k' })).ok, false);
});

test('listProviderModels: network error becomes ok:false, not a throw', async () => {
  const httpFetch = async () => { throw new Error('boom'); };
  const r = await listProviderModels({ provider: 'zai', apiKey: 'k', httpFetch });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /boom/);
});
