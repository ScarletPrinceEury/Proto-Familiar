// Discord turn deadlines — the "Familiar stopped receiving Discord messages" bug.
//
// A provider sent response headers, then held the socket open with
// keep-alive bytes and never answered. undici's 300s idle timeouts never fire on
// a trickle, the Discord turn had no deadline of its own, and turns are
// serialized per location — so that one hung call held every later DM in the
// queue forever: none of them was even read. These tests cross the real fetch
// boundary against a local server that stalls the same way.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// No name-field learning writes from these calls (keeps tomes/ untouched).
process.env.PROTO_FAMILIAR_NAME_FIELDS_DISABLED = '1';

const {
  callChatRaw,
  enqueueTurn,
  isTimeoutError,
  providerFailureNote,
} = await import('../src/discord/discord-gateway.js');

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
  server.closeAllConnections?.();
  server.close();
});

const connFor = (path) => ({ provider: 'custom', baseUrl: `${baseUrl}${path}/chat/completions`, model: 'test-model', apiKey: '' });
const MESSAGES = [{ role: 'user', content: 'hello?' }];

describe('callChatRaw — wall-clock bound on a provider round-trip', () => {
  it('gives up on a provider that sends headers and then stalls the body', { timeout: 5000 }, async () => {
    const t0 = Date.now();
    await assert.rejects(
      callChatRaw({ conn: connFor('/stall'), messages: MESSAGES, settings: {}, timeoutMs: 300 }),
      (err) => isTimeoutError(err),
    );
    assert.ok(Date.now() - t0 < 2000, 'rejected near the deadline, not at undici\'s 300s');
  });

  it('aborts mid-body when the caller\'s turn signal fires', { timeout: 5000 }, async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(new DOMException('turn deadline', 'TimeoutError')), 200);
    await assert.rejects(
      callChatRaw({ conn: connFor('/stall'), messages: MESSAGES, settings: {}, signal: ac.signal, timeoutMs: 60_000 }),
      (err) => isTimeoutError(err) && /turn deadline/.test(err.message),
    );
  });

  it('still returns a normal answer when one arrives in time', { timeout: 5000 }, async () => {
    const data = await callChatRaw({ conn: connFor('/ok'), messages: MESSAGES, settings: {}, timeoutMs: 2000 });
    assert.equal(data.choices[0].message.content, 'hi');
  });
});

describe('enqueueTurn — one stuck turn never blocks the room', () => {
  it('a turn that honours its signal ends at the deadline and the next message runs', { timeout: 5000 }, async () => {
    let first;
    const hung = enqueueTurn('test:deadline-honoured', (turn) => {
      first = turn;
      return callChatRaw({ conn: connFor('/stall'), messages: MESSAGES, settings: {}, signal: turn.signal, timeoutMs: 60_000 });
    }, { deadlineMs: 250, graceMs: 5000 });
    const next = enqueueTurn('test:deadline-honoured', () => 'read and answered', { deadlineMs: 250, graceMs: 5000 });

    await assert.rejects(hung, (err) => isTimeoutError(err));
    assert.equal(await next, 'read and answered');
    assert.equal(first.signal.aborted, true);
    assert.equal(first.abandoned, false, 'it finished inside the grace window, so it was not abandoned');
  });

  it('a turn that ignores its signal is abandoned and the queue moves on', { timeout: 5000 }, async () => {
    let first;
    let abandonNotes = 0;
    const order = [];
    const stuck = enqueueTurn('test:deadline-ignored', (turn) => {
      first = turn;
      turn.onAbandon = () => { abandonNotes += 1; };
      order.push('stuck turn started');
      return new Promise(() => {});   // e.g. a tool call that never returns
    }, { deadlineMs: 150, graceMs: 100 });
    const next = enqueueTurn('test:deadline-ignored', () => {
      order.push('next message read');
      return 'answered';
    }, { deadlineMs: 150, graceMs: 100 });

    assert.equal(await next, 'answered');
    await stuck;   // released, not rejected
    assert.deepEqual(order, ['stuck turn started', 'next message read']);
    assert.equal(first.abandoned, true);
    assert.equal(first.signal.aborted, true);
    assert.ok(isTimeoutError(first.signal.reason));
    assert.equal(abandonNotes, 1, 'my human is told once, never left in silence');
  });

  it('a quick turn passes straight through with no deadline side-effects', { timeout: 5000 }, async () => {
    let seen;
    const out = await enqueueTurn('test:deadline-fast', (turn) => { seen = turn; return 42; }, { deadlineMs: 60_000, graceMs: 60_000 });
    assert.equal(out, 42);
    assert.equal(seen.signal.aborted, false);
    assert.equal(seen.abandoned, false);
    // (If the deadline timers leaked, this file would hold the process open for a minute.)
  });
});

describe('providerFailureNote — a timeout says so', () => {
  it('names the timeout instead of "returned nothing"', () => {
    assert.match(providerFailureNote(new DOMException('x', 'TimeoutError')), /took too long/);
    assert.match(providerFailureNote(new Error('provider returned empty content')), /didn't return anything/);
  });
});
