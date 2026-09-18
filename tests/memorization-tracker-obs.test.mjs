/**
 * Passive tracker capture (trackers build spec §5.2) — the memorization side.
 *
 * Two halves:
 *  - the PROMPT: buildPrompt advertises a tracker legend + the optional per-fact
 *    tracker_observations field ONLY when a legend is passed; buildSharedRoomPrompt
 *    (a gated/shared-room slice) NEVER sees it (T2 fail-closed).
 *  - the INGEST: parseTrackerObservations code-gates every observation against the
 *    legend (off-legend / bad-shape dropped), and processJob logs the survivors as
 *    source:'inferred' — driven through the REAL job with a stubbed provider (the
 *    vision post-mortem's pipeline rule), so a mis-wired loop can't hide.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, buildSharedRoomPrompt, parseTrackerObservations, processJob } from '../src/memory/memorization.js';

const MSGS = [
  { role: 'user', content: 'I only slept about five hours and I feel pretty low today.' },
  { role: 'assistant', content: 'That sounds rough. Want to talk about it?' },
];

const LEGEND = [
  { id: 'sleep-x7', label: 'sleep', archetype: 'series', fields: ['hours', 'quality'] },
  { id: 'mood-q2', label: 'mood', archetype: 'series', fields: ['mood', 'note'] },
];

// ── Prompt side ──────────────────────────────────────────────────────────────

test('no tracker legend → prompt omits tracker_observations entirely (backward compatible)', () => {
  const p = buildPrompt(MSGS, null, 'Chen');
  assert.ok(p, 'prompt built');
  assert.doesNotMatch(p, /tracker_observations/);
  assert.doesNotMatch(p, /Tracker legend/);
});

test('tracker legend present → prompt advertises the field, the legend, and the legend-ids-only rule', () => {
  const p = buildPrompt(MSGS, null, 'Chen', [], true, '', LEGEND);
  assert.match(p, /tracker_observations/);
  assert.match(p, /Tracker legend/);
  assert.match(p, /sleep \[series\] = sleep-x7 · fields: hours, quality/);
  assert.match(p, /mood \[series\] = mood-q2 · fields: mood, note/);
  assert.match(p, /ONLY those \(never one I invent\)/);
  assert.match(p, /never infer a value my human didn't actually give/);
});

test('T2: buildSharedRoomPrompt NEVER carries a tracker legend or field, even conceptually', () => {
  // The shared-room prompt takes no tracker legend argument at all; assert the
  // rendered prompt is free of the whole apparatus so a villager slice can never
  // seed the ward's private ledgers.
  const p = buildSharedRoomPrompt(MSGS, null, 'Chen', '');
  assert.ok(p, 'shared-room prompt built');
  assert.doesNotMatch(p, /tracker_observations/);
  assert.doesNotMatch(p, /Tracker legend/);
});

test('tracker legend entries without id or label are skipped; legend caps at 20', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `t-${i}`, label: `Ledger ${i}`, archetype: 'state' }));
  const p = buildPrompt(MSGS, null, 'Chen', [], true, '', [{ label: 'no id' }, { id: 'no-label' }, ...many]);
  assert.doesNotMatch(p, /no id/);
  assert.doesNotMatch(p, /no-label/);
  assert.match(p, /Ledger 0 \[state\] = t-0/);
  assert.match(p, /Ledger 19 \[state\] = t-19/);
  assert.doesNotMatch(p, /= t-20\b/);
});

// ── parseTrackerObservations (the code gate) ─────────────────────────────────

test('parseTrackerObservations: only legend ids survive; off-legend and bad-shape dropped', () => {
  const valid = new Set(['sleep-x7', 'mood-q2']);
  const facts = [
    { content: 'slept 5h', tracker_observations: [{ tracker: 'sleep-x7', ts: '2026-09-18T08:00:00', payload: { hours: 5 } }] },
    { content: 'invented', tracker_observations: [{ tracker: 'ghost-z9', payload: { x: 1 } }] },   // off-legend → drop
    { content: 'bad shape', tracker_observations: [{ tracker: 'mood-q2', payload: 'not-an-object' }] }, // payload not object → drop
    { content: 'no obs field' },
  ];
  const out = parseTrackerObservations(facts, valid);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { tracker: 'sleep-x7', ts: '2026-09-18T08:00:00', payload: { hours: 5 } });
});

test('parseTrackerObservations: ts is optional and dedups identical observations', () => {
  const valid = new Set(['mood-q2']);
  const facts = [
    { tracker_observations: [{ tracker: 'mood-q2', payload: { mood: 'low' } }] },
    { tracker_observations: [{ tracker: 'mood-q2', payload: { mood: 'low' } }] }, // dup → collapsed
  ];
  const out = parseTrackerObservations(facts, valid);
  assert.equal(out.length, 1);
  assert.equal(out[0].ts, undefined, 'ts omitted when not given');
});

test('parseTrackerObservations: empty legend or non-array facts → []', () => {
  assert.deepEqual(parseTrackerObservations([{ tracker_observations: [{ tracker: 'x', payload: {} }] }], new Set()), []);
  assert.deepEqual(parseTrackerObservations(null, new Set(['a'])), []);
});

// ── Pipeline (through the real processJob) ───────────────────────────────────

const providerReturning = (facts) => async () => ({
  content: JSON.stringify({ facts, relations: [] }),
  finishReason: 'stop',
});

function baseJob(over = {}) {
  return {
    sessionId: 's-trk-1', scope: 'session', topicId: 'topic-1', topicLabel: 'chat',
    messages: [
      { role: 'user', content: 'hi there, long enough to memorize something from this exchange' },
      { role: 'assistant', content: 'good to see you' },
    ],
    provider: 'nanogpt', apiKey: 'sk-test', model: 'm', baseUrl: null,
    audienceTag: 'ward-private',
    ...over,
  };
}

// Neutralise every Unruh/registry seam; capture listTrackers consultations and
// logTrackerEntry writes.
function deps({ facts, legend = [], listCalls, logged }) {
  return {
    callProvider: providerReturning(facts),
    getRegistry: async () => ({ villagers: [] }),
    getRememberMap: async () => null,
    getStandingConsent: async () => ({}),
    getScheduleWindow: async () => ({ nodes: [], linked: [] }),
    graphRelate: async () => ({ ok: true }),
    createSessionFollowup: async () => {},
    createMemoryFull: async () => ({ ok: true, id: 'mem-x' }),
    applyMemoryIntegrityGate: async ({ memoryArgs }) => ({ write: true, action: 'write', memoryArgs }),
    listTrackers: async () => { listCalls.push(1); return { ok: true, trackers: legend }; },
    logTrackerEntry: async (a) => { logged.push(a); return { ok: true, id: `tke-${logged.length}` }; },
  };
}

test('pipeline: a ward-private observation is logged as source:inferred; an off-legend id is dropped', async () => {
  const listCalls = [], logged = [];
  const facts = [
    { content: 'My human slept about five hours and feels low.', category: 'health_info', confidence: 1.0, temporality: 'episodic',
      tracker_observations: [
        { tracker: 'sleep-x7', ts: '2026-09-18T08:00:00', payload: { hours: 5, quality: 'poor' } },
        { tracker: 'ghost-z9', payload: { x: 1 } },  // not in legend → must never be logged
      ] },
  ];
  await processJob(baseJob(), deps({ facts, legend: LEGEND, listCalls, logged }));

  assert.equal(listCalls.length, 1, 'the tracker legend was fetched for a ward-private slice');
  assert.equal(logged.length, 1, 'exactly the one legend-valid observation was logged');
  assert.equal(logged[0].tracker_id, 'sleep-x7');
  assert.equal(logged[0].source, 'inferred', 'passive capture logs as inferred');
  assert.deepEqual(logged[0].payload, { hours: 5, quality: 'poor' });
});

test('T2 pipeline: a SHARED-room slice never fetches the legend and never logs an observation', async () => {
  const listCalls = [], logged = [];
  const facts = [
    { content: 'Someone mentioned sleeping badly.', category: 'basics', confidence: 1.0, temporality: 'episodic',
      tracker_observations: [{ tracker: 'sleep-x7', payload: { hours: 5 } }] },
  ];
  await processJob(baseJob({ audienceTag: 'village-room' }), deps({ facts, legend: LEGEND, listCalls, logged }));

  assert.equal(listCalls.length, 0, 'a shared room never even reads the tracker legend (T2)');
  assert.equal(logged.length, 0, 'no observation is logged from a gated slice');
});

test('off-switch pipeline: PROTO_FAMILIAR_TRACKERS_DISABLED stops capture entirely', async () => {
  const listCalls = [], logged = [];
  const facts = [
    { content: 'My human slept five hours.', category: 'health_info', confidence: 1.0, temporality: 'episodic',
      tracker_observations: [{ tracker: 'sleep-x7', payload: { hours: 5 } }] },
  ];
  const prev = process.env.PROTO_FAMILIAR_TRACKERS_DISABLED;
  process.env.PROTO_FAMILIAR_TRACKERS_DISABLED = '1';
  try {
    await processJob(baseJob(), deps({ facts, legend: LEGEND, listCalls, logged }));
  } finally {
    if (prev === undefined) delete process.env.PROTO_FAMILIAR_TRACKERS_DISABLED;
    else process.env.PROTO_FAMILIAR_TRACKERS_DISABLED = prev;
  }
  assert.equal(listCalls.length, 0, 'disabled → the legend is never fetched');
  assert.equal(logged.length, 0, 'disabled → nothing is logged');
});
