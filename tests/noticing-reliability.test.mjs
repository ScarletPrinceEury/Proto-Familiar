// Noticing reliability (known-issues D1, ward-signed 0.14.121).
//
// About a third of due-intention looks were failing on provider trouble, and a
// failed look counted as seen, so a cool-down of up to six hours sat on what had
// come due. Now: only a look that ran counts; a failed look at something due
// tries again 5, 15 and 30 minutes on, through my human's fallback connections
// too; if it still can't get a look, my next live turn with my human says so,
// once. Every provider call's connection and time lands in the noticing log.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PROTO_FAMILIAR_NAME_FIELDS_DISABLED = '1';
process.env.PROTO_FAMILIAR_WAIT_STREAK_DISABLED = '1';

const { isUsageLimitError, providerErrorStatus } = await import('../llm-call.js');
const { connectionChain, fallbackWorthy, chainCaller } = await import('../src/util/connection-chain.js');
const { settleDueLooks, retryIsDue, startNoticingLoop, stopNoticingLoop } = await import('../src/safety/noticing-loop.js');
const { runNoticingToolLoop, runOneNoticingTick } = await import('../src/safety/noticing.js');
const held = await import('../src/safety/noticing-held.js');
const { runToolCallLoop } = await import('../cerebellum.js');
const { callChatRaw, providerFailureNote } = await import('../src/discord/discord-gateway.js');
const { __setPhylacteryClientForTest, enrich } = await import('../thalamus.js');

// Provider failures as the noticing log recorded them (reset dates trimmed).
const ZAI_WEEKLY   = 'provider zai-coding returned 429: {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-03 10:00:00"}}';
const ZAI_5H       = 'provider zai-coding returned 429: {"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-10-31 18:00:00"}}';
const NANO_WEEKLY  = 'provider nanogpt returned 429: {"error":{"message":"Weekly included input token limit exceeded. Enable \\"Use balance after limits\\" in your subscription settings"}}';
const NANO_PAYG    = 'provider nanogpt returned 403: {"code":"provider_selected","error":{"message":"Provider selection is pay-as-you-go, and paid API usage is disabled"}}';
const ZAI_BUSY     = 'provider zai-coding returned 429: {"error":{"code":"1305","message":"The service may be temporarily overloaded, please try again later"}}';
const ZAI_RATE     = 'provider zai-coding returned 429: {"error":{"code":"1302","message":"Rate limit reached for requests"}}';
const NANO_502     = 'provider nanogpt returned 502: {"error":{"message":"Service temporarily unavailable. Please try again later.","type":"server_error"}}';
const NANO_401     = 'provider nanogpt returned 401: {"error":{"message":"Invalid session","type":"invalid_api_key"}}';
const timeoutErr   = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

// ── Which failures are which ─────────────────────────────────────────────

test('a used-up allowance reads as one; a busy or rate-limited provider does not', () => {
  for (const m of [ZAI_WEEKLY, ZAI_5H, NANO_WEEKLY, NANO_PAYG]) assert.equal(isUsageLimitError(new Error(m)), true, m.slice(0, 60));
  for (const m of [ZAI_BUSY, ZAI_RATE, NANO_502, NANO_401, 'fetch failed', 'context length exceeded']) {
    assert.equal(isUsageLimitError(new Error(m)), false, m.slice(0, 60));
  }
  assert.equal(isUsageLimitError({ status: 402, message: '' }), true);
});

