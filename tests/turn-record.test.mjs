// A turn's record lands in its session log as the turn goes (0.14.106).
//
// A tool round used to be recorded only once its turn finished: the web chat
// committed my human's message, the rounds and the reply together, voice kept
// only the words, and Discord kept only the reply. A turn that broke off after
// its tools ran left no trace of them; the web chat then retried it, running
// every write twice; and on Discord the "[Last turn …]" line never appeared,
// because it was built from a history that already held the current message
// plus a placeholder for it. These run the real recorder and the real log
// writer against a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { extractFunctionSource } from './_vm-extract.mjs';

const {
  parseTurnEnvelope, openTurn, createTurnRecorder, toolRoundMessages, turnRanTools, turnMessagesOf,
  unansweredTurnId, toApiHistory, awaitTurnSettled, cutOffNoteText,
} = await import('../src/sessions/turn-record.js');
const { appendSessionMessages, readSessionMessages } = await import('../src/sessions/session-log.js');
const { lastTurnRecord, collapseToolTurns, isAppNote } = await import('../message-sanitize.mjs');
const { isReadableMessage } = await import('../src/schedule/day-segments.js');
const { keepCallTurn, createVoiceChatTurn } = await import('../src/voice/voice-chat-turn.js');
const { buildHistoryForPrompt, discordLastTurnLine } = await import('../src/discord/discord-gateway.js');

const okId = (id) => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id);
const tempLogs = () => path.join(mkdtempSync(path.join(tmpdir(), 'turn-record-')), 'logs');
let n = 0;
const envelope = (over = {}) => ({
  sessionId: 's-20261028-test', turnId: `turn-${++n}`, replyMessageId: `reply-${n}`,
  location: { platform: 'web', label: 'Web chat' },
  userMessage: { id: `user-${n}`, content: 'save that, please', timestamp: '2026-10-28T10:00:00.000Z' },
  ...over,
});
const CALL = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });
const round = (i, name) => ({ round: i, toolCalls: [CALL(`c${i}`, name)], results: [{ tool_call_id: `c${i}`, name, content: 'ok' }], content: null });

test('an envelope keeps only what a turn needs; anything malformed means no journaling', () => {
  const e = parseTurnEnvelope({ ...envelope(), userMessage: { ...envelope().userMessage, extra: 'x', speaker: 'Sam' } }, { isValidSessionId: okId });
  assert.equal(e.userMessage.extra, undefined);
  assert.equal(e.userMessage.speaker, 'Sam');
  assert.equal(e.userMessage.role, 'user');
  assert.equal(e.userMessage.turnId, e.turnId);
  assert.equal(e.retry, false);
  assert.equal(parseTurnEnvelope({ ...envelope(), retry: true }, { isValidSessionId: okId }).retry, true);
  assert.equal(parseTurnEnvelope({ ...envelope(), sessionId: '../x' }, { isValidSessionId: okId }), null);
  assert.equal(parseTurnEnvelope({ ...envelope(), userMessage: { id: 'u', content: 'x', timestamp: 'not a time' } }, { isValidSessionId: okId }), null);
  const self = envelope();
  assert.equal(parseTurnEnvelope({ ...self, prevTurnId: self.turnId }, { isValidSessionId: okId }).prevTurnId, null, 'a turn is never its own previous turn');
  assert.equal(parseTurnEnvelope(null, { isValidSessionId: okId }), null);
});

