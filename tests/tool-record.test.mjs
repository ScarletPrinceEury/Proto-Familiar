// App-written records of real tool runs in history + the "last turn" line (0.14.76).
//
// collapseToolTurns drops tool calls and results before history reaches the
// model (they confused it as null/half-sentence turns). Side effect, found in the
// first identity review: every past action survived only as the Familiar's own
// sentence claiming it, so history taught "writing 'ran — ok' is an action", and
// the turn log showed whole turns of claimed results with zero calls. Now each
// turn that really ran tools keeps a short system record built from the stored
// calls and results, and the current turn's anchor says what the previous turn
// actually ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { collapseToolTurns, lastTurnRecord, isToolRecord, TOOL_RECORD_PREFIX } = await import('../message-sanitize.mjs');
const { buildHistoryForPrompt } = await import('../src/discord/discord-gateway.js');

const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });
const HISTORY = [
  { role: 'user', content: 'file it' },
  { role: 'assistant', content: null, tool_calls: [call('a', 'save_memory'), call('b', 'remove_from_identity')] },
  { role: 'tool', tool_call_id: 'a', content: 'ok' },
  { role: 'tool', tool_call_id: 'b', content: "Nothing removed: that passage isn't in ward/user_notes.md; it has to be quoted as the file has it." },
  { role: 'assistant', content: 'Saved it; the cut missed.' },
  { role: 'user', content: 'and the other one?' },
  { role: 'assistant', content: 'Ran — ok, both filed.' },   // narration only, no call
  { role: 'user', content: 'really?' },
];

test('a turn that really ran tools keeps an app record after it, results included', () => {
  const out = collapseToolTurns(HISTORY, { records: true });
  const i = out.findIndex(m => m.role === 'assistant' && m.content === 'Saved it; the cut missed.');
  assert.ok(i >= 0);
  assert.equal(out[i + 1].role, 'system');
  assert.ok(isToolRecord(out[i + 1]));
  assert.match(out[i + 1].content, /I called save_memory \(ok\), remove_from_identity \(returned: Nothing removed: that passage isn't in ward\/user_notes\.md…\)\.\]$/,
    'a long result is cut at a whole word, with a marker');
  assert.ok(!out.some(m => m.role === 'tool' || m.tool_calls), 'calls and results still never re-enter history');
});

test('a turn that only narrated gets no record', () => {
  const out = collapseToolTurns(HISTORY, { records: true });
  const i = out.findIndex(m => m.content === 'Ran — ok, both filed.');
  assert.notEqual(out[i + 1]?.role, 'system');
  assert.equal(out.filter(isToolRecord).length, 1);
});

test('without records the collapse is unchanged (memorization and other callers)', () => {
  assert.equal(collapseToolTurns(HISTORY).filter(m => m.role === 'system').length, 0);
});

test('the last-turn line says what the previous turn actually ran', () => {
  assert.equal(lastTurnRecord(HISTORY), "[Last turn, from the app's record: I made no tool calls.]");
  assert.match(lastTurnRecord(HISTORY.slice(0, 6)), /^\[Last turn, from the app's record: I called save_memory \(ok\), remove_from_identity \(returned: Nothing removed/);
  assert.equal(lastTurnRecord([{ role: 'user', content: 'hi' }]), '', 'no previous turn yet');
});

test('Discord history keeps the records, unstamped, as system messages', () => {
  const session = { messages: HISTORY.slice(0, 5).map(m => ({ ...m, timestamp: '2026-10-15T12:00:00Z' })) };
  const hist = buildHistoryForPrompt(session);
  const rec = hist.find(m => m.role === 'system');
  assert.ok(rec, 'the record survives the user/assistant filter');
  assert.ok(rec.content.startsWith(TOOL_RECORD_PREFIX), 'no timestamp stamped onto it');
});