test('Discord\'s usage note now catches a weekly limit it used to call "returned nothing"', () => {
  assert.match(providerFailureNote(new Error(ZAI_WEEKLY)), /usage ran out/);
  assert.match(providerFailureNote(new Error(ZAI_RATE)), /didn't return anything/);
});

test('another connection is worth trying on a limit, a server error, a timeout or a dropped connection, not on a bad request', () => {
  for (const e of [new Error(ZAI_WEEKLY), new Error(NANO_PAYG), new Error(ZAI_BUSY), new Error(NANO_502), new Error('fetch failed'), timeoutErr()]) {
    assert.equal(fallbackWorthy(e), true, e.message.slice(0, 60));
  }
  for (const e of [new Error('provider x returned 400: bad request'), new Error(NANO_401)]) assert.equal(fallbackWorthy(e), false, e.message.slice(0, 60));
  assert.equal(providerErrorStatus({ status: 503 }), 503);
  assert.equal(providerErrorStatus(new Error('Provider nanogpt returned 429: x')), 429);
});

test('the chain is my connection, then my human\'s fallbacks in order: ready ones, each once', () => {
  const a = { id: 'a', provider: 'custom', baseUrl: 'http://x/a', model: 'm' };
  const b = { id: 'b', provider: 'custom', baseUrl: 'http://x/b', model: 'm' };
  const c = { id: 'c', provider: 'nanogpt', model: 'm' };                      // not ready: no key
  const d = { id: 'd', provider: 'custom', baseUrl: 'http://x/d', model: 'm' };
  const s = { connections: [a, b, c, d], fallbackConnectionIds: ['a', 'd', 'c', 'b', 'd', 'gone'] };
  assert.deepEqual(connectionChain(s, a).map(x => x.id), ['a', 'd', 'b']);
  assert.deepEqual(connectionChain(s, c), [], 'nothing when my own connection isn\'t ready');
});

describe('the chain caller', () => {
  const A = { id: 'a', name: 'Main', provider: 'p', model: 'm1', apiKey: 'sk-secret-a' };
  const B = { id: 'b', name: 'Backup', provider: 'q', model: 'm2', apiKey: 'sk-secret-b' };

  test('moves to the backup on a weekly limit, stays there for the next round, and logs no key', async () => {
    const tried = [];
    const calls = [];
    const call = chainCaller({
      chain: [A, B], onCall: (e) => calls.push(e),
      call: async (conn) => { tried.push(conn.id); if (conn.id === 'a') throw new Error(ZAI_WEEKLY); return { ok: conn.id }; },
    });
    assert.deepEqual(await call({}), { ok: 'b' });
    assert.deepEqual(await call({}), { ok: 'b' });
    assert.deepEqual(tried, ['a', 'b', 'b'], 'the second round starts at the backup');
    assert.deepEqual(calls.map(c => [c.connection, c.ok]), [['Main', false], ['Backup', true], ['Backup', true]]);
    assert.equal(calls[0].usageLimit, true);
    assert.ok(!JSON.stringify(calls).includes('sk-secret'), 'a call log never carries a key');
  });

  test('stops on a bad request, and once the turn\'s own time is up', async () => {
    const tried = [];
    const bad = chainCaller({ chain: [A, B], call: async (c) => { tried.push(c.id); throw new Error('provider p returned 400: bad'); } });
    await assert.rejects(bad({}), /400/);
    assert.deepEqual(tried, ['a']);
    const ac = new AbortController(); ac.abort();
    const late = [];
    const done = chainCaller({ chain: [A, B], signal: ac.signal, call: async (c) => { late.push(c.id); throw timeoutErr(); } });
    await assert.rejects(done({}));
    assert.deepEqual(late, ['a']);
  });

  test('marks the failure usage-limited only when every connection is out of allowance', async () => {
    const both = chainCaller({ chain: [A, B], call: async (c) => { throw new Error(c.id === 'a' ? ZAI_WEEKLY : NANO_WEEKLY); } });
    const e1 = await both({}).catch(e => e);
    assert.equal(e1.usageLimited, true);
    const one = chainCaller({ chain: [A, B], call: async (c) => { throw c.id === 'a' ? new Error(ZAI_WEEKLY) : timeoutErr(); } });
    const e2 = await one({}).catch(e => e);
    assert.equal(e2.usageLimited, false, 'the backup only timed out: it may answer in five minutes');
  });
});

// ── Retries and holds (pure) ──────────────────────────────────────────────

describe('settling a due intention after a tick', () => {
  const MIN = 60_000;
  const at  = { id: 'call-pharmacy-x7', what: 'Call the pharmacy', trigger: { kind: 'at', at: '2026-11-01T15:00:00' } };
  const ph  = { id: 'morning-round-k2', what: 'Morning round', trigger: { kind: 'phase', phase: 'morning', recurring: true } };
  const T0  = Date.parse('2026-11-01T15:00:00Z');

  test('a failed look tries again 5, 15 and 30 minutes after it first failed, then holds it', () => {
    let f = new Map();
    const retryAts = [];
    for (let i = 0; i < 4; i++) {
      const nowMs = T0 + [0, 5, 15, 30][i] * MIN;
      const s = settleDueLooks(f, { outcome: 'failed', due: [at], nowMs });
      f = s.failing;
      retryAts.push(s.retryAt == null ? null : (s.retryAt - T0) / MIN);
      if (i < 3) assert.equal(s.held.length, 0);
      else assert.deepEqual(s.held.map(e => e.intention.id), [at.id], 'out of tries after the third retry');
    }
    assert.deepEqual(retryAts, [5, 15, 30, null]);
    // Held: a fifth failure makes no second note and no more tries.
    const again = settleDueLooks(f, { outcome: 'failed', due: [at], nowMs: T0 + 50 * MIN });
    assert.equal(again.held.length, 0);
    assert.equal(again.retryAt, null);
  });

  test('every connection out of allowance holds it at once: trying again soon can\'t work', () => {
    const s = settleDueLooks(new Map(), { outcome: 'failed', due: [at], nowMs: T0, usageLimited: true });
    assert.deepEqual(s.held.map(e => e.intention.id), [at.id]);
    assert.equal(s.retryAt, null);
  });

  test('a look that ran covers it and takes back any note; a quiet tick leaves it waiting', () => {
    const f = settleDueLooks(new Map(), { outcome: 'failed', due: [at], nowMs: T0 }).failing;
    const quiet = settleDueLooks(f, { outcome: 'quiet', due: [at], nowMs: T0 + MIN });
    assert.equal(quiet.failing.get(at.id).tries, 1);
    const ran = settleDueLooks(f, { outcome: 'ran', due: [at], nowMs: T0 + 5 * MIN });
    assert.equal(ran.failing.size, 0);
    assert.deepEqual(ran.released, [at.id]);
  });

  test('a phase round whose window passed while it waited is held; a timed one that stopped being due was seen to', () => {
    const f = settleDueLooks(new Map(), { outcome: 'failed', due: [at, ph], nowMs: T0 }).failing;
    const s = settleDueLooks(f, { outcome: 'ran', due: [], nowMs: T0 + 5 * MIN });
    assert.deepEqual(s.held.map(e => e.intention.id), [ph.id]);
    assert.equal(s.failing.size, 0);
  });

  test('one an earlier look already had in front of it gets no tries and no note when a later look fails', () => {
    const s = settleDueLooks(new Map(), { outcome: 'failed', due: [at], nowMs: T0, covered: new Set([at.id]) });
    assert.equal(s.failing.size, 0);
    assert.equal(s.retryAt, null);
  });

  test('a retry is owed once its time has come', () => {
    const f = settleDueLooks(new Map(), { outcome: 'failed', due: [at], nowMs: T0 }).failing;
    assert.equal(retryIsDue(f, T0 + 4 * MIN), false);
    assert.equal(retryIsDue(f, T0 + 5 * MIN), true);
  });
});

// ── The held note ─────────────────────────────────────────────────────────

describe('the held note', () => {
  const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'pf-held-')), 'held.json');
  const at = { id: 'call-pharmacy-x7', what: 'Call the pharmacy', trigger: { kind: 'at', at: '2026-11-01T15:00:00' } };
  const ph = { id: 'morning-round-k2', what: 'Morning   round\nwith tea', trigger: { kind: 'phase', phase: 'morning' } };

  test('reads as the ward-approved line: HH:MM today, the day too otherwise', () => {
    assert.equal(held.heldNote([{ id: at.id, what: at.what, dueAt: '2026-11-01T15:00:00' }], { today: '2026-11-01' }),
      '[Came due while the model wasn\'t answering, so I haven\'t acted on it yet: Call the pharmacy (due 15:00, id call-pharmacy-x7).]');
    const two = held.heldNote([
      { id: at.id, what: at.what, dueAt: '2026-11-01T15:00:00' },
      { id: ph.id, what: ph.what, dueAt: '2026-10-31T07:20:00' },
    ], { today: '2026-11-01' });
    assert.equal(two, '[Came due while the model wasn\'t answering, so I haven\'t acted on these yet:\n'
      + '· Call the pharmacy (due 15:00, id call-pharmacy-x7)\n'
      + '· Morning round with tea (due Saturday 31 Oct, 07:20, id morning-round-k2)]');
  });

  test('a phase round is due at the ward-local time of its first failed look', () => {
    assert.equal(held.heldDueAt(at, 0, 'UTC'), '2026-11-01T15:00:00');
    assert.equal(held.heldDueAt(ph, Date.parse('2026-11-01T06:20:00Z'), 'Europe/Berlin'), '2026-11-01T07:20:00');
  });

  test('held once per occurrence, taken once, released by a look that ran', async () => {
    const f = file();
    const since = Date.parse('2026-11-01T14:00:00Z');
    assert.equal(await held.holdForChat([{ intention: at, since }, { intention: ph, since }], { file: f, timeZone: 'UTC' }), 2);
    assert.equal(await held.holdForChat([{ intention: at, since }], { file: f, timeZone: 'UTC' }), 0, 'no duplicate');
    assert.equal(await held.releaseHeld([ph.id], { file: f }), 1);
    const note = await held.takeHeldNote({ file: f, timeZone: 'UTC', now: Date.parse('2026-11-01T16:00:00Z') });
    assert.ok(note.includes('Call the pharmacy (due 15:00, id call-pharmacy-x7)'));
    assert.ok(!note.includes('Morning'));
    assert.equal(await held.takeHeldNote({ file: f, timeZone: 'UTC' }), '', 'only once');
  });

  test('keeps the newest ones when an outage runs for days', async () => {
    const f = file();
    const many = Array.from({ length: held.HELD_CAP + 5 }, (_, i) => ({ intention: { id: `r-${i}`, what: `round ${i}`, trigger: { kind: 'at', at: `2026-10-${String(1 + i).padStart(2, '0')}T07:00:00` } }, since: 0 }));
    await held.holdForChat(many, { file: f });
    const items = JSON.parse(readFileSync(f, 'utf8')).items;
    assert.equal(items.length, held.HELD_CAP);
    assert.equal(items.at(-1).id, `r-${held.HELD_CAP + 4}`);
  });
});

