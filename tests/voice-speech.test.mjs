import { test } from 'node:test';
import assert from 'node:assert/strict';

import { speakableText, splitForSpeech, prepareForSpeech } from '../voice-speech.js';
import { encodeWav, parseWav } from '../voice-audio-features.js';

// ── Markdown that was written to be read, said instead ───────────────────

test('emphasis is heard as words, not as asterisks', () => {
  const { text } = speakableText('That is **really** not _fine_, and ***never*** was.');
  assert.equal(text, 'That is really not fine, and never was.');
});

test('a link says its label and drops the url', () => {
  // A url read aloud is punctuation soup and tells nobody anything.
  const { text } = speakableText('See [the build spec](https://example.com/a/b?c=d#e) for why.');
  assert.equal(text, 'See the build spec for why.');
});

test('inline code keeps its contents — it is usually a name worth hearing', () => {
  const { text } = speakableText('Call `mem_search` first.');
  assert.equal(text, 'Call mem_search first.');
});

test('a code block is summarised, and the summary says so out loud', () => {
  // Reading it character by character is unusable; dropping it silently would
  // mean never knowing it was there.
  const { text, notes } = speakableText('Try this:\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nThat is all.');
  assert.match(text, /js code block, 2 lines/);
  assert.doesNotMatch(text, /const/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /not read out/);
});

test('an unlabelled code block still says how long it was', () => {
  const { text } = speakableText('```\nline one\n```');
  assert.match(text, /code block, 1 line\b/, 'singular, not "1 lines"');
});

test('headings, quotes and rules lose their markers but keep their words', () => {
  const { text } = speakableText('## What happened\n\n> It broke.\n\n---\n\nThen it did not.');
  assert.match(text, /What happened/);
  assert.match(text, /It broke\./);
  assert.doesNotMatch(text, /#|>|---/);
});

test('bullets lose the marker; numbered lists keep their numbers', () => {
  const { text } = speakableText('- first\n- second');
  assert.doesNotMatch(text, /[-*+]\s/);
  const numbered = speakableText('1. first\n2. second').text;
  assert.match(numbered, /1\. first/, 'the number is information, not decoration');
});

test('an image becomes its alt text, because that was the part meant for a person', () => {
  assert.match(speakableText('![a red bicycle](x.png)').text, /image, a red bicycle/);
  assert.match(speakableText('![](x.png)').text, /an image/);
});

test('emoji are dropped rather than spelled out', () => {
  const { text } = speakableText('Good morning 🌞 — ready? 🎉');
  assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}]/u);
  assert.match(text, /Good morning/);
});

test('removing something mid-sentence does not leave an audible hole', () => {
  // Caught by running it, not by a test: stripping the emoji left "the thing ."
  // and a stranded space before a full stop is heard as a pause in the wrong
  // place. What was removed should not be detectable in the speaking.
  assert.equal(speakableText('I did the thing 🎉.').text, 'I did the thing.');
  assert.equal(speakableText('Ready 🚀 ? Yes 👍 !').text, 'Ready? Yes!');
  assert.doesNotMatch(speakableText('One 🌞 , two 🌙 ; three.').text, /\s[,;]/);
});

test('a hallucinated timestamp is never spoken — it would state a time nothing measured', () => {
  // The repo rule: only a machine timestamp is trustworthy. An LLM-emitted one
  // is an artifact, and saying it aloud asserts it.
  assert.equal(speakableText('[14:35] I was thinking...').text, 'I was thinking...');
  assert.equal(speakableText('⫸09:02⫷ Morning.').text, 'Morning.');
});

test('empty or non-string input is empty, not an error', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    const r = speakableText(bad);
    assert.equal(r.text, '');
    assert.deepEqual(r.notes, []);
  }
});

// ── Breaking a message into things to say ────────────────────────────────

test('sentences are split so the next can render while this one plays', () => {
  const chunks = splitForSpeech('This is the first sentence here. And this is the second one now. A third arrives too.');
  assert.equal(chunks.length, 3);
  assert.match(chunks[0], /first sentence here\.$/);
});