test('the log writer adds by timestamp, replaces by id, removes, and leaves the rest alone', async () => {
  const logsDir = tempLogs();
  const legacy = { role: 'user', content: 'an old line with no id' };
  await appendSessionMessages('s-1', [{ id: 'b', role: 'assistant', content: 'B', timestamp: '2026-10-28T10:00:02Z' }], { logsDir, defaults: { location: { platform: 'web' } } });
  const file = path.join(logsDir, 's-1.json');
  const log = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(log.location, { platform: 'web' });
  writeFileSync(file, JSON.stringify({ ...log, messages: [legacy, ...log.messages] }));
  await appendSessionMessages('s-1', [{ id: 'a', role: 'user', content: 'A', timestamp: '2026-10-28T10:00:01Z' }], { logsDir });
  await appendSessionMessages('s-1', [{ id: 'b', role: 'assistant', content: 'B, whole', timestamp: '2026-10-28T10:00:02Z' }], { logsDir });
  await appendSessionMessages('s-1', [{ id: 'c', role: 'assistant', content: 'C', timestamp: '2026-10-28T10:00:03Z' }], { logsDir, remove: ['b'] });
  const msgs = await readSessionMessages('s-1', { logsDir });
  assert.deepEqual(msgs.map(m => m.id ?? 'legacy'), ['legacy', 'a', 'c'], 'legacy line kept, A placed by time, B removed');
  writeFileSync(path.join(logsDir, 's-bad.json'), '{ not json');
  const r = await appendSessionMessages('s-bad', [{ id: 'x', role: 'user', content: 'x' }], { logsDir });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(path.join(logsDir, 's-bad.json'), 'utf8'), '{ not json', 'an unreadable log is never overwritten');
  await appendSessionMessages('s-none', [], { logsDir, remove: ['x'] });
  assert.equal(existsSync(path.join(logsDir, 's-none.json')), false, 'removing from no log creates nothing');
});

test('PIPELINE: a turn cut off after two rounds keeps my human\'s message, both rounds and a plain note', async () => {
  const logsDir = tempLogs();
  const env = parseTurnEnvelope(envelope(), { isValidSessionId: okId });
  const { rec } = await openTurn(env, { logsDir, log: () => {} });
  await rec.begin();
  await rec.round(round(0, 'save_memory'));
  await rec.round(round(1, 'update_identity'));
  rec.setPartial('');
  await rec.settle();   // the request ended without finish(): the browser left
  const stored = await readSessionMessages(env.sessionId, { logsDir });
  assert.deepEqual(stored.map(m => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'system']);
  const note = stored.at(-1);
  assert.ok(isAppNote(note));
  assert.equal(note.content, cutOffNoteText(true));
  assert.equal(note.toolsRan, true);
  assert.equal(turnRanTools(stored, env.turnId), true);
  // The next turn's line, read from that record:
  const line = lastTurnRecord([...stored, { role: 'user' }]);
  assert.match(line, /tools used: save_memory \(ok\), update_identity \(ok\)\./);
  assert.match(line, /It was cut off before I finished answering\./);
  assert.ok(!isReadableMessage(note), 'memorization skips the note');
});

test('PIPELINE: a turn whose tools ran is never run again — a retry gets its record back', async () => {
  const logsDir = tempLogs();
  const env = parseTurnEnvelope(envelope(), { isValidSessionId: okId });
  const first = await openTurn(env, { logsDir, log: () => {} });
  await first.rec.begin();
  await first.rec.round(round(0, 'remove_from_identity'));
  await first.rec.settle();
  const again = await openTurn({ ...env, retry: true }, { logsDir, log: () => {} });
  assert.ok(again.refusal?._turnAlreadyRan, 'refused');
  assert.ok(!again.rec, 'nothing to run');
  assert.deepEqual(again.refusal._turnAlreadyRan.messages.map(m => m.role), ['user', 'assistant', 'tool', 'system']);
  const sameProcess = await openTurn(env, { logsDir, log: () => {} });
  assert.ok(sameProcess.refusal?._turnAlreadyRan, 'caught without reading the log, too');
});

test('PIPELINE: only a retry reads the log, so a restart still catches a repeat of a turn that ran tools', async () => {
  const logsDir = tempLogs();
  const env = parseTurnEnvelope(envelope(), { isValidSessionId: okId });
  // As if written before a restart: the log has the round, this process never saw it.
  await appendSessionMessages(env.sessionId, [env.userMessage, ...toolRoundMessages({ turnId: env.turnId, round: 0, ...round(0, 'save_memory'), timestamp: '2026-10-28T10:00:01Z' })], { logsDir });
  assert.ok((await openTurn({ ...env, retry: true }, { logsDir, log: () => {} })).refusal);
});

