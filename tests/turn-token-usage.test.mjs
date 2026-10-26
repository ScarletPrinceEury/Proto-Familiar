// A turn's token cost covers every round (0.14.96). The ward's NanoGPT budget
// is finite and weekly; before this, only the last provider round's `usage`
// survived a tool-using turn, so nothing could show what a turn really cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addUsage, runToolCallLoop } from '../cerebellum.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('addUsage sums rounds, reads reasoning and cached tokens, and keeps "nothing reported" as null', () => {
  assert.equal(addUsage(null, undefined), null);
  const one = addUsage(null, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, completion_tokens_details: { reasoning_tokens: 15 }, prompt_tokens_details: { cached_tokens: 60 } });
  const two = addUsage(one, { prompt_tokens: 130, completion_tokens: 10 });
  assert.deepEqual(two, { prompt_tokens: 230, completion_tokens: 30, total_tokens: 260, reasoning_tokens: 15, cached_tokens: 60, rounds: 2 });
});

test('runToolCallLoop reports the whole turn: every tool round plus the reply', async () => {
  let call = 0;
  const callUpstream = async () => {
    call++;
    if (call === 1) return { usage: { prompt_tokens: 1000, completion_tokens: 50 }, choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_datetime', arguments: '{}' } }] } }] };
    return { usage: { prompt_tokens: 1100, completion_tokens: 200 }, choices: [{ finish_reason: 'stop', message: { content: 'done' } }] };
  };
  const { data, usage } = await runToolCallLoop({ callUpstream, baseMessages: [{ role: 'user', content: 'hi' }], toolCtx: {} });
  assert.equal(data.choices[0].message.content, 'done');
  assert.deepEqual(usage, { prompt_tokens: 2100, completion_tokens: 250, total_tokens: 2350, reasoning_tokens: 0, cached_tokens: 0, rounds: 2 });
});

test('the bridge send script prints the turn cost', async () => {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reply: 'ok', toolsUsed: [], notes: [], usage: { prompt_tokens: 41000, completion_tokens: 900, reasoning_tokens: 600, cached_tokens: 30000, rounds: 2 } }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(REPO, 'scripts', 'claude-code-bridge.mjs'), '--message', 'hi'],
      { env: { ...process.env, PROTO_FAMILIAR_PORT: String(srv.address().port) } });
    let s = ''; p.stdout.on('data', d => { s += d; }); p.on('close', () => resolve(s));
  });
  srv.close();
  assert.match(out, /--- tokens this turn: 41000 in, 900 out \(600 reasoning\), 30000 cached, over 2 rounds/);
});

test("bridge turns use the ward's own reply cap, floor 8000, and a budget-exhausted turn says so", async () => {
  const { createClaudeCodeBridge, bridgeMaxTokens } = await import('../src/bridge/claude-code-bridge.js');
  assert.equal(bridgeMaxTokens({ maxTokens: 90000 }), 90000);
  assert.equal(bridgeMaxTokens({ maxTokens: 2000 }), 8000);
  assert.equal(bridgeMaxTokens({}), 8000);
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-cap-'));
  const sent = [];
  const bridge = createClaudeCodeBridge({
    port: 1, readSettings: () => ({ webSpeakers: ['Claude Code'], maxTokens: 90000 }),
    connectionForFeature: () => ({ provider: 'openai', apiKey: 'k', model: 'm' }),
    logsDir: path.join(dir, 'logs'), stateFile: path.join(dir, 'b.json'), log: () => {},
    fetchFn: async (_u, o) => { sent.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '' } }], _usage: { completion_tokens: 90000, rounds: 1 } }) }; },
  });
  const out = await bridge.send({ message: 'a dense message' });
  assert.equal(sent[0].max_tokens, 90000);
  assert.equal(out.ok, false);
  assert.match(out.error, /used its whole budget \(90000 tokens, 90000 spent\) thinking and wrote no reply \(finish: length\)/);
  assert.equal(out.usage.completion_tokens, 90000);
});