// ── PIPELINE: the loop, with real timers ────────────────────────────────

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const wakeInputs = (due) => async () => ({ dueIntentions: due(), signals: {}, baseline: null, contactGapMs: 0, readiness: [], agingIntents: [], weekdayClass: 'weekday' });

test('PIPELINE: in a six-hour cool-down, a failed look at something due tries again, then is held for my next chat', async () => {
  const due = [{ id: 'call-pharmacy-x7', what: 'Call the pharmacy', trigger: { kind: 'at', at: '2026-11-01T15:00:00' }, condition: {} }];
  let current = [];
  let failing = false;
  const looks = [];
  const heldCalls = [];
  const released = [];
  const ticks = [];
  startNoticingLoop({
    tickMs: 10,
    retryOffsetsMs: [40, 80, 120],
    getDueIntentionIds: async () => current.map(i => i.id),
    getThreat: async () => ({ tier: 'calm' }),
    getWakeInputs: wakeInputs(() => current),
    deliberate: async ({ conditions }) => {
      looks.push(conditions.map(c => c.intention?.id ?? c.kind));
      if (failing) throw new Error('fetch failed');
      return { toolNamesCalled: [], nextCheckInMs: 6 * 3600_000 };
    },
    onHeld: async (entries) => { heldCalls.push(entries.map(e => e.intention.id)); },
    onReleased: async (ids) => { released.push(...ids); },
    onTick: (r) => ticks.push(r),
  });
  try {
    // A first look sets a six-hour cool-down. Then the pharmacy call comes due
    // while the model is down.
    current = [{ id: 'warm-up', what: 'something earlier', trigger: { kind: 'at', at: '2026-11-01T09:00:00' }, condition: {} }];
    await wait(40);
    assert.equal(looks.length, 1);
    current = [...current, ...due];
    failing = true;
    await wait(500);
    assert.ok(ticks.some(t => t.dueWake === true), 'the newly due intention woke the cool-down');
    assert.equal(looks.length, 5, `the warm-up look, the failed look, then three retries and no more (looks: ${looks.length})`);
    assert.deepEqual(heldCalls, [['call-pharmacy-x7']], 'out of tries: held for my next chat, once (the warm-up already had its look)');
    assert.ok(ticks.some(t => Number.isFinite(t.retryAt)), 'the tick says when it tries again');
    assert.ok(ticks.some(t => Array.isArray(t.heldForChat) && t.heldForChat.includes('call-pharmacy-x7')));
    assert.ok(ticks.every(t => t.reason === 'in_cooldown' || Number.isFinite(t.tookMs)), 'every look says how long it took');
  } finally { await stopNoticingLoop(); }
  assert.deepEqual(released, ['warm-up'], 'only the first look ran, so only what it covered was released');
});

