// Other people who may type in my human's web chat (0.14.87, ward decision).
//
// Everything typed into the web chat read as my human: a developer's messages
// were answered as my human's, filed as my human's words, scored as my human's
// distress (a message quoting crisis examples could move the tier), and counted
// as my human being around (silence triage skips a check when my human was
// "recently active"). A listed speaker's messages now say who they're from and
// don't count as my human. Fail-closed: only a LISTED name counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { listedSpeakers, speakerOf, labelSpeakers, speakerAnchorLine } = await import('../src/village/web-speakers.js');

const S = { userName: 'Robin', webSpeakers: ['Claude Code', 'claude code', '  ', 'Robin', 'Sam'] };

test('the list is trimmed, deduped, and never my human', () => {
  assert.deepEqual(listedSpeakers(S), ['Claude Code', 'Sam']);
  assert.deepEqual(listedSpeakers({ webSpeakers: 'Claude Code, Sam ,' }), ['Claude Code', 'Sam'], 'a comma string works too');
  assert.deepEqual(listedSpeakers({}), []);
});

test('only a listed name is someone else; anything else is my human (fail-closed)', () => {
  assert.equal(speakerOf({ role: 'user', speaker: 'claude CODE' }, S), 'Claude Code', 'the list spelling, any case');
  assert.equal(speakerOf({ role: 'user', speaker: 'Somebody' }, S), null, 'an unlisted name is my human');
  assert.equal(speakerOf({ role: 'user', speaker: 'Robin' }, S), null, 'my human by name is my human');
  assert.equal(speakerOf({ role: 'user' }, S), null);
  assert.equal(speakerOf({ role: 'assistant', speaker: 'Sam' }, S), null, 'only user turns have a speaker');
  assert.equal(speakerOf({ role: 'user', speaker: 'Claude Code' }, {}), null, 'nothing listed, nobody else');
});

test('the provider sees "[Name]: …" and never the speaker field', () => {
  const out = labelSpeakers([
    { role: 'user', content: 'hello', speaker: 'Claude Code' },
    { role: 'user', content: '[Claude Code]: already labelled', speaker: 'Claude Code' },
    { role: 'user', content: 'from my human' },
    { role: 'user', content: 'unlisted', speaker: 'Somebody' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'look' }], speaker: 'Sam' },
    { role: 'assistant', content: 'hi' },
  ], S);
  assert.deepEqual(out[0], { role: 'user', content: '[Claude Code]: hello' });
  assert.equal(out[1].content, '[Claude Code]: already labelled', 'never labelled twice');
  assert.deepEqual(out[2], { role: 'user', content: 'from my human' });
  assert.deepEqual(out[3], { role: 'user', content: 'unlisted' }, 'unlisted: no label, field dropped');
  assert.equal(out[4].content[1].text, '[Sam]: look');
  assert.ok(out.every(m => !('speaker' in m)), 'the field never reaches the provider');
});

// 0.14.104: the label alone wasn't enough on a live turn. Claude Code wrote on
// the bridge as "[Claude Code]: …" and the Familiar still answered my human by
// name, because nothing else in the turn said someone else was typing.
test('the [Now] line names who is typing when it is a listed speaker, and nothing when it is my human', () => {
  const name = speakerOf({ role: 'user', speaker: 'claude code' }, S);
  assert.equal(speakerAnchorLine(name), '[Who\'s typing: this message is from Claude Code, not my human. Their lines start "[Claude Code]:".]');
  assert.equal(speakerAnchorLine(speakerOf({ role: 'user', speaker: 'Stranger' }, S)), '', 'unlisted = my human, so no line');
  assert.equal(speakerAnchorLine(speakerOf({ role: 'user' }, S)), '');
});
