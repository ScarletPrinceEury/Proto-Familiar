// Wall-clock deadlines on callProviderChat — the background-loop half of the
// 0.14.63 Discord turn-deadline fix.
//
// A provider can send response headers and then hold the socket open with
// keep-alive bytes and never answer. undici's 300s idle timeouts never fire on
// a trickle, so an unbounded fetch never settles. Every background loop guards
// its tick with an in-flight flag that only clears when the tick settles — so
// one such call wedged the loop for good (pondering, warm reach-out, tome
// graduation, content re-tag, media retention, and memorization through its
// image-describe step). These tests cross the real fetch boundary against a
// local server that stalls exactly that way.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const {
  callProviderChat,
  isTimeoutError,
  deadlineSignal,
  PROVIDER_CALL_TIMEOUT_MS,
} = await import('../llm-call.js');

let server;
let baseUrl;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/stall')) {
      // Headers now, then a keep-alive space every 50ms and never a body.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const t = setInterval(() => res.write(' '), 50);
      req.on('close', () => clearInterval(t));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  delete process.env.PROTO_FAMILIAR_LLM_CALL_TIMEOUT_MS;
  server.closeAllConnections?.();
  server.close();
});

const callTo = (path, extra = {}) => callProviderChat({
  provider: 'custom', baseUrl: `${baseUrl}${path}/chat/completions`, model: 'test-model', apiKey: '',
  prompt: 'hello?', ...extra,
});

describe('callProviderChat — wall-clock bound on a provider round-trip', () => {
  it('gives up on a provider that sends headers and then stalls the body', { timeout: 5000 }, async () => {
    const t0 = Date.now();
    await assert.rejects(
      callTo('/stall', { timeoutMs: 300 }),
      (err) => isTimeoutError(err) && /custom/.test(err.message) && /test-model/.test(err.message),
    );
    assert.ok(Date.now() - t0 < 2000, 'rejected near the deadline, not at undici\'s 300s');
  });

  it('is bounded by default — a caller that passes no timeout still gets one', { timeout: 5000 }, async () => {
    // The env override exists so a slow self-hosted model can be given more
    // room; here it shrinks the default so the test can watch it fire.
    process.env.PROTO_FAMILIAR_LLM_CALL_TIMEOUT_MS = '300';
    try {
      await assert.rejects(callTo('/stall'), (err) => isTimeoutError(err));
    } finally {
      delete process.env.PROTO_FAMILIAR_LLM_CALL_TIMEOUT_MS;
    }
  });

  it('aborts mid-body when the caller\'s own signal fires, keeping the caller\'s reason', { timeout: 5000 }, async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(new DOMException('outer deadline', 'TimeoutError')), 200);
    await assert.rejects(
      callTo('/stall', { signal: ac.signal, timeoutMs: 60_000 }),
      (err) => isTimeoutError(err) && /outer deadline/.test(err.message),
    );
  });

  it('still returns a normal answer when one arrives in time', { timeout: 5000 }, async () => {
    assert.equal(await callTo('/ok', { timeoutMs: 2000 }), 'hi');
  });

  it('timeoutMs: 0 is an explicit opt-out (unbounded), never a zero-length deadline', () => {
    assert.equal(deadlineSignal({ timeoutMs: 0 }), undefined);
    assert.ok(Number.isFinite(PROVIDER_CALL_TIMEOUT_MS) && PROVIDER_CALL_TIMEOUT_MS > 0);
  });
});

describe('a background loop survives a stalled provider (pipeline)', () => {
  it('the warm reach-out loop runs its next tick after a call that never answers', { timeout: 8000 }, async () => {
    const { startReachoutLoop, stopReachoutLoop } = await import('../src/warmth/reachout-loop.js');
    process.env.PROTO_FAMILIAR_LLM_CALL_TIMEOUT_MS = '300';
    const errors = [];
    let resolveTwo;
    const twoTicks = new Promise(r => { resolveTwo = r; });
    startReachoutLoop({
      tickMs: 100,
      getThreat:          async () => ({ tier: 'calm', weight: 0 }),
      getLastActivity:    async () => null,
      getPendingTells:    async () => [],
      getWarmVillagers:   async () => [],
      isQuietHours:       async () => false,
      // The real deliberation's provider call, against the stalling server.
      decideReachout:     async () => callTo('/stall'),
      deliverWardKnock:   async () => ({ ok: true }),
      deliverVillagerReach: async () => ({ ok: true }),
      getWaitStreakFn:    () => null,
      onError: (err) => { errors.push(err); if (errors.length >= 2) resolveTwo(); },
    });
    try {
      await twoTicks;
      assert.ok(errors.every(isTimeoutError), 'each tick failed on the deadline, and the loop kept going');
    } finally {
      delete process.env.PROTO_FAMILIAR_LLM_CALL_TIMEOUT_MS;
      await stopReachoutLoop();
    }
  });
});
