import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quietOk, executeToolCall, TOOL_EXECUTORS } from '../cerebellum.js';

// Register throwaway executors so the boundary is tested end-to-end without
// touching real peers.
TOOL_EXECUTORS.__quiet_probe   = async () => quietOk('Task added (id: dentist-k3). Long prose here.', { id: 'dentist-k3' });
TOOL_EXECUTORS.__quiet_no_id   = async () => quietOk('Saved.');
TOOL_EXECUTORS.__loud_failure  = async () => 'Failed to add task: Unruh unavailable';
TOOL_EXECUTORS.__thrower       = async () => { throw new Error('boom'); };

test('quiet success collapses to ok + id (the id survives for chaining)', async () => {
  const out = await executeToolCall('__quiet_probe', '{}');
  assert.equal(out, 'ok (id: dentist-k3)');
});

test('quiet success without id collapses to bare ok', async () => {
  assert.equal(await executeToolCall('__quiet_no_id', '{}'), 'ok');
});

test('failures pass through LOUD and untouched — the boundary never classifies', async () => {
  assert.equal(await executeToolCall('__loud_failure', '{}'), 'Failed to add task: Unruh unavailable');
  assert.match(await executeToolCall('__thrower', '{}'), /Error executing __thrower: boom/);
});

test('PROTO_FAMILIAR_QUIET_TOOLS_DISABLED=1 restores the full prose', async () => {
  process.env.PROTO_FAMILIAR_QUIET_TOOLS_DISABLED = '1';
  try {
    assert.equal(await executeToolCall('__quiet_probe', '{}'), 'Task added (id: dentist-k3). Long prose here.');
  } finally {
    delete process.env.PROTO_FAMILIAR_QUIET_TOOLS_DISABLED;
  }
});

test('macro substitution still applies to the collapsed result path', async () => {
  TOOL_EXECUTORS.__quiet_macro = async () => quietOk('Saved for {{user}}.');
  // Collapsed form has no macros; disabled form resolves them at the boundary.
  process.env.PROTO_FAMILIAR_QUIET_TOOLS_DISABLED = '1';
  try {
    const out = await executeToolCall('__quiet_macro', '{}');
    assert.ok(!out.includes('{{user}}'), 'macros must not leak');
  } finally {
    delete process.env.PROTO_FAMILIAR_QUIET_TOOLS_DISABLED;
    delete TOOL_EXECUTORS.__quiet_macro;
  }
});

test('write executors opted in; reads and safety tools did not', async () => {
  const src = (await import('fs')).readFileSync(new URL('../cerebellum.js', import.meta.url), 'utf8');
  // Spot-check the contract: adds/resolves/link are quiet…
  for (const marker of ['quietOk(`Task added', 'quietOk(`Reminder set', 'quietOk(`Marked ${id} as', 'quietOk(`Linked ']) {
    assert.ok(src.includes(marker), `expected ${marker}`);
  }
  // …and the deliberately-loud ones never call quietOk in their executor.
  for (const name of ['contact_trusted_person', 'show_crisis_resources', 'schedule_push_to_google', 'memorize_now']) {
    const start = src.indexOf(`  ${name}: async`);
    assert.ok(start > 0, `executor ${name} found`);
    const body = src.slice(start, src.indexOf('\n  },', start));
    assert.ok(!body.includes('quietOk('), `${name} must stay loud`);
  }
});
