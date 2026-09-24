// Mood-tagged send (§6, T-D) — the soft-lock predicates + onboarding stamp.
// These are pure functions inside the classic browser script public/app.js,
// pulled out via the vm-extract harness and tested in isolation (INVARIANT T9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { extractFunctionSource } from './_vm-extract.mjs';

// moodSendVisible + ensureMoodOnboarding call moodSendInOnboarding, so all three
// (plus the shared MOOD_ONBOARD_MS const) load into ONE vm context together.
const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const constLine = src.split('\n').find(l => /^const MOOD_ONBOARD_MS/.test(l));
const bundle = [
  constLine,
  extractFunctionSource(src, 'moodSendInOnboarding'),
  extractFunctionSource(src, 'moodSendVisible'),
  extractFunctionSource(src, 'ensureMoodOnboarding'),
].join('\n');
const ctx = {};
runInNewContext(`${bundle}\nresult = { moodSendInOnboarding, moodSendVisible, ensureMoodOnboarding };`, ctx);
const { moodSendInOnboarding, moodSendVisible, ensureMoodOnboarding } = ctx.result;

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-09-24T12:00:00Z');

test('moodSendInOnboarding: true only inside the 14-day window from a valid stamp', () => {
  assert.equal(moodSendInOnboarding(NOW, NOW), true);                 // just stamped
  assert.equal(moodSendInOnboarding(NOW - 13 * DAY, NOW), true);      // day 13
  assert.equal(moodSendInOnboarding(NOW - 15 * DAY, NOW), false);     // past 14 days
  assert.equal(moodSendInOnboarding(NOW + DAY, NOW), false);          // stamp in the future
  assert.equal(moodSendInOnboarding(null, NOW), false);               // unstamped
  assert.equal(moodSendInOnboarding(undefined, NOW), false);
});

test('moodSendVisible: onboarding forces it on; otherwise the opt-in toggle decides', () => {
  // In the window → shown regardless of the toggle.
  assert.equal(moodSendVisible({ moodSendOnboardedAt: NOW, moodSendEnabled: false }, NOW), true);
  // Out of the window → the toggle governs.
  const past = NOW - 30 * DAY;
  assert.equal(moodSendVisible({ moodSendOnboardedAt: past, moodSendEnabled: true }, NOW), true);
  assert.equal(moodSendVisible({ moodSendOnboardedAt: past, moodSendEnabled: false }, NOW), false);
  assert.equal(moodSendVisible(null, NOW), false);
});

test('ensureMoodOnboarding: a FRESH install starts the soft lock (T9)', () => {
  const s = { turnCount: 0, messages: [] };
  ensureMoodOnboarding(s, NOW);
  assert.equal(s.moodSendOnboardedAt, NOW, 'stamped now');
  assert.equal(s.moodSendEnabled, true, 'toggle on for post-onboarding');
  assert.equal(moodSendVisible(s, NOW), true, 'shown during the window');
});

test('ensureMoodOnboarding: an EXISTING install is never locked — pure opt-in (T9)', () => {
  const s = { turnCount: 42, messages: [{ role: 'user', content: 'hi' }] };
  ensureMoodOnboarding(s, NOW);
  assert.equal(moodSendInOnboarding(s.moodSendOnboardedAt, NOW), false, 'past the window — no soft lock');
  assert.equal(s.moodSendEnabled, false, 'opt-in, off by default');
  assert.equal(moodSendVisible(s, NOW), false, 'not shown unless they turn it on');
});

test('ensureMoodOnboarding: idempotent — never restamps an existing value', () => {
  const stamped = NOW - 3 * DAY;
  const s = { turnCount: 0, messages: [], moodSendOnboardedAt: stamped, moodSendEnabled: true };
  ensureMoodOnboarding(s, NOW);
  assert.equal(s.moodSendOnboardedAt, stamped, 'left as-is');
});