test('PIPELINE: the next turn gets the one that broke off (prevTurnId)', async () => {
  const logsDir = tempLogs();
  const a = parseTurnEnvelope(envelope(), { isValidSessionId: okId });
  const { rec } = await openTurn(a, { logsDir, log: () => {} });
  await rec.begin();
  await rec.round(round(0, 'relay_message'));
  const settling = rec.settle();   // still finishing when the next turn arrives
  const b = parseTurnEnvelope(envelope({ prevTurnId: a.turnId }), { isValidSessionId: okId });
  const opened = await openTurn(b, { logsDir, log: () => {} });
  await settling;
  assert.equal(opened.priorTurn.turnId, a.turnId);
  assert.deepEqual(opened.priorTurn.messages.map(m => m.role), ['user', 'assistant', 'tool', 'system']);
  const line = lastTurnRecord([{ role: 'user' }, ...opened.priorTurn.messages, { role: 'user' }]);
  assert.match(line, /relay_message/);
  assert.match(line, /cut off/);
  await opened.rec.settle();
});

test('PIPELINE: words that streamed and stopped, with no tools, can be tried again; finishing replaces them', async () => {
  const logsDir = tempLogs();
  const env = parseTurnEnvelope(envelope(), { isValidSessionId: okId });
  const one = await openTurn(env, { logsDir, log: () => {} });
  await one.rec.begin();
  one.rec.setPartial('Let me think about');
  await one.rec.settle();
  let stored = await readSessionMessages(env.sessionId, { logsDir });
  assert.equal(stored.find(m => m.id === env.replyMessageId)?.cutOff, true);
  assert.equal(stored.at(-1).toolsRan, false);
  assert.equal(stored.at(-1).content, cutOffNoteText(false));
  const two = await openTurn({ ...env, retry: true }, { logsDir, log: () => {} });
  assert.ok(two.rec, 'no tools ran, so it may run again');
  await two.rec.begin();
  await two.rec.finish('Let me think about it: yes.');
  await two.rec.settle();
  stored = await readSessionMessages(env.sessionId, { logsDir });
  assert.deepEqual(stored.map(m => m.role), ['user', 'assistant']);
  assert.equal(stored[1].content, 'Let me think about it: yes.');
  assert.equal(stored[1].cutOff, undefined);
});

