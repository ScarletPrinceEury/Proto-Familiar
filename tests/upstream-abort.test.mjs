// Stopping provider requests when nobody is waiting (0.14.66).
//
// /api/chat meant to abort its provider request when my human's tab closed,
// but listened on req 'close' — which, since Node 16, fires when the request
// BODY has been read, long before the handler attaches its listener. So it
// never fired, and an abandoned turn ran on (spending tokens, holding a socket;
// forever, against a provider that trickles keep-alive bytes). These tests run
// a route shaped like /api/chat between a real client and a real stalling
// upstream, and check what reaches the upstream when the client hangs up.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { clientDisconnectSignal, upstreamSignal, upstreamFailure } = await import('../src/server/upstream-abort.js');
const { isTimeoutError } = await import('../llm-call.js');
const { generateWithGeminiFile, uploadVideoToGemini } = await import('../src/vision/gemini-file-api.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));

// The upstream provider: headers, then a keep-alive space every 50ms, forever.
// Records when each request's socket closes.
let upstream, upstreamUrl;
const upstreamClosed = new Map();   // path → ms timestamp
before(async () => {
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const t = setInterval(() => res.write(' '), 50);
    res.on('close', () => { clearInterval(t); upstreamClosed.set(req.url, Date.now()); });
  });
  upstreamUrl = await listen(upstream);
});
after(() => {
  delete process.env.PROTO_FAMILIAR_LLM_CALL_TIMEOUT_MS;
  upstream.closeAllConnections?.();
  upstream.close();
});

// A route like /api/chat: read the body, do some async work (enrichment), then
// make the upstream request. `detect` decides how it notices the client leaving.
async function routeServer(detect, path) {
  const srv = http.createServer(async (req, res) => {
    let clientSignal;
    if (detect === 'response') clientSignal = clientDisconnectSignal(res);   // top of the handler
    for await (const _ of req) { /* express.json() reads the body first */ }
    await sleep(100);                                                         // enrich()
    if (detect === 'request') {                                               // the old listener
      const ac = new AbortController();
      req.on('close', () => ac.abort());
      clientSignal = ac.signal;
    }
    try {
      const r = await fetch(`${upstreamUrl}${path}`, { method: 'POST', body: '{}', signal: upstreamSignal(clientSignal, { stream: true }) });
      await r.text();
      res.end('done');
    } catch { if (!res.writableEnded) res.end(); }
  });
  return { srv, url: await listen(srv) };
}

async function hangUpAfter(url, ms) {
  const ac = new AbortController();
  const p = fetch(url, { method: 'POST', body: '{"messages":[]}', signal: ac.signal }).catch(() => {});
  await sleep(ms);
  const at = Date.now();
  ac.abort();
  await p;
  return at;
}

describe('client disconnect reaches the provider request', () => {
  it('a client hanging up closes the upstream request (response close)', { timeout: 5000 }, async () => {
    const { srv, url } = await routeServer('response', '/via-response');
    try {
      const hungUpAt = await hangUpAfter(url, 400);
      for (let i = 0; i < 40 && !upstreamClosed.has('/via-response'); i++) await sleep(25);
      assert.ok(upstreamClosed.has('/via-response'), 'the provider request was closed');
      assert.ok(upstreamClosed.get('/via-response') - hungUpAt < 1000);
    } finally { srv.closeAllConnections?.(); srv.close(); }
  });

  it('the old req.on("close") listener never noticed — the upstream stayed open', { timeout: 5000 }, async () => {
    const { srv, url } = await routeServer('request', '/via-request');
    try {
      await hangUpAfter(url, 400);
      await sleep(600);
      assert.equal(upstreamClosed.has('/via-request'), false, 'this is the bug the fix closes');
    } finally { srv.closeAllConnections?.(); srv.close(); }
  });

  it('a response that finished normally does not abort', { timeout: 5000 }, async () => {
    let signal;
    const srv = http.createServer((req, res) => { signal = clientDisconnectSignal(res); res.end('ok'); });
    const url = await listen(srv);
    try {
      assert.equal(await (await fetch(url)).text(), 'ok');
      await sleep(50);
      assert.equal(signal.aborted, false);
    } finally { srv.close(); }
  });
});

describe('deadlines on provider requests', () => {
  it('a non-streaming request stops at the deadline and reports 504', { timeout: 5000 }, async () => {
    process.env.PROTO_FAMILIAR_LLM_CALL_TIMEOUT_MS = '300';
    try {
      const client = new AbortController().signal;
      const err = await fetch(`${upstreamUrl}/non-stream`, { method: 'POST', body: '{}', signal: upstreamSignal(client) })
        .then(r => r.text()).then(() => null, e => e);
      assert.ok(isTimeoutError(err));
      const f = upstreamFailure(err, { clientSignal: client, provider: 'custom' });
      assert.equal(f.status, 504);
      assert.match(f.message, /No complete answer from custom/);
    } finally { delete process.env.PROTO_FAMILIAR_LLM_CALL_TIMEOUT_MS; }
  });

  it('a stream gets no wall-clock deadline — only the client can stop it', { timeout: 5000 }, async () => {
    process.env.PROTO_FAMILIAR_LLM_CALL_TIMEOUT_MS = '100';
    try {
      const sig = upstreamSignal(new AbortController().signal, { stream: true });
      await sleep(300);
      assert.equal(sig.aborted, false);
    } finally { delete process.env.PROTO_FAMILIAR_LLM_CALL_TIMEOUT_MS; }
  });

  it('a client that left is 499 (nothing to send), a network error 502', () => {
    const gone = new AbortController(); gone.abort();
    assert.equal(upstreamFailure(new Error('x'), { clientSignal: gone.signal }).status, 499);
    assert.equal(upstreamFailure(new Error('ECONNRESET'), { clientSignal: new AbortController().signal, provider: 'p' }).status, 502);
  });
});

describe('video understanding (Gemini File API) is bounded', () => {
  it('generateContent stops at its deadline with a plain reason', { timeout: 5000 }, async () => {
    const r = await generateWithGeminiFile({ model: 'gemini-test', apiKey: 'k', baseUrl: `${upstreamUrl}/gemini`, prompt: 'p', fileUri: 'u', mimeType: 'video/mp4', timeoutMs: 300 });
    assert.equal(r.ok, false);
    assert.match(r.error, /generateContent: no answer from Google within 0s|generateContent: no answer from Google/);
  });

  it('the status poll stops when the request goes away instead of sleeping on', { timeout: 5000 }, async () => {
    const processing = { ok: true, status: 200, headers: { get: () => 'https://upload.example/u' }, json: async () => ({ file: { name: 'files/x', state: 'PROCESSING' } }) };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    const r = await uploadVideoToGemini({ buffer: Buffer.from('v'), mime: 'video/mp4', apiKey: 'k', fetchFn: async () => processing, pollMs: 10_000, signal: ac.signal });
    assert.equal(r.ok, false);
    assert.match(r.error, /cancelled/);
    assert.ok(Date.now() - t0 < 1500, 'did not wait out the 10s poll interval');
  });
});
