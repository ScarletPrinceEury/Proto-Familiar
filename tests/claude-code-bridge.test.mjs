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

const CONN = { provider: 'openai', apiKey: 'test-key', model: 'model-a', baseUrl: null, reasoningEffort: 'high' };
let sent, replyFor, dir, settings;

const make = () => createClaudeCodeBridge({
  port: 1, readSettings: () => settings, connectionForFeature: () => CONN,
  logsDir: path.join(dir, 'logs'), stateFile: path.join(dir, 'bridge.json'), log: () => {},
  fetchFn: async (_url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push(body);
    return { ok: true, status: 200, json: async () => replyFor(body) };
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
  assert.deepEqual(out, { ok: true, reply: 'Hi, Claude Code.', toolsUsed: [], sessionId: out.sessionId });
  const b = sent[0];
  assert.equal(b.speaker, BRIDGE_SPEAKER);
  assert.deepEqual(b.messages.at(-1), { role: 'user', content: 'hello there', speaker: BRIDGE_SPEAKER });
  assert.equal(b.injectCorePrompts, true);
  assert.equal(b.sessionAudience, 'ward-private');
  assert.equal(b.runToolLoop, true);
  assert.equal(b.reasoningEffort, 'high', "the connection's own effort");
  assert.equal(b.sessionInfo.sessionId, out.sessionId);
  assert.ok(b.max_tokens >= 4000, 'RULE A');
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
  assert.match(out.error, /no reply came back/);
});
