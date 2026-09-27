/**
 * Mood → threat link (trackers build spec §6 / T-D.2). SAFETY-CRITICAL,
 * ward-signed (2026-09).
 *
 * A distress-tagged mood-send gently, boundedly raises my human's threat tier —
 * so a run of "low / numb / stressed / raw" tags lifts my concern enough that
 * silence-triage takes a look, WITHOUT mood ever alone reaching a crisis tier.
 * This ADDS a bounded source to the shared threat scalar; it changes none of
 * crisis-signals' tiers/weights and none of threat-tracker's decay/floor logic
 * (spec "do-not-touch"). It only ever calls the existing `recordThreat` seam.
 *
 * Ward-signed shape:
 *   - Distress set = stressed + raw + low + numb, ENERGY-WEIGHTED: high-energy
 *     distress (raw = anguish/grief, the higher-acuity self-harm-adjacent signal;
 *     stressed = strain) weighs more than low-energy (low = withdrawn depression,
 *     numb = flat/dissociative). raw highest. Other moods (good/calm/energized/
 *     angry) never touch threat.
 *   - RAISE-ONLY: a positive mood never lowers threat.
 *   - BOUNDED so mood ALONE never reaches high/severe: each apply is clamped so
 *     the mood-driven weight never crosses MOOD_THREAT_CEILING (< HIGH tier).
 *   - CAPPED at MOOD_TAG_MAX_PER_DAY counted tags / 24h, then decays like any
 *     threat (the shared scalar, tau ≈ 3d).
 *   - No-ops under PROTO_FAMILIAR_THREAT_DISABLED (recordThreat/getThreat do) and
 *     its own PROTO_FAMILIAR_MOOD_THREAT_DISABLED.
 */

import {
  recordThreat, getThreat, getThreatHistory, THREAT_TIERS, HISTORY_CAP,
} from '../safety/threat-tracker.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const MOOD_SOURCE = 'mood-tag';

// Energy-weighted distress deltas (ward-signed). ~0.4 base: high-energy above,
// low-energy below; raw highest. A mood absent here has NO threat effect.
export const MOOD_THREAT_WEIGHTS = Object.freeze({
  raw:      0.6,   // high-energy anguish/grief — highest acuity, self-harm-adjacent
  stressed: 0.45,  // high-energy strain
  low:      0.3,   // low-energy withdrawn depression
  numb:     0.3,   // low-energy flat / dissociative
});

// Mood ALONE never crosses into HIGH (THREAT_TIERS.high). Capped comfortably
// below it: a run of distress tags can lift concern to (upper) `moderate` — which
// is what makes silence-triage take a look — but never a crisis tier.
export const MOOD_THREAT_CEILING = Math.min(3.5, THREAT_TIERS.high - 0.5);
export const MOOD_TAG_MAX_PER_DAY = 2;

export function moodThreatDisabled() {
  return process.env.PROTO_FAMILIAR_MOOD_THREAT_DISABLED === '1';
}

/** The base distress weight for a mood key (0 for a non-distress / unknown mood). */
export function moodThreatDelta(moodTag) {
  const w = MOOD_THREAT_WEIGHTS[String(moodTag ?? '').trim().toLowerCase()];
  return Number.isFinite(w) ? w : 0;
}

/**
 * PURE decision: the delta to apply for this mood, given the current effective
 * threat weight and how many mood tags already counted in the last 24h.
 * Returns 0 when nothing should apply. RAISE-ONLY and clamped so the result can
 * never push the mood-driven weight past `ceiling` (< HIGH).
 */
export function decideMoodDelta({
  moodTag, effWeight = 0, recentMoodCount = 0,
  ceiling = MOOD_THREAT_CEILING, maxPerDay = MOOD_TAG_MAX_PER_DAY,
} = {}) {
  const base = moodThreatDelta(moodTag);
  if (base <= 0) return 0;                       // not a distress mood
  if (recentMoodCount >= maxPerDay) return 0;    // daily cap spent
  const eff = Number.isFinite(effWeight) ? effWeight : 0;
  if (eff >= ceiling) return 0;                  // already at/above the mood ceiling — raise-only, never exceed
  return Math.min(base, ceiling - eff);          // clamp so newRaw ≤ ceiling
}

/**
 * Apply a mood's bounded threat delta. I/O; fire-and-forget from the chat path.
 * Never throws into a turn (the caller wraps too). Deps injectable for tests.
 * @returns {{ok, applied, delta?, tier?, reason?}}
 */
export async function applyMoodThreat({
  moodTag, now = Date.now(), tomesDir,
  recordFn = recordThreat, getThreatFn = getThreat, historyFn = getThreatHistory,
} = {}) {
  if (moodThreatDisabled()) return { ok: true, applied: false, reason: 'disabled' };
  if (moodThreatDelta(moodTag) <= 0) return { ok: true, applied: false, reason: 'not-distress' };

  const cur = await getThreatFn(tomesDir ? { tomesDir, now } : { now });
  if (cur?.disabled) return { ok: true, applied: false, reason: 'threat-disabled' };

  const hist = await historyFn(tomesDir ? { tomesDir, limit: HISTORY_CAP } : { limit: HISTORY_CAP });
  const recentMoodCount = (Array.isArray(hist) ? hist : []).filter(
    e => e?.source === MOOD_SOURCE && Number.isFinite(Date.parse(e?.ts)) && (now - Date.parse(e.ts)) < DAY_MS,
  ).length;

  const delta = decideMoodDelta({ moodTag, effWeight: cur?.weight ?? 0, recentMoodCount });
  if (delta <= 0) {
    return { ok: true, applied: false, reason: recentMoodCount >= MOOD_TAG_MAX_PER_DAY ? 'daily-cap' : 'at-ceiling' };
  }
  const r = await recordFn({
    delta, source: MOOD_SOURCE, now,
    signals: [{ id: MOOD_SOURCE, mood: String(moodTag).trim() }],
    ...(tomesDir ? { tomesDir } : {}),
  });
  return { ok: true, applied: true, delta, tier: r?.tier };
}
