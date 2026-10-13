// Deadlines on the two safety-adjacent deliberations (ward-signed 0.14.64):
// silence triage and noticing.
//
// Both loops guard their tick with an in-flight flag that clears only when the
// tick settles. A provider that sends headers and then trickles keep-alive bytes
// never settles an unbounded fetch (undici's idle timeouts never fire on a
// trickle), so one such call used to stop the loop for good: triage stopped
// deliberating on a distressed ward, and noticing stopped noticing. These tests
// cross the real provider-call code into a local server that stalls that way.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// No name-field learning writes, no wait-streak writes from these calls.
process.env.PROTO_FAMILIAR_NAME_FIELDS_DISABLED = '1';
process.env.PROTO_FAMILIAR_WAIT_STREAK_DISABLED = '1';

const { callTriageDeliberation, TRIAGE_CALL_TIMEOUT_MS, runToolCallLoop } = await import('../cerebellum.js');
const { callChatRaw } = await import('../src/discord/discord-gateway.js');
const { startSilenceTriageLoop, stopSilenceTriageLoop } = await import('../src/safety/silence-triage-loop.js');
const {
  runNoticingToolLoop, runOneNoticingTick,
  NOTICING_CALL_TIMEOUT_MS, NOTICING_DELIBERATION_TIMEOUT_MS,
} = await import('../src/safety/noticing.js');

let server;
let baseUrl;
const hits = new Map();

const toolCallReply = {
  choices: [{
    finish_reason: 'tool_calls',
    message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'reach_out_to_ward', arguments: '{"message":"hey"}' } }] },
  }],
};