test('PIPELINE: a retry that gets through covers it, and takes back nothing it never held', async () => {
  const due = [{ id: 'water-plants-q3', what: 'Water the plants', trigger: { kind: 'at', at: '2026-11-01T15:00:00' }, condition: {} }];
  let fails = 1;
  const looks = [];
  const heldCalls = [];
  const released = [];
  startNoticingLoop({
    tickMs: 10,
    retryOffsetsMs: [40, 80, 120],
    getDueIntentionIds: async () => due.map(i => i.id),
    getThreat: async () => ({ tier: 'calm' }),
    getWakeInputs: wakeInputs(() => due),
    deliberate: async () => {
      looks.push(Date.now());
      if (fails-- > 0) throw Object.assign(new Error('a provider call gave no answer'), { calls: [] });
      return { toolNamesCalled: [], nextCheckInMs: 6 * 3600_000 };
    },
    onHeld: async (e) => { heldCalls.push(e); },
    onReleased: async (ids) => { released.push(...ids); },
  });
  try {
    await wait(200);
    assert.equal(looks.length, 2, 'the failed look, then the next look, which ran; the cool-down holds after');
    assert.deepEqual(heldCalls, []);
    assert.deepEqual(released, ['water-plants-q3']);
  } finally { await stopNoticingLoop(); }
});

