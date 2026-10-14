// Excerpts of long messages in injected context (0.14.69).
//
// Familiars sometimes said a message of theirs had been cut off when it had gone
// out complete. Their own earlier words reached them clipped to a fixed length —
// ending in "…", or just stopping mid-word — with nothing to say the cut was only
// how the line was displayed. An excerpt now keeps the START and the END of a
// long message with an explicit marker between them, so the real ending shows the
// message was finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { mkdtempSync, rmSync } from 'fs';

const { excerpt, EXCERPT_MARKER } = await import('../src/util/excerpt.js');
const { recordEvent, recentElsewhere, buildRecentElsewhereBlock } = await import('../src/memory/hippocampus.js');

const LONG = 'I looked into the train times for Saturday and there are two good options. '
  + 'The early one gets you there by nine, which leaves the whole morning for the market, '
  + 'and the later one is cheaper but you would miss the opening of the exhibition you mentioned. '
  + 'Either way, I think booking tonight is smart because the prices tend to jump by Friday, '
  + 'so let me know which one you like and I will put a reminder in for the booking.';

test('short text passes through untouched', () => {
  assert.equal(excerpt('All done!', 280), 'All done!');
});

test('a long message keeps its real start and its real end, with the marker between', () => {
  const out = excerpt(LONG, 280);
  assert.ok(out.length <= 280, `${out.length} > 280`);
  assert.ok(out.startsWith('I looked into the train times'));
  assert.ok(out.endsWith('put a reminder in for the booking.'), 'the actual ending is visible');
  assert.ok(out.includes(EXCERPT_MARKER));
  assert.doesNotMatch(out, /…$/, 'never ends on a bare ellipsis');
});

test('cuts land between words, never inside one', () => {
  const out = excerpt(LONG, 200);
  const [head, tail] = out.split(EXCERPT_MARKER).map(s => s.trim());
  assert.ok(LONG.startsWith(head), 'head is a real prefix');
  assert.ok(LONG.endsWith(tail), 'tail is a real suffix');
  assert.match(LONG.slice(head.length, head.length + 1), /\s/, 'head ends at a word boundary');
  assert.match(LONG.slice(LONG.length - tail.length - 1, LONG.length - tail.length), /\s/, 'tail starts at a word boundary');
});

test('one unbroken run with no spaces still fits the budget', () => {
  const out = excerpt('x'.repeat(1000), 120);
  assert.ok(out.length <= 120);
  assert.ok(out.includes(EXCERPT_MARKER));
});

test('the hippocampus shows my own long reply with its real ending (pipeline)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hippo-excerpt-'));
  try {
    const now = new Date('2026-01-01T12:00:00Z');
    await recordEvent({ surface: 'discord', locationKey: 'dm:1', speaker: 'me', audienceTag: 'ward-private', text: LONG, now, tomesDir: dir });
    const evs = await recentElsewhere({ now, wardView: true, tomesDir: dir });
    const block = buildRecentElsewhereBlock(evs, { now });
    const line = block.split('\n').find(l => l.includes('I said:'));
    assert.ok(line.endsWith('put a reminder in for the booking.'), line);
    assert.ok(line.includes(EXCERPT_MARKER));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an entry stored before this fix (clipped, ending in "…") is shown with the marker, not a bare ellipsis', () => {
  const old = { ts: '2026-01-01T11:55:00Z', surface: 'web', speaker: 'me', text: 'x'.repeat(279) + '…' };
  const block = buildRecentElsewhereBlock([old], { now: new Date('2026-01-01T12:00:00Z') });
  assert.doesNotMatch(block, /…$/m);
  assert.ok(block.includes('cut for length'));
});

// ── The deliberation prompts (ward-signed 0.14.69) ──────────────────────────
const { formatRecentMessagesForContext, renderTriageSliceBody, TRIAGE_UNCUT_LATEST, TRIAGE_LINE_CEILING } = await import('../cerebellum.js');

test('noticing / warm reach-out: my own long reply shows its real ending, not a mid-word stop', () => {
  const out = formatRecentMessagesForContext([{ role: 'assistant', content: LONG }], Date.now());
  assert.match(out, /\[Me\]: I looked into the train times/);
  assert.ok(out.trimEnd().endsWith('put a reminder in for the booking.'));
  assert.ok(out.includes(EXCERPT_MARKER));
});

test('triage: the newest messages are never cut in any way, however long', () => {
  const huge = (tag) => `${tag} ` + 'word '.repeat(4000) + `${tag} END.`;   // ~20k chars each
  const slice = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: huge(`m${i}`) }));
  const lines = renderTriageSliceBody(slice, { nowMs: Date.now() }).split('\n');
  assert.equal(lines.length, 8);
  for (let i = 8 - TRIAGE_UNCUT_LATEST; i < 8; i++) {
    assert.ok(lines[i].endsWith(slice[i].content), `newest line ${i} is whole`);
    assert.ok(!lines[i].includes(EXCERPT_MARKER));
  }
  // An OLDER giant paste is the only thing that can be shortened — start + real end.
  assert.ok(lines[0].includes(EXCERPT_MARKER));
  assert.ok(lines[0].endsWith('m0 END.'));
  assert.ok(lines[0].length < TRIAGE_LINE_CEILING + 40);
});

test('triage: older lines under the ceiling are whole too — a sentence at the end of a long message reaches triage', () => {
  const vent = 'It has been a long week. '.repeat(80) + "I don't want to be here anymore.";
  const slice = [{ role: 'user', content: vent }, ...Array.from({ length: 7 }, () => ({ role: 'assistant', content: 'ok' }))];
  const body = renderTriageSliceBody(slice, { nowMs: Date.now(), humanLabel: 'My human' });
  assert.ok(body.includes("I don't want to be here anymore."));
  assert.ok(!body.includes(EXCERPT_MARKER));
});
