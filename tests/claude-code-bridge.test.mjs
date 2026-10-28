// The Claude Code bridge (0.14.88, ward decision).
//
// Claude Code used to reach the Familiar by driving the web chat in the ward's
// seat: the Familiar answered the ward, and Claude Code's words counted as the
// ward's. The bridge is its own conversation where every message is Claude Code's
// by construction. These run the bridge against a stubbed /api/chat and a temp
// log folder: what it sends, what it stores, and that it stays off unless the
// ward has "Claude Code" on their list.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const { createClaudeCodeBridge, BRIDGE_SPEAKER, BRIDGE_LOCATION } = await import('../src/bridge/claude-code-bridge.js');
const { parseTurnEnvelope, toolRoundMessages, replyMessage } = await import('../src/sessions/turn-record.js');

const CONN = { provider: 'openai', apiKey: 'test-key', model: 'model-a', baseUrl: null, reasoningEffort: 'high' };
let sent, replyFor, dir, settings;

// The real /api/chat records the turn as it goes (turn-record.js) and sends back
// what it stored; this stub does the same from the envelope the bridge sent.
const recordOf = (body, data) => {
  const t = parseTurnEnvelope(body.turn, { isValidSessionId: (id) => typeof id === 'string' && id.length > 0 });
  if (!t) return data;
  const at = t.userMessage.timestamp;
  const messages = [t.userMessage];
  (data._toolRounds ?? []).forEach((r, round) => messages.push(...toolRoundMessages({ turnId: t.turnId, round, ...r, timestamp: at })));
  const reply = data.choices?.[0]?.message?.content;
  if (reply) messages.push(replyMessage({ id: t.replyMessageId, turnId: t.turnId, content: reply, timestamp: at }));
  return { ...data, _turnRecord: { turnId: t.turnId, messages } };
};

const make = () => createClaudeCodeBridge({
  port: 1, readSettings: () => settings, connectionForFeature: () => CONN,
  logsDir: path.join(dir, 'logs'), stateFile: path.join(dir, 'bridge.json'), log: () => {},
  fetchFn: async (_url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push(body);
    return { ok: true, status: 200, json: async () => recordOf(body, replyFor(body)) };
  },
});

beforeEach(() => {
  sent = [];
  dir = mkdtempSync(path.join(tmpdir(), 'bridge-'));
  settings = { userName: 'Robin', webSpeakers: ['Claude Code'] };
  replyFor = () => ({ choices: [{ finish_reason: 'stop', message: { content: 'Hi, Claude Code.' } }] });
});

const theLog = () => {
  const files = readdirSync(path.join(dir, 'logs'));
  assert.equal(files.length, 1);
  return JSON.parse(readFileSync(path.join(dir, 'logs', files[0]), 'utf8'));
};

test('off unless "Claude Code" is on the ward\'s list; nothing is sent', async () => {
  settings = { userName: 'Robin', webSpeakers: [] };
  const out = await make().send({ message: 'hello' });
  assert.equal(out.ok, false);
  assert.match(out.error, /isn't on the list of others who may type/);
  assert.equal(sent.length, 0);
});

test('every turn is Claude Code\'s: speaker on the turn and the message, ward-private, core prompts in', async () => {
  const out = await make().send({ message: 'hello there' });
  assert.deepEqual(out, { ok: true, reply: 'Hi, Claude Code.', toolsUsed: [], sessionId: out.sessionId, notes: [], usage: null });
  const b = sent[0];
  assert.equal(b.speaker, BRIDGE_SPEAKER);
  assert.deepEqual(b.messages.at(-1), { role: 'user', content: 'hello there', speaker: BRIDGE_SPEAKER });
  assert.equal(b.injectCorePrompts, true);
  assert.equal(b.sessionAudience, 'ward-private');
  assert.equal(b.runToolLoop, true);
  assert.equal(b.reasoningEffort, 'high', "the connection's own effort");
  assert.equal(b.sessionInfo.sessionId, out.sessionId);
  assert.ok(b.max_tokens >= 4000, 'RULE A');
  // The turn envelope (turn-record.js): the server records the turn from it.
  const t = parseTurnEnvelope(b.turn, { isValidSessionId: () => true });
  assert.ok(t, 'a valid envelope');
  assert.equal(t.sessionId, out.sessionId);
  assert.equal(t.userMessage.speaker, BRIDGE_SPEAKER);
  assert.equal(t.userMessage.content, 'hello there');
});

test('a turn that broke off is asked about by the next one (prevTurnId)', async () => {
  const bridge = make();
  replyFor = () => ({ choices: [{ finish_reason: 'stop', message: { content: '' } }] });
  await bridge.send({ message: 'first' });   // no reply: my message alone is stored
  replyFor = () => ({ choices: [{ finish_reason: 'stop', message: { content: 'Here now.' } }] });
  await bridge.send({ message: 'second' });
  assert.equal(sent[1].turn.prevTurnId, sent[0].turn.turnId);
  await bridge.send({ message: 'third' });
  assert.equal(sent[2].turn.prevTurnId, undefined, 'an answered turn needs no asking');
});

test('the conversation is an ordinary session log, tool rounds and all, and it carries on', async () => {
  replyFor = () => ({
    choices: [{ finish_reason: 'stop', message: { content: 'Saved it.' } }],
    _toolRounds: [{ toolCalls: [{ id: 't1', type: 'function', function: { name: 'save_memory', arguments: '{}' } }],
                    results: [{ tool_call_id: 't1', name: 'save_memory', content: 'ok' }], content: null }],
  });
  const bridge = make();
  const first = await bridge.send({ message: 'remember this' });
  assert.deepEqual(first.toolsUsed, ['save_memory']);
  const log = theLog();
  assert.deepEqual(log.location, BRIDGE_LOCATION);
  assert.deepEqual(log.messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(log.messages[0].speaker, BRIDGE_SPEAKER);
  assert.equal(log.messages[1].tool_calls[0].function.name, 'save_memory');

  replyFor = () => ({ choices: [{ finish_reason: 'stop', message: { content: 'Still here.' } }] });
  const second = await bridge.send({ message: 'and again' });
  assert.equal(second.sessionId, first.sessionId, 'the same conversation');
  assert.deepEqual(sent[1].messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant', 'user'],
    'history goes along, tool rounds included');
  assert.equal(sent[1].messages[0].speaker, BRIDGE_SPEAKER);
  assert.equal(theLog().messages.length, 6);

  const fresh = await bridge.send({ message: 'new topic', newConversation: true });
  assert.notEqual(fresh.sessionId, first.sessionId);
  assert.equal(sent[2].messages.length, 1, 'a new conversation starts empty');
});

test('an empty reply comes back as not ok, never as silence', async () => {
  replyFor = () => ({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'thinking…' } }] });
  const out = await make().send({ message: 'hm' });
  assert.equal(out.ok, false);
  assert.match(out.error, /used its whole budget \(8000 tokens\) thinking and wrote no reply \(finish: length\)/, 'a budget-exhausted turn says what ran out (0.14.96)');
  replyFor = () => ({ choices: [{ finish_reason: 'stop', message: { content: '' } }] });
  const other = await make().send({ message: 'hm' });
  assert.match(other.error, /no reply came back/);
});
