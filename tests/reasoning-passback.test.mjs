import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runToolCallLoop } from '../cerebellum.js';
import { reasoningOf, assistantToolTurn } from '../llm-call.js';

// A thinking model's reasoning has to go back to it on every later round of a
// tool turn. DeepSeek's docs require it whenever tools are offered (their API
// returns 400 without it); NanoGPT tolerates the omission silently, so the model
// ran without the thinking behind its own tool calls. These run the real loop
// with a stubbed provider and read what the NEXT round was actually sent.

function toolRound({ reasoningField, reasoning, content = null }) {
  return {
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant', content,
        ...(reasoningField ? { [reasoningField]: reasoning } : {}),
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_tome', arguments: '{}' } }],
      },
    }],
  };
}
const done = { choices: [{ finish_reason: 'stop', message: { content: 'filed' } }] };

async function secondRoundAssistant(firstResponse) {
  const sent = []; let n = 0; const rounds = [];
  await runToolCallLoop({
    callUpstream: async (msgs) => { sent.push(msgs); return n++ === 0 ? firstResponse : done; },
    baseMessages: [{ role: 'user', content: 'revise §1 and save it' }],
    executeTool: async () => 'the FINAL §1 text',
    onRound: (r) => rounds.push(r),
  });
  return { assistant: sent[1].find(m => m.role === 'assistant' && m.tool_calls), rounds };
}

test('NanoGPT shape: reasoning in `reasoning` goes back as reasoning_content', async () => {
  const { assistant } = await secondRoundAssistant(toolRound({ reasoningField: 'reasoning', reasoning: 'plan: read §1, rewrite the opening, save' }));
  assert.equal(assistant.reasoning_content, 'plan: read §1, rewrite the opening, save');
  assert.equal(assistant.tool_calls[0].id, 'call-1');
});

test('z.ai / DeepSeek shape: reasoning_content goes back unchanged', async () => {
  const { assistant } = await secondRoundAssistant(toolRound({ reasoningField: 'reasoning_content', reasoning: 'I need the text first' }));
  assert.equal(assistant.reasoning_content, 'I need the text first');
});

test('no reasoning sent: the message shape is exactly as before', async () => {
  const { assistant } = await secondRoundAssistant(toolRound({}));
  assert.deepEqual(Object.keys(assistant).sort(), ['content', 'role', 'tool_calls']);
});

test('the turn log counts NanoGPT reasoning (it read only reasoning_content and logged 0)', async () => {
  const { rounds } = await secondRoundAssistant(toolRound({ reasoningField: 'reasoning', reasoning: 'twelve chars' }));
  assert.equal(rounds[0].reasoningChars, 'twelve chars'.length);
});

test('a claim-check retry round keeps the reasoning too', async () => {
  const sent = []; let n = 0;
  const claims = { choices: [{ finish_reason: 'stop', message: { content: 'All three fixed and re-filed.', reasoning: 'I should save it' } }] };
  await runToolCallLoop({
    callUpstream: async (msgs) => { sent.push(msgs); return n++ === 0 ? claims : done; },
    baseMessages: [{ role: 'user', content: 'revise §1 and save it' }],
    executeTool: async () => 'ok',
    rosterTools: [{ type: 'function', function: { name: 'save_to_tome', parameters: { type: 'object', properties: {} } } }],
  });
  const retried = sent[1]?.find(m => m.role === 'assistant');
  assert.ok(retried, 'the claim check asked for one more round');
  assert.equal(retried.reasoning_content, 'I should save it');
});

test('reasoningOf / assistantToolTurn', () => {
  assert.equal(reasoningOf({ reasoning: 'a' }), 'a');
  assert.equal(reasoningOf({ reasoning_content: 'b', reasoning: 'a' }), 'b');
  assert.equal(reasoningOf(undefined), '');
  assert.deepEqual(assistantToolTurn({ content: '', toolCalls: [] , reasoning: '' }), { role: 'assistant', content: null, tool_calls: [] });
});
