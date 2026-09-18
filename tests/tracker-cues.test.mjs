/**
 * Tracker cues (trackers build spec §5.3) — the pacing + block text.
 *
 * selectTrackerCues owns the aging: eligible-when-stale, per-day ask-cap,
 * opt-out at ask_cap 0 (erp), a hard MAX_RENDERS age-out, clear-on-arrival
 * (prune), and the 2-line-per-turn cap. Pure, so it's driven by threading the
 * state through calls with explicit todayKeys.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  selectTrackerCues, buildTrackerCueBlock, MAX_RENDERS, MAX_PER_TURN,
  readTrackerCueState, writeTrackerCueState, nextTrackerCue,
} from '../src/tracker/tracker-cues.js';
import { readJsonState, writeJsonState } from '../src/util/json-state.js';

const cand = (id, over = {}) => ({ id, label: id, hours_since: 40, ask_cap_per_day: 1, ...over });
const DAY = '2026-09-18';

test('a never-nudged stale tracker is eligible and its state advances', () => {
  const { items, nextState } = selectTrackerCues({ candidates: [cand('mood-x7')], state: {}, todayKey: DAY });
  assert.deepEqual(items.map(i => i.id), ['mood-x7']);
  assert.equal(nextState['mood-x7'].totalRenders, 1);
  assert.equal(nextState['mood-x7'].shownToday, 1);
  assert.equal(nextState['mood-x7'].lastShownDay, DAY);
});

test('ask_cap_per_day gates re-offers within the ward-local day, then reopens next day', () => {
  const c = [cand('mood-x7', { ask_cap_per_day: 1 })];
  const first = selectTrackerCues({ candidates: c, state: {}, todayKey: DAY });
  assert.equal(first.items.length, 1);
  // Same day, cap 1 already used → not offered again.
  const second = selectTrackerCues({ candidates: c, state: first.nextState, todayKey: DAY });
  assert.equal(second.items.length, 0);
  // A new ward-local day reopens the window.
  const nextDay = selectTrackerCues({ candidates: c, state: second.nextState, todayKey: '2026-09-19' });
  assert.equal(nextDay.items.length, 1);
  assert.equal(nextDay.nextState['mood-x7'].totalRenders, 2);
});

test('ask_cap_per_day: 2 allows two offers in one day, not three', () => {
  const c = [cand('sleep-q2', { ask_cap_per_day: 2 })];
  let state = {};
  let shown = 0;
  for (let i = 0; i < 3; i++) {
    const r = selectTrackerCues({ candidates: c, state, todayKey: DAY });
    shown += r.items.length;
    state = r.nextState;
  }
  assert.equal(shown, 2, 'cap of 2 caps the day at two offers');
});

test('ask_cap 0 (erp) is never cued', () => {
  const { items } = selectTrackerCues({ candidates: [cand('erp-z9', { ask_cap_per_day: 0 })], state: {}, todayKey: DAY });
  assert.equal(items.length, 0);
});

test('aged out after MAX_RENDERS total nudges, across days', () => {
  const c = [cand('mood-x7')];
  let state = {};
  for (let d = 0; d < MAX_RENDERS; d++) {
    state = selectTrackerCues({ candidates: c, state, todayKey: `2026-09-2${d}` }).nextState;
  }
  assert.equal(state['mood-x7'].totalRenders, MAX_RENDERS);
  const after = selectTrackerCues({ candidates: c, state, todayKey: '2026-09-29' });
  assert.equal(after.items.length, 0, 'a fourth nudge never comes');
});

test('clear-on-arrival: a tracker no longer stale is pruned from state', () => {
  const seeded = { 'mood-x7': { firstSeenTs: 1, totalRenders: 1, lastShownDay: DAY, shownToday: 1 } };
  // mood-x7 is not in candidates this turn (my human logged it → no longer stale).
  const { items, nextState } = selectTrackerCues({ candidates: [cand('sleep-q2')], state: seeded, todayKey: '2026-09-20' });
  assert.ok(!('mood-x7' in nextState), 'the cleared tracker is dropped from aging state');
  assert.deepEqual(items.map(i => i.id), ['sleep-q2']);
});

test('at most MAX_PER_TURN cue lines in one turn', () => {
  const many = Array.from({ length: 5 }, (_, i) => cand(`t-${i}`));
  const { items } = selectTrackerCues({ candidates: many, state: {}, todayKey: DAY });
  assert.equal(items.length, MAX_PER_TURN);
});

test('buildTrackerCueBlock renders the marker + id-bearing lines, or empty', () => {
  assert.equal(buildTrackerCueBlock([]), '');
  const block = buildTrackerCueBlock([{ id: 'mood-x7', label: 'mood', hours_since: 40 }]);
  assert.match(block, /^\[Tracker cues\]/);
  assert.match(block, /mood — last logged 40h ago  \[id: mood-x7\]/);
  assert.match(block, /tracker_log/);
  // No bias-toward-quiet language.
  assert.doesNotMatch(block, /only (if|when)|bias toward|erode trust|if it feels/i);
});

test('buildTrackerCueBlock: days phrasing past 48h', () => {
  const block = buildTrackerCueBlock([{ id: 'laundry-a1', label: 'laundry', hours_since: 170 }]);
  assert.match(block, /last logged 7d ago/);
});

test('json-state util: missing → fallback; roundtrip; corrupt → fallback', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jsonstate-'));
  try {
    const f = path.join(dir, 'x.json');
    assert.deepEqual(await readJsonState(f, { a: 1 }), { a: 1 });
    await writeJsonState(f, { hello: 'world' });
    assert.deepEqual(await readJsonState(f), { hello: 'world' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('nextTrackerCue persists advanced state and returns the block', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trackercue-'));
  try {
    const block = await nextTrackerCue({ candidates: [cand('mood-x7')], todayKey: DAY, tomesDir: dir });
    assert.match(block, /\[Tracker cues\]/);
    const state = await readTrackerCueState({ tomesDir: dir });
    assert.equal(state['mood-x7'].totalRenders, 1);
    // Empty candidates → no block, no throw.
    assert.equal(await nextTrackerCue({ candidates: [], todayKey: DAY, tomesDir: dir }), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