test('PIPELINE: out of a cool-down, the base tick waits for the booked retries instead of using them up', async () => {
  const due = [{ id: 'take-meds-r4', what: 'Take the evening meds', trigger: { kind: 'at', at: '2026-11-01T20:00:00' }, condition: {} }];
  const lookTimes = [];
  let heldAt = null;
  startNoticingLoop({
    tickMs: 10,
    retryOffsetsMs: [40, 80, 120],
    getDueIntentionIds: async () => due.map(i => i.id),
    getThreat: async () => ({ tier: 'calm' }),
    getWakeInputs: wakeInputs(() => due),
    deliberate: async () => { lookTimes.push(Date.now()); throw new Error('fetch failed'); },
    onHeld: async () => { heldAt = Date.now(); },
  });
  try {
    await wait(400);
    assert.ok(heldAt, 'held in the end');
    const gaps = lookTimes.slice(1, 4).map(t => t - lookTimes[0]);
    // The 10 ms base tick would otherwise have used the three tries up within ~30 ms.
    assert.ok(gaps[0] >= 35 && gaps[1] >= 75 && gaps[2] >= 115, `the retries kept their times (${gaps.join(', ')} ms after the first failure)`);
    assert.ok(heldAt - lookTimes[0] >= 115, 'held only after the last retry');
  } finally { await stopNoticingLoop(); }
});

test('PIPELINE: a usage limit on every connection skips the retries and holds it straight away', async () => {
  const due = [{ id: 'stretch-z9', what: 'Stretch', trigger: { kind: 'at', at: '2026-11-01T15:00:00' }, condition: {} }];
  const looks = [];
  const heldCalls = [];
  startNoticingLoop({
    tickMs: 10,
    retryOffsetsMs: [40, 80, 120],
    getDueIntentionIds: async () => due.map(i => i.id),
    getThreat: async () => ({ tier: 'calm' }),
    getWakeInputs: wakeInputs(() => due),
    deliberate: async () => { looks.push(1); throw Object.assign(new Error(ZAI_WEEKLY), { usageLimited: true }); },
    onHeld: async (e) => { heldCalls.push(e.map(x => x.intention.id)); },
  });
  try {
    await wait(30);
    // The loop wasn't in a cool-down, so the base tick keeps its usual pacing;
    // what matters is that nothing waits on a retry and the note is written once.
    assert.ok(looks.length >= 1);
    assert.deepEqual(heldCalls, [['stretch-z9']]);
  } finally { await stopNoticingLoop(); }
});