test('a finished turn has no note, and one where nothing ran or was said stays just my human\'s message', async () => {
  const logsDir = tempLogs();
  const done = parseTurnEnvelope(envelope(), { isValidSessionId: okId });
  const a = await openTurn(done, { logsDir, log: () => {} });
  await a.rec.begin(); await a.rec.round(round(0, 'recall')); await a.rec.finish('Found it.'); await a.rec.settle();
  assert.deepEqual((await readSessionMessages(done.sessionId, { logsDir })).map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(a.rec.messages().at(-1).id, done.replyMessageId);
  const quiet = parseTurnEnvelope(envelope({ sessionId: 's-20261028-quiet' }), { isValidSessionId: okId });
  const b = await openTurn(quiet, { logsDir, log: () => {} });
  await b.rec.begin(); await b.rec.settle();
  assert.deepEqual((await readSessionMessages(quiet.sessionId, { logsDir })).map(m => m.role), ['user']);
  assert.equal(unansweredTurnId(await readSessionMessages(quiet.sessionId, { logsDir })), quiet.turnId);
});

test('a second send of a turn still running is turned away, not run beside it', async () => {
  const logsDir = tempLogs();
  const env = parseTurnEnvelope(envelope(), { isValidSessionId: okId });
  const running = await openTurn(env, { logsDir, log: () => {} });
  await running.rec.begin();
  const second = await openTurn({ ...env, retry: true }, { logsDir, settleMs: 30, log: () => {} });
  assert.ok(second.refusal?._turnStillRunning);
  await running.rec.settle();
  assert.equal(await awaitTurnSettled(env.turnId, 10), true);
});

test('a voice call\'s log gets its room\'s tag from the first line; a web chat log gets none', async () => {
  const logsDir = tempLogs();
  const voice = parseTurnEnvelope(envelope({ sessionId: 's-20261028-voic', location: { platform: 'voice', label: 'Voice call' } }), { isValidSessionId: okId });
  const v = await openTurn(voice, { logsDir, log: () => {} });
  v.rec.meta.audienceTag = 'friends';
  await v.rec.begin(); await v.rec.settle();
  assert.equal(JSON.parse(readFileSync(path.join(logsDir, `${voice.sessionId}.json`), 'utf8')).audienceTag, 'friends');
  const web = parseTurnEnvelope(envelope({ sessionId: 's-20261028-webb' }), { isValidSessionId: okId });
  const w = await openTurn(web, { logsDir, log: () => {} });
  w.rec.meta.audienceTag = 'friends';
  await w.rec.begin(); await w.rec.settle();
  assert.equal(JSON.parse(readFileSync(path.join(logsDir, `${web.sessionId}.json`), 'utf8')).audienceTag, undefined,
    'a shared web chat\'s circle is the ward\'s decision (fix plan C2), not this one\'s');
});

test('a failing log write never breaks the turn', async () => {
  const env = parseTurnEnvelope(envelope(), { isValidSessionId: okId });
  const rec = createTurnRecorder({ envelope: env, write: async () => { throw new Error('disk full'); }, log: () => {} });
  await rec.begin();
  const msgs = await rec.round(round(0, 'save_memory'));
  assert.equal(msgs.length, 2);
  await rec.settle();
});

// ── What history shows ──────────────────────────────────────────────

const HISTORY = [
  { role: 'user', content: 'look it up' },
  { role: 'assistant', content: null, tool_calls: [CALL('c1', 'recall')] },
  { role: 'tool', tool_call_id: 'c1', content: 'the secret thing my human told me' },
  { role: 'assistant', content: 'Found it.' },
  { role: 'user', content: 'and now?' },
];

test('in a shared room a record and the last-turn line name the calls, never what came back', () => {
  const shared = collapseToolTurns(HISTORY, { records: true, recordResults: false });
  assert.match(shared.find(m => m.role === 'system').content, /I called recall\.\]$/);
  assert.ok(!JSON.stringify(shared).includes('secret'));
  assert.equal(lastTurnRecord(HISTORY, { results: false }), '[Last turn, tools used: recall.]');
  assert.match(lastTurnRecord(HISTORY), /recall \(returned: the secret thing/, 'my human\'s own room keeps them');
});

test('Discord: the last-turn line reads a history that already ends with this turn\'s message', () => {
  // HISTORY ends with this turn's message, as session.messages does once it's
  // saved before the model call. The anchor used to add a placeholder for that
  // message too, which left no previous turn to find, so the line never showed.
  assert.match(discordLastTurnLine({ messages: HISTORY }, 'ward-private'), /tools used: recall \(returned:/);
  assert.equal(discordLastTurnLine({ messages: HISTORY }, 'friends'), '[Last turn, tools used: recall.]');
});

test('Discord: stored rounds reach history as records, notes ride along, and the limit counts conversation', () => {
  const messages = [];
  for (let i = 0; i < 30; i++) {
    messages.push({ id: `u${i}`, role: 'user', content: `line ${i}`, timestamp: '2026-10-28T10:00:00Z' });
    messages.push(...toolRoundMessages({ turnId: `t${i}`, round: 0, ...round(0, 'recall'), timestamp: '2026-10-28T10:00:01Z' }));
    messages.push({ id: `a${i}`, role: 'assistant', content: `reply ${i}`, timestamp: '2026-10-28T10:00:02Z' });
  }
  messages.push({ id: 'n', role: 'system', kind: 'app-note', noteType: 'cut-off', content: cutOffNoteText(true), timestamp: '2026-10-28T10:00:03Z' });
  const ward = buildHistoryForPrompt({ messages, audienceTag: 'ward-private' });
  const shared = buildHistoryForPrompt({ messages, audienceTag: 'friends' });
  const lines = (h) => h.filter(m => m.role !== 'system').length;
  assert.equal(lines(ward), lines(shared), 'records don\'t eat into the window');
  assert.ok(ward.some(m => m.role === 'system' && /recall \(ok\)/.test(m.content)));
  assert.ok(shared.some(m => m.role === 'system' && /I called recall\.\]/.test(m.content)));
  assert.equal(ward.at(-1).content, cutOffNoteText(true));
});

test('history as a request takes: tool fields and speaker kept, log fields left behind', () => {
  const api = toApiHistory([
    { id: 'u', role: 'user', content: 'hi', speaker: 'Sam', turnId: 't', timestamp: 'x' },
    ...toolRoundMessages({ turnId: 't', round: 0, ...round(0, 'recall'), timestamp: 'x' }),
    { id: 'n', role: 'system', kind: 'app-note', content: cutOffNoteText(true), turnId: 't' },
  ]);
  assert.deepEqual(api[0], { role: 'user', content: 'hi', speaker: 'Sam' });
  assert.deepEqual(api[2], { role: 'tool', tool_call_id: 'c0', content: 'ok' });
  assert.deepEqual(api[3], { role: 'system', content: cutOffNoteText(true) });
});

test('turnMessagesOf reads one turn, in log order', () => {
  const stored = [
    { id: 'u1', role: 'user', turnId: 'a' }, { id: 'x', role: 'user', turnId: 'b' }, { id: 'r1', role: 'assistant', turnId: 'a' },
  ];
  assert.deepEqual(turnMessagesOf(stored, 'a').map(m => m.id), ['u1', 'r1']);
});

// ── Voice ───────────────────────────────────────────────────────────

test('voice keeps exactly what the server stored, tool rounds included; my human\'s line stays attributed', () => {
  const record = {
    messages: [
      { id: 'u', role: 'user', content: 'heard', turnId: 't' },
      ...toolRoundMessages({ turnId: 't', round: 0, ...round(0, 'relay_message'), timestamp: 'x' }),
      { id: 'r', role: 'assistant', content: 'Sent.', turnId: 't' },
    ],
    prior: null,
  };
  const { history, stored } = keepCallTurn({ hist: [], transcript: 'heard', historyText: '[Sam]: heard', reply: 'Sent.', record });
  assert.deepEqual(stored.map(m => m.id), ['u', 't-r0', 't-r0-0', 'r']);
  assert.deepEqual(history.map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(history[0].content, '[Sam]: heard');
  assert.match(lastTurnRecord([...history, { role: 'user', content: 'next' }]), /relay_message/);
  const plain = keepCallTurn({ hist: [], transcript: 'hi', reply: 'Hey.', record: null });
  assert.deepEqual(plain.history, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hey.' }]);
});

test('voice sends the turn, marks a retry, and never retries a turn whose tools already ran', async () => {
  const bodies = [];
  const handed = [];
  const run = createVoiceChatTurn({
    port: 1, readSettings: () => ({}), connectionForFeature: () => ({ provider: 'openai', apiKey: 'k', model: 'm' }),
    fetchFn: async (_u, opts) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      if (bodies.length === 1) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }) };
      return { ok: false, status: 409, headers: { get: () => null }, json: async () => ({ _turnAlreadyRan: { turnId: body.turn.turnId, messages: [{ id: 'x', role: 'tool' }] } }) };
    },
  });
  const turn = { sessionId: 's', turnId: 't', replyMessageId: 'r', userMessage: { id: 'u', content: 'hi', timestamp: '2026-10-28T10:00:00Z' } };
  const reply = await run({ transcript: 'hi', turn, onRecord: (r) => handed.push(r) });
  assert.equal(reply, null);
  assert.equal(bodies.length, 2, 'one retry of the empty reply, then no more');
  assert.equal(bodies[0].turn.retry, undefined);
  assert.equal(bodies[1].turn.retry, true);
  assert.equal(handed.at(-1).alreadyRan, true);
});

