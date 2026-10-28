// Recall results cut mid-word (known-issues A3). Phylactery now builds the
// excerpt itself (start + end at word boundaries, the shared marker) and says
// when it cut one; the recall tool tells me how to read the whole memory.
// These run the real executor through the real thalamus wrapper into a stub
// Phylactery. The excerpt itself is covered on both sides by the shared fixture
// (tests/excerpt.test.mjs, phylactery/tests/test_excerpt.py).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { executeToolCall, recallMoreTag } = await import('../cerebellum.js');
const { __setPhylacteryClientForTest } = await import('../thalamus.js');

let results = [];
beforeEach(() => {
  __setPhylacteryClientForTest({
    callTool: async ({ name }) => ({
      content: [{ type: 'text', text: JSON.stringify(name === 'memory_search' ? { results } : { ok: true }) }],
    }),
  });
});

test('a cut memory says how long it is and how to read all of it', async () => {
  results = [
    { id: 'walk-by-the-reservoir-k2', granularity: 'daily', date: '2026-07-02', score: 0.9,
      excerpt: 'We walked the long way round [… cut for length …] talked about the move.', truncated: true, chars: 1240 },
    { id: 'tea-not-coffee-a1', granularity: 'significant', date: '2026-06-01', score: 0.8, excerpt: 'Tea, never coffee.' },
  ];
  const out = String(await executeToolCall('recall', JSON.stringify({ query: 'the walk' })));
  assert.match(out, /talked about the move\. \(1240 chars; read_memory_by_id walk-by-the-reservoir-k2 shows all of it\)/);
  assert.match(out, /Tea, never coffee\.$/m, 'a whole memory gets no hint');
});

test('recallMoreTag needs both the cut flag and an id', () => {
  assert.equal(recallMoreTag({ truncated: true, id: 'x', chars: 900 }), ' (900 chars; read_memory_by_id x shows all of it)');
  assert.equal(recallMoreTag({ truncated: true, id: 'x' }), ' (read_memory_by_id x shows all of it)');
  assert.equal(recallMoreTag({ truncated: false, id: 'x' }), '');
  assert.equal(recallMoreTag({ truncated: true }), '');
});
