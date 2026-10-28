import { test } from 'node:test';
import assert from 'node:assert/strict';
import { okResult, executeToolCall, TOOL_EXECUTORS } from '../cerebellum.js';
import { lastTurnRecord } from '../message-sanitize.mjs';

// Register throwaway executors so the boundary is tested end-to-end without
// touching real peers.
TOOL_EXECUTORS.__ok_probe     = async () => okResult('Task added (id: dentist-k3). It lands under Today.', { id: 'dentist-k3' });
TOOL_EXECUTORS.__ok_new_id    = async () => okResult('Saved it.', { id: 'note-a1' });
TOOL_EXECUTORS.__ok_bare      = async () => okResult('');
TOOL_EXECUTORS.__loud_failure = async () => 'Failed to add task: Unruh unavailable';
TOOL_EXECUTORS.__thrower      = async () => { throw new Error('boom'); };

// Known issue A2: a bare "ok" hid what a write did (and I kept rules like "an
// ok means something was added somewhere"). The reason it was bare, tokens
// recurring every turn, went away when collapseToolTurns stopped carrying
// results into later turns.

test('a success reads "ok:" plus what happened, and the id isn\'t repeated', async () => {
  assert.equal(await executeToolCall('__ok_probe', '{}'), 'ok: Task added (id: dentist-k3). It lands under Today.');
  assert.equal(await executeToolCall('__ok_new_id', '{}'), 'ok: Saved it. (id: note-a1)');
  assert.equal(await executeToolCall('__ok_bare', '{}'), 'ok');
});

test('failures pass through untouched — the boundary never classifies', async () => {
  assert.equal(await executeToolCall('__loud_failure', '{}'), 'Failed to add task: Unruh unavailable');
  assert.match(await executeToolCall('__thrower', '{}'), /Error executing __thrower: boom/);
});

test('macros resolve in the full text', async () => {
  TOOL_EXECUTORS.__ok_macro = async () => okResult('Saved for {{user}}.');
  try {
    const out = await executeToolCall('__ok_macro', '{}');
    assert.match(out, /^ok: Saved for /);
    assert.ok(!out.includes('{{user}}'), 'macros must not leak');
  } finally {
    delete TOOL_EXECUTORS.__ok_macro;
  }
});

test('the next turn\'s record still says just "ok" (the full text stays in its own turn)', async () => {
  const result = await executeToolCall('__ok_probe', '{}');
  const turn = [
    { role: 'user', content: 'add the dentist' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'schedule_add', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: result },
    { role: 'assistant', content: 'Done.' },
    { role: 'user', content: 'thanks' },
  ];
  assert.match(lastTurnRecord(turn), /schedule_add \(ok\)/);
});

test('write executors opted in; reads and safety tools did not', async () => {
  const src = (await import('fs')).readFileSync(new URL('../cerebellum.js', import.meta.url), 'utf8');
  // Spot-check the contract: adds/resolves/link mark success…
  for (const marker of ['okResult(`Task added', 'okResult(`Reminder set', 'okResult(`Marked ${id} as', 'okResult(`Linked ']) {
    assert.ok(src.includes(marker), `expected ${marker}`);
  }
  // …and the safety and load-bearing ones never call okResult in their executor.
  for (const name of ['contact_trusted_person', 'show_crisis_resources', 'schedule_push_to_google', 'memorize_now']) {
    const start = src.indexOf(`  ${name}: async`);
    assert.ok(start > 0, `executor ${name} found`);
    const body = src.slice(start, src.indexOf('\n  },', start));
    assert.ok(!body.includes('okResult('), `${name} keeps its own text`);
  }
});

test('the old escape hatch is gone', async () => {
  const src = (await import('fs')).readFileSync(new URL('../cerebellum.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('QUIET_TOOLS_DISABLED'));
});