// ── The browser's halves (public/app.js, a classic script) ──────────

const appSrc = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const classSource = (name) => {
  const start = appSrc.indexOf(`class ${name}`);
  let depth = 0;
  for (let i = appSrc.indexOf('{', start); i < appSrc.length; i++) {
    if (appSrc[i] === '{') depth++;
    else if (appSrc[i] === '}' && --depth === 0) return appSrc.slice(start, i + 1);
  }
  throw new Error(`class ${name} not found`);
};
const browser = (names, ctx = {}) => {
  runInNewContext(`${classSource('TurnSettledError')}\n${names.map(nm => extractFunctionSource(appSrc, nm)).join('\n')}\n`
    + `out = { ${names.join(', ')}, TurnSettledError };`, ctx);
  return ctx.out;
};

test('browser: the page splices a turn in after its own message, once, and asks the right questions', () => {
  const ctx = { state: { messages: [
    { id: 'u1', role: 'user', turnId: 't1' },
    { id: 'u2', role: 'user', turnId: 't2' },
  ] } };
  const b = browser(['spliceTurnMessages', 'commitTurnMessages', 'unansweredTurnIdIn', 'turnField', 'turnRefusalFrom', 'isToolPlumbing'], ctx);
  const record = [{ id: 'u1', role: 'user', turnId: 't1' }, { id: 'c', role: 'assistant', tool_calls: [{}], turnId: 't1' }, { id: 'n', role: 'system', kind: 'app-note', turnId: 't1' }];
  assert.equal(b.spliceTurnMessages('t1', record), 2);
  assert.deepEqual(ctx.state.messages.map(m => m.id), ['u1', 'c', 'n', 'u2'], 'in place, before the next message');
  assert.equal(b.spliceTurnMessages('t1', record), 0, 'never twice');
  assert.equal(b.unansweredTurnIdIn(ctx.state.messages), 't2');
  b.commitTurnMessages([{ id: 'r2', role: 'assistant', content: 'a', turnId: 't2' }, { id: 'r2', role: 'assistant', content: 'b', turnId: 't2' }]);
  assert.equal(ctx.state.messages.filter(m => m.id === 'r2').length, 1, 'committed by id, never doubled');
  assert.equal(b.unansweredTurnIdIn(ctx.state.messages), null);
  assert.equal(b.turnField({ turnId: 't' }, { attempt: 0, connIdx: 0 }).turn.retry, undefined);
  assert.equal(b.turnField({ turnId: 't' }, { attempt: 1, connIdx: 0 }).turn.retry, true);
  assert.equal(b.turnField({ turnId: 't' }, { attempt: 0, connIdx: 1 }).turn.retry, true, 'a fallback connection is a second send too');
  const refusal = b.turnRefusalFrom(409, { _turnAlreadyRan: { messages: [{ id: 'x' }] } });
  assert.equal(refusal.name, 'TurnSettledError');
  assert.equal(refusal.messages.length, 1);
  assert.equal(b.turnRefusalFrom(409, { _turnStillRunning: {} }).stillRunning, true);
  assert.equal(b.turnRefusalFrom(500, { _turnAlreadyRan: {} }), null);
  assert.equal(b.isToolPlumbing({ role: 'system', kind: 'app-note' }), true, 'summaries, exports and memorize skip notes');
});

test('browser: an app note goes to the model as the plain fact, unstamped', () => {
  const ctx = { stampContent: (c, ts) => `⫸10:00⫷ ${c}` };
  runInNewContext(`${extractFunctionSource(appSrc, 'toApiMessage')}\nout = toApiMessage;`, ctx);
  const note = { role: 'system', kind: 'app-note', content: cutOffNoteText(true), timestamp: 'x' };
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.out(note))), { role: 'system', content: cutOffNoteText(true) });
  // A note only follows tools that ran (or words that streamed), so a carrier is there too.
  const carrier = { role: 'assistant', content: null, tool_calls: [CALL('c1', 'recall')] };
  assert.match(lastTurnRecord([{ role: 'user' }, carrier, ctx.out(note), { role: 'user' }]), /cut off/, 'the line still finds it');
});
