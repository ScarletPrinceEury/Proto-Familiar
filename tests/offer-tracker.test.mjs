import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  lapseClassesFromNeeds, pruneOfferClasses, pickOfferCue, buildOfferTrackerBlock,
  nextOfferCue, MIN_LAPSES, COOLDOWN_DAYS,
} from '../src/tracker/offer-tracker.js';

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-09-24T12:00:00Z');
const dayISO = (offset) => new Date(NOW - offset * DAY).toISOString().slice(0, 10);

// A recurring need-window anchor with a resolutions ledger (date → resolution).
function need(label, resolutions = {}) {
  return {
    id: `need-${label}`, type: 'task', label,
    when: '2026-01-01T18:00:00', end: '2026-01-01T20:00:00',
    payload: { need: true, recurrence: { freq: 'daily' }, resolutions },
  };
}

test('lapseClassesFromNeeds: counts missed-in-window, needs MIN_LAPSES, sorts most-missed first', () => {
  const anchors = [
    need('dinner', { [dayISO(2)]: 'missed', [dayISO(5)]: 'missed', [dayISO(9)]: 'missed', [dayISO(40)]: 'missed' }), // 3 in window (40d out excluded)
    need('meds',   { [dayISO(1)]: 'missed', [dayISO(2)]: 'done',   [dayISO(3)]: 'missed' }),                          // 2 → below threshold
    need('walk',   { [dayISO(1)]: 'missed', [dayISO(2)]: 'missed', [dayISO(3)]: 'missed', [dayISO(4)]: 'missed' }),   // 4
  ];
  const classes = lapseClassesFromNeeds(anchors, { now: NOW });
  assert.deepEqual(classes.map(c => c.label), ['walk', 'dinner'], 'meds (2) dropped; sorted 4 then 3');
  assert.equal(classes[0].count, 4);
  assert.equal(MIN_LAPSES, 3);
});

test('lapseClassesFromNeeds: ignores non-need nodes and empty ledgers', () => {
  const notNeed = { id: 'x', label: 'thing', when: '2026-01-01T09:00:00', end: '2026-01-01T10:00:00', payload: { recurrence: { freq: 'daily' } } };
  assert.equal(lapseClassesFromNeeds([notNeed], { now: NOW }).length, 0);
  assert.equal(lapseClassesFromNeeds([need('dinner', {})], { now: NOW }).length, 0);
});

test('pruneOfferClasses: drops sensitive-health classes and in-cooldown classes', () => {
  const classes = [
    { key: 'dinner', label: 'dinner', count: 3 },
    { key: 'period tracking', label: 'period tracking', count: 4 },  // sensitive → never offered
    { key: 'shower', label: 'shower', count: 3 },
  ];
  const state = { shower: { lastOfferedTs: NOW - 5 * DAY } };            // within 30d cooldown
  const live = pruneOfferClasses(classes, state, { now: NOW });
  assert.deepEqual(live.map(c => c.label), ['dinner'], 'period (sensitive) + shower (cooldown) dropped');
});

test('pickOfferCue: skips a class a tracker already covers, picks the first free one, stamps cooldown', () => {
  const classes = [{ key: 'dinner', label: 'dinner', count: 4 }, { key: 'shower', label: 'shower', count: 3 }];
  const { cue, state } = pickOfferCue({ classes, trackerLabels: ['Dinner log'], state: {}, now: NOW });
  assert.equal(cue.label, 'shower', 'dinner is covered by "Dinner log" (token overlap) → skipped');
  assert.equal(state.shower.lastOfferedTs, NOW, 'cooldown stamped on the chosen class');
});

test('buildOfferTrackerBlock: care-first, names the offer, no deficit/suppression framing', () => {
  const block = buildOfferTrackerBlock({ key: 'dinner', label: 'dinner', count: 4 });
  assert.match(block, /^\[Might be worth offering to track\]/);
  assert.match(block, /dinner/);
  assert.match(block, /4 times/);
  assert.match(block, /offer to track together/i);           // the intent is named
  assert.match(block, /theirs to choose/i);                  // consent stays with my human
  assert.doesNotMatch(block, /if it fits|when it feels|only if the moment/i);  // no suppression hedge
  assert.equal(buildOfferTrackerBlock(null), '');
});

test('nextOfferCue: surfaces once, reads trackers only when a candidate survives, then rests for the cooldown', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'offer-'));
  try {
    const anchors = [need('dinner', { [dayISO(1)]: 'missed', [dayISO(3)]: 'missed', [dayISO(6)]: 'missed' })];
    let trackerReads = 0;
    const getTrackerLabels = async () => { trackerReads++; return []; };

    const first = await nextOfferCue({ needAnchors: anchors, getTrackerLabels, now: NOW, tomesDir: dir });
    assert.match(first, /Might be worth offering to track/);
    assert.equal(trackerReads, 1, 'the tracker read happened once (a candidate survived)');

    // Immediately after, the same class is inside its cooldown → no cue, no read.
    const second = await nextOfferCue({ needAnchors: anchors, getTrackerLabels, now: NOW + DAY, tomesDir: dir });
    assert.equal(second, '', 'the class rests through the cooldown');
    assert.equal(trackerReads, 1, 'no tracker read once everything is cooled down');

    // Past the cooldown it may surface again — with fresh misses in the new
    // 30-day window (the old ones have rightly aged out by now).
    const laterNow = NOW + (COOLDOWN_DAYS + 1) * DAY;
    const isoAt = (ms) => new Date(ms).toISOString().slice(0, 10);
    const laterAnchors = [need('dinner', {
      [isoAt(laterNow - 1 * DAY)]: 'missed',
      [isoAt(laterNow - 3 * DAY)]: 'missed',
      [isoAt(laterNow - 6 * DAY)]: 'missed',
    })];
    const later = await nextOfferCue({ needAnchors: laterAnchors, getTrackerLabels, now: laterNow, tomesDir: dir });
    assert.match(later, /Might be worth offering to track/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('nextOfferCue: an already-tracked concern is never offered', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'offer-'));
  try {
    const anchors = [need('dinner', { [dayISO(1)]: 'missed', [dayISO(3)]: 'missed', [dayISO(6)]: 'missed' })];
    const block = await nextOfferCue({
      needAnchors: anchors,
      getTrackerLabels: async () => ['Dinner journal'],  // covers "dinner"
      now: NOW, tomesDir: dir,
    });
    assert.equal(block, '', 'a concern with a tracker attached is not offered');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
