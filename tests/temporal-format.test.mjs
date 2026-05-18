/**
 * Tests for the temporal_context payload renderer.
 *
 * Run with: node --test tests/temporal-format.test.mjs
 *
 * The contract under test is the boundary between Unruh and Thalamus:
 * Unruh produces a JSON shape; Thalamus turns it into text the model
 * reads. If either side drifts, conversations silently lose temporal
 * context — these tests catch the drift early.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTemporalContext } from '../temporal-format.js';

test('returns empty string for null payload', () => {
  assert.equal(formatTemporalContext(null), '');
});

test('returns empty string for undefined payload', () => {
  assert.equal(formatTemporalContext(undefined), '');
});

test('returns empty string for non-object payload', () => {
  assert.equal(formatTemporalContext('garbage'), '');
  assert.equal(formatTemporalContext(42), '');
});

test('omits section entirely when all sub-blocks empty', () => {
  // Critical contract: an Unruh that has no data yet (Milestone 1-2 state)
  // must NOT produce a hollow "[Temporal Context]" header. The assembler
  // in thalamus.js relies on '' here to skip the section push.
  const empty = {
    ts: '2026-05-18T10:00:00Z',
    schedule: { window: [], phase: null },
    interests: { standing: [], live: [] },
    handoff: { intent: null, open_threads: [] },
  };
  assert.equal(formatTemporalContext(empty), '');
});

test('renders handoff intent when present', () => {
  const out = formatTemporalContext({
    handoff: { intent: 'finishing the owl-wings thought', open_threads: [] },
  });
  assert.match(out, /Last session:/);
  assert.match(out, /finishing the owl-wings thought/);
});

test('renders open threads as strings or objects', () => {
  const out = formatTemporalContext({
    handoff: {
      intent: null,
      open_threads: ['raw string thread', { label: 'object thread' }, { id: 'fallback-id' }],
    },
  });
  assert.match(out, /raw string thread/);
  assert.match(out, /object thread/);
  assert.match(out, /fallback-id/);
});

test('renders current phase and schedule window', () => {
  const out = formatTemporalContext({
    schedule: {
      phase: { id: 'morning-correspondence', label: 'morning correspondence' },
      window: [
        { when: '14:00', label: "Chen's appointment" },
        { when: '22:00', label: 'cat play' },
      ],
    },
  });
  assert.match(out, /Current phase: morning correspondence/);
  assert.match(out, /14:00 — Chen's appointment/);
  assert.match(out, /22:00 — cat play/);
});

test('renders standing values without weights', () => {
  const out = formatTemporalContext({
    interests: { standing: [{ label: 'caring for the user' }], live: [] },
  });
  assert.match(out, /Standing values:/);
  assert.match(out, /caring for the user/);
  // Standing values must NOT carry a weight in the prompt — they never decay,
  // so a number would be meaningless and misleading.
  assert.doesNotMatch(out, /\[\d/);
});

test('renders live interests with weight to 2dp', () => {
  const out = formatTemporalContext({
    interests: {
      standing: [],
      live: [
        { label: 'owl feather aerodynamics', weight: 0.7432 },
        { label: 'biomimetic engineering', weight: 0.31 },
      ],
    },
  });
  assert.match(out, /Live interests \(by weight\):/);
  assert.match(out, /owl feather aerodynamics \[0\.74\]/);
  assert.match(out, /biomimetic engineering \[0\.31\]/);
});

test('falls back to id when label missing', () => {
  const out = formatTemporalContext({
    interests: { standing: [], live: [{ id: 'node-42', weight: 0.5 }] },
  });
  assert.match(out, /node-42/);
});

test('block order is handoff → schedule → interests', () => {
  const out = formatTemporalContext({
    handoff: { intent: 'HANDOFF-MARKER', open_threads: [] },
    schedule: { phase: { label: 'SCHEDULE-MARKER' }, window: [] },
    interests: { standing: [{ label: 'INTERESTS-MARKER' }], live: [] },
  });
  const h = out.indexOf('HANDOFF-MARKER');
  const s = out.indexOf('SCHEDULE-MARKER');
  const i = out.indexOf('INTERESTS-MARKER');
  assert.ok(h !== -1 && s !== -1 && i !== -1, 'all markers should render');
  assert.ok(h < s, 'handoff should come before schedule');
  assert.ok(s < i, 'schedule should come before interests');
});
