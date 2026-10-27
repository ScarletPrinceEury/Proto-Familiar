// Memorization labels listed web speakers in the transcript text (0.14.100).
//
// On a private slice the extractor only had the `name` field to tell Claude
// Code (on the bridge) apart from my human. The provider accepted the field,
// the model didn't go by it, and things Claude Code said or asked were filed
// as my human's ("my human flagged …", "I agreed to check-ins with my human").
// Now a listed speaker's lines read "[Name]: …", like the live chat shows them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { conversationMessages, buildExtractionMessages, otherSpeakersNote, processJob } from '../src/memory/memorization.js';

const SETTINGS = { userName: 'Sam', webSpeakers: ['Claude Code'] };
const SLICE = [
  { role: 'user', content: 'Your status summary contradicts the tome. Which is current?', speaker: 'Claude Code', timestamp: '2026-10-26T17:25:00Z' },
  { role: 'assistant', content: "The tome is right. I'll fix the summary tonight.", timestamp: '2026-10-26T17:26:00Z' },
  { role: 'user', content: 'thanks both, going to bed', timestamp: '2026-10-26T22:00:00Z' },
  { role: 'assistant', content: 'Sleep well.', timestamp: '2026-10-26T22:01:00Z' },
];

test('a listed speaker reads "[Name]: …" on a private slice; my human stays unlabelled', () => {
  const out = conversationMessages(SLICE, { settings: SETTINGS });
  assert.equal(out[0].content, '[Claude Code]: Your status summary contradicts the tome. Which is current?');
  assert.equal(out[2].content, 'thanks both, going to bed');
  assert.equal(out[1].role, 'assistant');
});

test('the label rides beside the name field, not instead of it', () => {
  const out = conversationMessages(SLICE, { settings: SETTINGS, withNames: true, wardLabel: 'Sam' });
  assert.equal(out[0].name, 'claude-code');
  assert.match(out[0].content, /^\[Claude Code\]: /);
  assert.equal(out[2].name, 'ward-sam');
});

test('in a shared room a listed speaker gets their own label, never my human\'s', () => {
  const out = conversationMessages(SLICE, { settings: SETTINGS, sharedRoom: true, wardLabel: 'Sam' });
  assert.equal(out[0].content, '[Claude Code]: Your status summary contradicts the tome. Which is current?');
  assert.equal(out[2].content, 'Sam: thanks both, going to bed');
});

test('fail-closed: an unlisted speaker is my human, and no settings labels nothing', () => {
  const stray = [{ role: 'user', content: 'hi', speaker: 'Somebody' }, { role: 'assistant', content: 'hey' }];
  assert.equal(conversationMessages(stray, { settings: SETTINGS })[0].content, 'hi');
  assert.equal(conversationMessages(SLICE)[0].content, SLICE[0].content);
});

test('the "Others in this conversation" note appears only when someone else typed', () => {
  assert.match(otherSpeakersNote(SLICE, SETTINGS), /### Others in this conversation\nSome lines here aren't my human's\. A line starting "\[Claude Code\]:" is that person/);
  assert.equal(otherSpeakersNote(SLICE.slice(2), SETTINGS), '');
});

test('buildExtractionMessages passes the label through', () => {
  const msgs = buildExtractionMessages({ instructions: 'notes', messages: SLICE, settings: SETTINGS });
  assert.equal(msgs[1].content, '[Claude Code]: Your status summary contradicts the tome. Which is current?');
});

test('PIPELINE: processJob sends the labelled transcript and the note to the extractor', async () => {
  const sent = [];
  await processJob({
    sessionId: 's-spk-1', scope: 'session', topicId: 't', topicLabel: 'chat',
    provider: 'nanogpt', apiKey: 'sk-test', model: 'm', baseUrl: null, audienceTag: 'ward-private', messages: SLICE,
  }, {
    readSettings: () => SETTINGS,
    callProvider: async ({ messages }) => { sent.push(messages); return { content: JSON.stringify({ facts: [{ content: 'The tome is the current status.', category: 'basics', confidence: 1, temporality: 'episodic' }], relations: [] }), finishReason: 'stop' }; },
    getRegistry: async () => ({ villagers: [] }),
    getRememberMap: async () => null,
    getStandingConsent: async () => ({}),
    getScheduleWindow: async () => ({ nodes: [], linked: [] }),
    graphRelate: async () => ({ ok: true }),
    createMemoryFull: async () => ({ ok: true, id: 'mem-x' }),
    applyMemoryIntegrityGate: async ({ memoryArgs }) => ({ write: true, action: 'write', memoryArgs }),
    listTrackers: async () => ({ ok: true, trackers: [] }),
    logTrackerEntry: async () => ({ ok: true }),
    heldPromisesSince: async () => [],
    backPromises: async () => [],
  });
  const [msgs] = sent;
  assert.match(msgs[0].content, /### Others in this conversation/);
  const firstUser = msgs.find(m => m.role === 'user' && m.content.includes('contradicts'));
  assert.ok(firstUser.content.startsWith('[Claude Code]: '), 'the bridge line carries its speaker in the text');
  assert.ok(msgs.some(m => m.role === 'user' && m.content === 'thanks both, going to bed'), "my human's line is not relabelled");
});
