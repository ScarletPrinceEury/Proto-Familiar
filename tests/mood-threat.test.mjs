// Mood → threat link (T-D.2). SAFETY-CRITICAL, ward-signed: energy-weighted
// distress, raise-only, bounded below HIGH, ≤2/day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  moodThreatDelta, decideMoodDelta, applyMoodThreat,
  MOOD_THREAT_WEIGHTS, MOOD_THREAT_CEILING, MOOD_TAG_MAX_PER_DAY, MOOD_SOURCE,
} from '../src/tracker/mood-threat.js';
import { THREAT_TIERS } from '../src/safety/threat-tracker.js';

// ── weights (energy-weighted; ward-signed set) ────────────────────────────────
test('moodThreatDelta: distress set only, raw highest, high-energy > low-energy', () => {
  assert.equal(moodThreatDelta('raw'), MOOD_THREAT_WEIGHTS.raw);
  assert.ok(MOOD_THREAT_WEIGHTS.raw > MOOD_THREAT_WEIGHTS.stressed, 'raw (high-energy anguish) is highest');
  assert.ok(MOOD_THREAT_WEIGHTS.stressed > MOOD_THREAT_WEIGHTS.low, 'high-energy > low-energy');
  assert.equal(MOOD_THREAT_WEIGHTS.low, MOOD_THREAT_WEIGHTS.numb);
  // non-distress moods never touch threat
  for (const m of ['good', 'calm', 'energized', 'angry', 'unknown', '', null, undefined]) {
    assert.equal(moodThreatDelta(m), 0, `${m} is not a distress mood`);
  }
});

test('the mood ceiling is safely below HIGH (mood alone can never reach a crisis tier)', () => {
  assert.ok(MOOD_THREAT_CEILING < THREAT_TIERS.high, 'ceiling < HIGH');
  assert.ok(MOOD_THREAT_CEILING >= THREAT_TIERS.moderate, 'but can still reach moderate → triage looks');
});

// ── decideMoodDelta (pure) ────────────────────────────────────────────────────
test('decideMoodDelta: non-distress → 0', () => {
  assert.equal(decideMoodDelta({ moodTag: 'good', effWeight: 0, recentMoodCount: 0 }), 0);
});

test('decideMoodDelta: normal distress tag applies its full weight', () => {
  assert.equal(decideMoodDelta({ moodTag: 'raw', effWeight: 0, recentMoodCount: 0 }), MOOD_THREAT_WEIGHTS.raw);
});

test('decideMoodDelta: daily cap spent → 0', () => {
  assert.equal(decideMoodDelta({ moodTag: 'raw', effWeight: 0, recentMoodCount: MOOD_TAG_MAX_PER_DAY }), 0);
});

test('decideMoodDelta: raise-only — at/above ceiling adds nothing', () => {
  assert.equal(decideMoodDelta({ moodTag: 'raw', effWeight: MOOD_THREAT_CEILING, recentMoodCount: 0 }), 0);
  assert.equal(decideMoodDelta({ moodTag: 'raw', effWeight: MOOD_THREAT_CEILING + 1, recentMoodCount: 0 }), 0);
});

test('decideMoodDelta: clamps so the result never crosses the ceiling', () => {
  const eff = MOOD_THREAT_CEILING - 0.2;   // only 0.2 of headroom, raw wants 0.6
  const d = decideMoodDelta({ moodTag: 'raw', effWeight: eff, recentMoodCount: 0 });
  assert.ok(Math.abs((eff + d) - MOOD_THREAT_CEILING) < 1e-9, 'eff+delta lands exactly at the ceiling, never past');
});

// ── applyMoodThreat (pipeline, injected threat deps) ──────────────────────────
function harness({ weight = 0, history = [], disabled = false } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      now: 1_000_000_000_000,
      getThreatFn: async () => ({ weight, disabled, tier: 'calm' }),
      historyFn: async () => history,
      recordFn: async (a) => { calls.push(a); return { ok: true, tier: 'moderate' }; },
    },
  };
}

test('applyMoodThreat: a distress tag raises threat via the mood-tag source', async () => {
  const h = harness({ weight: 0 });
  const r = await applyMoodThreat({ moodTag: 'stressed', ...h.deps });
  assert.equal(r.applied, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].source, MOOD_SOURCE);
  assert.equal(h.calls[0].delta, MOOD_THREAT_WEIGHTS.stressed);
  assert.equal(h.calls[0].signals[0].mood, 'stressed');
});

test('applyMoodThreat: a non-distress mood is a no-op (no recordThreat)', async () => {
  const h = harness({ weight: 0 });
  const r = await applyMoodThreat({ moodTag: 'calm', ...h.deps });
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'not-distress');
  assert.equal(h.calls.length, 0);
});

test('applyMoodThreat: the daily cap holds (2 mood tags in 24h → the 3rd no-ops)', async () => {
  const now = 1_000_000_000_000;
  const history = [
    { source: MOOD_SOURCE, ts: new Date(now - 1000).toISOString() },
    { source: MOOD_SOURCE, ts: new Date(now - 2000).toISOString() },
  ];
  const h = harness({ weight: 1, history });
  const r = await applyMoodThreat({ moodTag: 'raw', ...h.deps, now });
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'daily-cap');
  assert.equal(h.calls.length, 0);
});

test('applyMoodThreat: mood tags older than 24h do NOT count toward the cap', async () => {
  const now = 1_000_000_000_000;
  const history = [{ source: MOOD_SOURCE, ts: new Date(now - 25 * 60 * 60 * 1000).toISOString() }];
  const h = harness({ weight: 0, history });
  const r = await applyMoodThreat({ moodTag: 'low', ...h.deps, now });
  assert.equal(r.applied, true, 'a >24h-old tag is out of the window');
});

test('applyMoodThreat: clamps to the ceiling — mood ALONE never reaches HIGH', async () => {
  const h = harness({ weight: MOOD_THREAT_CEILING - 0.1 });
  const r = await applyMoodThreat({ moodTag: 'raw', ...h.deps });
  assert.equal(r.applied, true);
  assert.ok(Math.abs(((MOOD_THREAT_CEILING - 0.1) + h.calls[0].delta) - MOOD_THREAT_CEILING) < 1e-9);
  assert.ok((MOOD_THREAT_CEILING - 0.1) + h.calls[0].delta < THREAT_TIERS.high, 'never crosses into HIGH');
});

test('applyMoodThreat: threat detector disabled → no-op', async () => {
  const h = harness({ disabled: true });
  const r = await applyMoodThreat({ moodTag: 'raw', ...h.deps });
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'threat-disabled');
  assert.equal(h.calls.length, 0);
});

test('applyMoodThreat: PROTO_FAMILIAR_MOOD_THREAT_DISABLED → no-op, no reads/writes', async () => {
  process.env.PROTO_FAMILIAR_MOOD_THREAT_DISABLED = '1';
  try {
    const h = harness({ weight: 0 });
    const r = await applyMoodThreat({ moodTag: 'raw', ...h.deps });
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'disabled');
    assert.equal(h.calls.length, 0);
  } finally {
    delete process.env.PROTO_FAMILIAR_MOOD_THREAT_DISABLED;
  }
});