before(async () => {
  server = http.createServer((req, res) => {
    const n = (hits.get(req.url) ?? 0) + 1;
    hits.set(req.url, n);
    const stall = () => {
      // Headers now, then a keep-alive space every 50ms and never a body.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const t = setInterval(() => res.write(' '), 50);
      req.on('close', () => clearInterval(t));
    };
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/stall')) return stall();
    if (req.url.startsWith('/tool-then-stall')) return n === 1 ? json(200, toolCallReply) : stall();
    if (req.url.startsWith('/broken')) return json(500, { error: 'upstream exploded' });
    json(200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"action":"wait"}' } }] });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections?.();
  server.close();
});

const connFor = (path) => ({ provider: 'custom', baseUrl: `${baseUrl}${path}/chat/completions`, model: 'test-model', apiKey: '' });
const MESSAGES = [{ role: 'system', content: 'deliberate' }, { role: 'user', content: '(a quiet moment)' }];

describe('triage deliberation call', () => {
  it('the ward-signed deadline is 180s', () => {
    assert.equal(TRIAGE_CALL_TIMEOUT_MS, 180_000);
  });

  it('a stalled provider ends in the safe default — wait, marked failed, with the reason', { timeout: 5000 }, async () => {
    const t0 = Date.now();
    const r = await callTriageDeliberation({ conn: connFor('/stall'), messages: MESSAGES, timeoutMs: 300 });
    assert.equal(r.ok, false);
    assert.deepEqual({ action: r.decision.action, failed: r.decision.failed }, { action: 'wait', failed: true });
    assert.match(r.decision.error, /no complete answer within/);
    assert.ok(Date.now() - t0 < 2000);
  });

  it('carries a deadline on the fetch and leaves the request itself unchanged', async () => {
    let seen;
    const fetchFn = async (_url, opts) => {
      seen = opts;
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"action":"wait"}' } }] }) };
    };
    const r = await callTriageDeliberation({ conn: connFor('/ok'), messages: MESSAGES, fetchFn });
    assert.deepEqual(r, { ok: true, text: '{"action":"wait"}' });
    assert.ok(seen.signal instanceof AbortSignal && !seen.signal.aborted);
    const body = JSON.parse(seen.body);
    assert.equal(body.temperature, 0.7);
    assert.equal(body.max_tokens, 4000);
    assert.equal('reasoning_effort' in body, false, 'triage request stays byte-identical');
  });

  it('the silence-triage loop keeps ticking after a deliberation that never answered (pipeline)', { timeout: 8000 }, async () => {
    const reasons = [];
    let resolveAlive;
    const alive = new Promise(r => { resolveAlive = r; });
    startSilenceTriageLoop({
      tickMs: 100,
      getThreat:       async () => ({ tier: 'severe', weight: 9 }),
      getLastActivity: async () => ({ ts: '...', ms: Date.now() - 60 * 60_000 }),
      decideTriage:    async () => {
        const call = await callTriageDeliberation({ conn: connFor('/stall'), messages: MESSAGES, timeoutMs: 300 });
        return call.ok ? { action: 'wait' } : call.decision;
      },
      enqueueOutboxFn: async () => ({ id: 'x', deduped: false }),
      onTick: (r) => { reasons.push(r.reason); if (reasons.length >= 2) resolveAlive(); },
    });
    try {
      await alive;
      assert.equal(reasons[0], 'deliberation_failed');
      assert.ok(reasons.length >= 2, 'a later tick ran — the in-flight guard cleared');
    } finally {
      await stopSilenceTriageLoop();
    }
  });
});

describe('noticing deliberation tool loop', () => {
  const run = (path, extra = {}) => {
    const ran = [];
    const p = runNoticingToolLoop({
      runLoop: runToolCallLoop, callRaw: callChatRaw,
      conn: connFor(path), settings: {}, messages: MESSAGES, tools: [],
      executeTool: async (name) => { ran.push(name); return 'Sent — my human will see it.'; },
      toolCtx: { noticing: true },
      ...extra,
    });
    return { p, ran };
  };

  it('the ward-signed deadlines are 180s per call and 600s for the whole deliberation', () => {
    assert.equal(NOTICING_CALL_TIMEOUT_MS, 180_000);
    assert.equal(NOTICING_DELIBERATION_TIMEOUT_MS, 600_000);
  });

  it('a call that stalls after a tool already ran stops at the per-call deadline and keeps what ran', { timeout: 5000 }, async () => {
    const { p, ran } = run('/tool-then-stall/a', { callTimeoutMs: 300, totalTimeoutMs: 60_000 });
    const r = await p;
    assert.equal(r.timedOut, true);
    assert.match(r.error, /no answer within 0\.3s/);
    assert.deepEqual(ran, ['reach_out_to_ward'], 'the reach-out that went out still counts');
  });

  it('the whole-deliberation deadline fires even when each call is allowed longer', { timeout: 5000 }, async () => {
    const { p, ran } = run('/tool-then-stall/b', { callTimeoutMs: 60_000, totalTimeoutMs: 400 });
    const r = await p;
    assert.equal(r.timedOut, true);
    assert.match(r.error, /0\.4s deadline/);
    assert.deepEqual(ran, ['reach_out_to_ward']);
  });

  it('the whole-deliberation deadline also covers a tool call that never returns', { timeout: 5000 }, async () => {
    const r = await runNoticingToolLoop({
      runLoop: runToolCallLoop, callRaw: callChatRaw,
      conn: connFor('/tool-then-stall/c'), settings: {}, messages: MESSAGES, tools: [],
      executeTool: () => new Promise(() => {}),
      toolCtx: {}, callTimeoutMs: 60_000, totalTimeoutMs: 300,
    });
    assert.equal(r.timedOut, true);
  });

  it('a non-timeout failure still throws (deliberation_failed upstream, unchanged)', { timeout: 5000 }, async () => {
    await assert.rejects(run('/broken').p, /500/);
  });

  it('a normal deliberation is untouched', { timeout: 5000 }, async () => {
    const r = await run('/ok').p;
    assert.equal(r.timedOut, false);
  });
});

describe('noticing tick — a timed-out deliberation', () => {
  const baseTick = (deliberate, calls) => ({
    getThreat:     async () => ({ tier: 'calm' }),
    getWakeInputs: async () => ({ dueIntentions: [{ id: 'd', what: 'check in about the move', condition: {} }] }),
    isQuietHours:  async () => false,
    relInterval:   (ms) => `${Math.round(ms / 3_600_000)}h`,
    now:           () => 1_000_000,
    deliberate,
    recordWaitFn:      async (s) => calls.push(`wait:${s}`),
    recordProactiveFn: async () => calls.push('proactive'),
  });

  it('that already reached out counts as acted', async () => {
    const calls = [];
    const r = await runOneNoticingTick(baseTick(async () => ({ toolNamesCalled: ['reach_out_to_ward'], timedOut: true, error: 'x' }), calls));
    assert.equal(r.reason, 'acted');
    assert.equal(r.timedOut, true);
    assert.deepEqual(calls, ['proactive']);
  });

  it('that did nothing proactive is a failure, not a wait', async () => {
    const calls = [];
    const r = await runOneNoticingTick(baseTick(async () => ({ toolNamesCalled: ['schedule_find'], timedOut: true, error: 'a provider call gave no answer within 180s' }), calls));
    assert.equal(r.reason, 'deliberation_failed');
    assert.match(r.error, /no answer within 180s/);
    assert.deepEqual(calls, [], 'no streak change — no decision was made');
  });
});