test('an abbreviation does not end a sentence', () => {
  const chunks = splitForSpeech('Dr. Ramanujan looked at the numbers for a while, e.g. the ones from Tuesday. Then he stopped.');
  assert.equal(chunks.length, 2, `split wrongly: ${JSON.stringify(chunks)}`);
  assert.match(chunks[0], /^Dr\. Ramanujan/);
});

test('initials do not end a sentence either', () => {
  const chunks = splitForSpeech('It was J. R. R. Tolkien who wrote that one, apparently. Or so they say.');
  assert.equal(chunks.length, 2, `split wrongly: ${JSON.stringify(chunks)}`);
});

test('a very short sentence rides along instead of being spoken alone', () => {
  // "No." on its own is a clipped fragment with an awkward pause either side.
  const chunks = splitForSpeech('No. That is not what happened here, and it matters quite a lot.');
  assert.equal(chunks.length, 1);
});

test('a long run with no full stop is broken at a clause, never mid-word', () => {
  const long = `${'a clause that keeps going, '.repeat(20)}and then it ends.`;
  const chunks = splitForSpeech(long, { maxChars: 120 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 160, `chunk too long: ${c.length}`);
    assert.doesNotMatch(c, /\bclaus$|\bkeepin$/, 'no word was cut in half');
  }
  assert.match(chunks.join(' '), /and then it ends\./);
});

test('no text is lost in the splitting', () => {
  const src = 'One sentence about something. Another about something else entirely. A third, with a clause, that runs on.';
  const joined = splitForSpeech(src).join(' ').replace(/\s+/g, ' ');
  assert.equal(joined, src);
});

test('nothing to say is an empty list, not a chunk of whitespace', () => {
  assert.deepEqual(splitForSpeech(''), []);
  assert.deepEqual(splitForSpeech('   \n\n  '), []);
  assert.deepEqual(splitForSpeech(null), []);
});

test('prepareForSpeech reports emptiness rather than sending silence to the engine', () => {
  const r = prepareForSpeech('![](only-an-image.png)'.replace('![](only-an-image.png)', '   '));
  assert.equal(r.empty, true);
  assert.deepEqual(r.chunks, []);
});

test('a whole message survives the round trip end to end', () => {
  const r = prepareForSpeech('## Morning\n\nI **did** the thing 🎉. See `notes.md` or [the doc](http://x.y).\n\n```py\nx = 1\n```\n\nThat is all.');
  assert.equal(r.empty, false);
  assert.doesNotMatch(r.spoken, /[*#`]|🎉|http/);
  assert.match(r.spoken, /I did the thing/);
  assert.equal(r.notes.length, 1);
});

// ── Float samples becoming a wav a browser will play ─────────────────────

test('what is encoded parses back as the same audio', () => {
  const samples = new Float32Array(240);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 8) * 0.5;

  const parsed = parseWav(encodeWav(samples, 24000));
  assert.equal(parsed.sampleRate, 24000);
  assert.equal(parsed.samples.length, 240);
  for (let i = 0; i < samples.length; i++) {
    assert.ok(Math.abs(parsed.samples[i] - samples[i]) < 0.001, `sample ${i} drifted`);
  }
});

test('a sample past full scale clamps instead of wrapping into noise', () => {
  // Wrapping turns a slight overshoot into a loud crack — a startling failure
  // on a surface people use because the screen is hard for them.
  const parsed = parseWav(encodeWav(new Float32Array([2, -2, 0.5]), 24000));
  assert.ok(parsed.samples[0] > 0.99, 'clamped to positive full scale');
  assert.ok(parsed.samples[1] < -0.99, 'clamped to negative full scale');
  assert.ok(Math.abs(parsed.samples[2] - 0.5) < 0.001);
});

test('an empty clip is a valid, playable, silent wav', () => {
  const wav = encodeWav(new Float32Array(0), 24000);
  assert.equal(wav.length, 44, 'header only');
  const parsed = parseWav(wav);
  assert.equal(parsed.samples.length, 0);
});

test('a plain array works as well as a typed array', () => {
  const parsed = parseWav(encodeWav([0, 0.25, -0.25], 16000));
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.samples.length, 3);
});