// ── PIPELINE: across the real provider call, with a fallback ──────────────

describe('PIPELINE: the real call path falls back and logs each call', () => {
  let server, baseUrl;
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url.startsWith('/weekly')) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(ZAI_WEEKLY.replace(/^provider zai-coding returned 429: /, ''));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'nothing needs me right now' } }] }));
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise(r => server.close(r)));
  const connFor = (p, name) => ({ id: name, name, provider: 'custom', baseUrl: `${baseUrl}${p}/chat/completions`, model: 'test-model', apiKey: '' });
  const MESSAGES = [{ role: 'system', content: 'I take a look around.' }, { role: 'user', content: '(a quiet moment)' }];

  test('a weekly limit on noticing\'s connection: the backup answers, and both calls are in the record', async () => {
    const out = await runNoticingToolLoop({
      runLoop: runToolCallLoop, callRaw: callChatRaw,
      conn: connFor('/weekly', 'Main'), fallbacks: [connFor('/ok', 'Backup')],
      settings: {}, messages: MESSAGES, tools: [], executeTool: async () => 'ok', toolCtx: { noticing: true },
    });
    assert.equal(out.timedOut, false);
    assert.deepEqual(out.calls.map(c => [c.connection, c.ok]), [['Main', false], ['Backup', true]]);
    assert.equal(out.calls[0].usageLimit, true);
    assert.ok(out.calls.every(c => Number.isFinite(c.ms)));
  });

  test('with no backup, the tick fails marked usage-limited and carries its calls', async () => {
    const r = await runOneNoticingTick({
      getThreat: async () => ({ tier: 'calm' }),
      getWakeInputs: async () => ({ dueIntentions: [{ id: 'x', what: 'x', condition: {} }] }),
      relInterval: () => 'a bit',
      deliberate: () => runNoticingToolLoop({
        runLoop: runToolCallLoop, callRaw: callChatRaw, conn: connFor('/weekly', 'Main'),
        settings: {}, messages: MESSAGES, tools: [], executeTool: async () => 'ok', toolCtx: { noticing: true },
      }),
    });
    assert.equal(r.reason, 'deliberation_failed');
    assert.equal(r.usageLimited, true);
    assert.deepEqual(r.calls.map(c => c.connection), ['Main']);
  });
});

// ── PIPELINE: the note reaches my next live turn, once ────────────────────

beforeEach(() => {
  __setPhylacteryClientForTest({
    callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, items: [], results: [] }) }] }),
  });
});

test('PIPELINE: my live turn carries the held note once; a gated room or a background call never does', async () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'pf-held-enrich-')), 'held.json');
  held.__setNoticingHeldFileForTest(f);
  try {
    await held.holdForChat([{ intention: { id: 'call-pharmacy-x7', what: 'Call the pharmacy', trigger: { kind: 'at', at: '2026-11-01T15:00:00' } }, since: 0 }]);
    const room = await enrich('hello', { liveTurn: true, audience: 'friends', audiences: ['friends'], topicGrants: {} });
    assert.ok(!room.dynamic.includes('Came due while the model'), 'never in a gated room');
    const background = await enrich('hello', { liveTurn: false });
    assert.ok(!background.dynamic.includes('Came due while the model'), 'never on a background call');
    const mine = await enrich('hello', { liveTurn: true });
    assert.ok(mine.dynamic.includes('[Came due while the model wasn\'t answering, so I haven\'t acted on it yet: Call the pharmacy (due '), 'my own live turn shows it');
    const again = await enrich('hello', { liveTurn: true });
    assert.ok(!again.dynamic.includes('Came due while the model'), 'only once');
  } finally {
    held.__setNoticingHeldFileForTest(null);
  }
});
