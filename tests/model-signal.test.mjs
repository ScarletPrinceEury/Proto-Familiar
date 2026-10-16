// Which model I'm running on, and whether it changed (0.14.85).
//
// From the self-rule inventory: "I cannot verify my own engine from inside" and
// "after a context crash or model swap, I check memory before speaking" — the
// app knows both facts and never said them. Now the [Now] block does, in code.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { formatModelLine, modelSignal, __resetModelSignalForTest } = await import('../src/diagnostics/model-signal.js');
const { buildTimeAnchorBlock } = await import('../relative-time.js');

beforeEach(() => __resetModelSignalForTest({}));

test('the line names the model, and says when it changed or the conversation is new', () => {
  assert.equal(formatModelLine({ model: 'model-a' }), "I'm running on model-a.");
  assert.equal(formatModelLine({ model: 'model-b', previousModel: 'model-a' }),
    "I'm running on model-b. That changed since my last turn here, which ran on model-a.");
  assert.equal(formatModelLine({ model: 'model-a', previousModel: 'model-a' }), "I'm running on model-a.");
  assert.equal(formatModelLine({ model: 'model-a', firstTurn: true }),
    "I'm running on model-a. This is the first turn of a new conversation.");
  assert.equal(formatModelLine({ model: '' }), '', 'an unknown model says nothing rather than guess');
});

test('across turns of one conversation, only a real change is called out', async () => {
  assert.equal(await modelSignal({ sessionKey: 's1', model: 'model-a', firstTurn: true }),
    "I'm running on model-a. This is the first turn of a new conversation.");
  assert.equal(await modelSignal({ sessionKey: 's1', model: 'model-a' }), "I'm running on model-a.");
  assert.match(await modelSignal({ sessionKey: 's1', model: 'model-b' }), /changed since my last turn here, which ran on model-a\./);
  assert.equal(await modelSignal({ sessionKey: 's1', model: 'model-b' }), "I'm running on model-b.", 'said once, then settled');
  assert.equal(await modelSignal({ sessionKey: 's2', model: 'model-a' }), "I'm running on model-a.", 'another conversation keeps its own record');
});

test('the [Now] block carries the line beside the clock', () => {
  const block = buildTimeAnchorBlock({ now: Date.parse('2026-10-16T09:00:00Z'), timeZone: 'UTC', selfLine: "I'm running on model-a." });
  assert.match(block, /^\[Now\]\nNow: .*\nI'm running on model-a\.$/);
  assert.doesNotMatch(buildTimeAnchorBlock({ now: Date.now() }), /running on/, 'no line when the caller has none');
});
