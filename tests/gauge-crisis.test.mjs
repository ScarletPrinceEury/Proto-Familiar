// Gauge safety ladder — G-C.2 (the TEETH). SAFETY-CRITICAL, ward-signed.
// Invariant G1 (check-first) is enforced behaviourally here; these tests are
// its proof: no open check → no teeth; open-but-within-deadline → no teeth;
// only an open check past its active-hours deadline escalates, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  selectGaugeEscalations, deadlineMsFor, quietConfigFromSettings,
  buildGaugeCrisisReason, buildGaugeContactMessage, runGaugeCrisisTick,
  DEFAULT_DEADLINE_HOURS,
} from '../src/schedule/gauge-crisis.js';

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
// Quiet DISABLED (start===end) → active time == wall-clock elapsed, so the
// pipeline is deterministic regardless of machine zone. (The quiet-hours math
// itself is proven in active-hours.test.mjs.)
const SETTINGS = { warmthQuietHoursStart: 9, warmthQuietHoursEnd: 9, userName: 'Robin' };
const esc = (extra = {}) => ({ enabled: true, checkin_deadline_hours: 6, ...extra });
const gauge = (id, band, escalation = esc()) => ({ id, label: id, band, hours_since: 60, escalation });

// ── deadlineMsFor / quietConfigFromSettings (pure helpers) ────────────────────
test('deadlineMsFor: uses checkin_deadline_hours; safe default when absent/invalid', () => {
  assert.equal(deadlineMsFor({ checkin_deadline_hours: 6 }), 6 * HOUR);
  assert.equal(deadlineMsFor({ checkin_deadline_hours: 0 }), DEFAULT_DEADLINE_HOURS * HOUR);
  assert.equal(deadlineMsFor({}), DEFAULT_DEADLINE_HOURS * HOUR);        // fail-safe-slow, not instant
  assert.equal(deadlineMsFor(undefined), DEFAULT_DEADLINE_HOURS * HOUR);
});

test('quietConfigFromSettings: normalizes like isWarmthQuietHours', () => {
  assert.deepEqual(quietConfigFromSettings({ warmthQuietHoursStart: 22, warmthQuietHoursEnd: 7, wardTimeZone: 'Europe/Berlin' }),
    { quietStart: 22, quietEnd: 7, tz: 'Europe/Berlin' });
  assert.deepEqual(quietConfigFromSettings({}), { quietStart: 23, quietEnd: 8, tz: null });          // defaults
  assert.deepEqual(quietConfigFromSettings({ warmthQuietHoursStart: 99 }), { quietStart: 23, quietEnd: 8, tz: null }); // clamp bad
});

// ── selectGaugeEscalations (pure) — the G1 gate ───────────────────────────────
const quiet = quietConfigFromSettings(SETTINGS);

test('G1: no open check → NO escalation, ever', () => {
  const actions = selectGaugeEscalations({ candidates: [gauge('water', 'extreme')], checkState: {}, quiet, now: NOW });
  assert.equal(actions.length, 0);
});

test('G1: open check but within the deadline → no escalation', () => {
  const checkState = { water: { checkOpenedAt: NOW - 1 * HOUR } };   // 1h < 6h deadline
  const actions = selectGaugeEscalations({ candidates: [gauge('water', 'extreme')], checkState, quiet, now: NOW });
  assert.equal(actions.length, 0);
});

test('open check past the active-hours deadline → escalate', () => {
  const checkState = { water: { checkOpenedAt: NOW - 7 * HOUR } };   // 7h ≥ 6h
  const actions = selectGaugeEscalations({ candidates: [gauge('water', 'extreme')], checkState, quiet, now: NOW });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, 'water');
  assert.ok(actions[0].activeMs >= actions[0].deadlineMs);
});

test('already escalated → no re-escalation (once per open check)', () => {
  const checkState = { water: { checkOpenedAt: NOW - 7 * HOUR, escalatedAt: NOW - 1 * HOUR } };
  const actions = selectGaugeEscalations({ candidates: [gauge('water', 'extreme')], checkState, quiet, now: NOW });
  assert.equal(actions.length, 0);
});

test('band recovered (not extreme) → no escalation even with an open check', () => {
  const checkState = { water: { checkOpenedAt: NOW - 7 * HOUR } };
  const actions = selectGaugeEscalations({ candidates: [gauge('water', 'low')], checkState, quiet, now: NOW });
  assert.equal(actions.length, 0);
});

// ── message builders (code-owned, exact values) ───────────────────────────────
test('buildGaugeCrisisReason: tagged gauge-critical; names the contact when set', () => {
  assert.match(buildGaugeCrisisReason({ label: 'Water', hours_since: 60 }), /^gauge-critical:/);
  assert.match(buildGaugeCrisisReason({ label: 'Water', hours_since: 60, contactName: 'Sam' }), /Alerting Sam/);
});

test('buildGaugeContactMessage: first-person, names the ward, never leaks a macro', () => {
  const m = buildGaugeContactMessage({ label: 'meds', hours_since: 60, wardName: 'Robin' });
  assert.match(m, /I'm Robin's Familiar/);
  assert.doesNotMatch(m, /\{\{user\}\}/);
  // No-name fallback still never leaks a placeholder.
  assert.doesNotMatch(buildGaugeContactMessage({ label: 'meds', hours_since: 60 }), /\{\{user\}\}|undefined/);
});

// ── runGaugeCrisisTick (pipeline) ─────────────────────────────────────────────
function harness({ candidates, state, flagImpl, contactImpl } = {}) {
  const flags = [], contacts = [];
  let written = null;
  const deps = {
    now: NOW,
    candidates,
    readState:   async () => structuredClone(state ?? {}),
    writeState:  async (next) => { written = next; },
    readSettings: () => SETTINGS,
    flag:        flagImpl   ?? (async (a) => { flags.push(a); return { ok: true, flagged: true, tier: 'severe' }; }),
    deliverContact: contactImpl ?? (async (a) => { contacts.push(a); return { ok: true }; }),
    enabled: true,
  };
  return { deps, flags, contacts, get written() { return written; } };
}

test('disabled → no-op, no flag', async () => {
  const h = harness({ candidates: [gauge('water', 'extreme')], state: { water: { checkOpenedAt: NOW - 7 * HOUR } } });
  const r = await runGaugeCrisisTick({ ...h.deps, enabled: false });
  assert.equal(r.reason, 'disabled');
  assert.equal(h.flags.length, 0);
});

test('no open check → no flag, no contact', async () => {
  const h = harness({ candidates: [gauge('water', 'extreme')], state: {} });
  const r = await runGaugeCrisisTick(h.deps);
  assert.equal(r.escalated, 0);
  assert.equal(h.flags.length, 0);
  assert.equal(h.contacts.length, 0);
});

test('past deadline, no contact opt-in → flags once (gauge-critical), stamps, no contact', async () => {
  const h = harness({ candidates: [gauge('water', 'extreme')], state: { water: { checkOpenedAt: NOW - 7 * HOUR } } });
  const r = await runGaugeCrisisTick(h.deps);
  assert.equal(r.escalated, 1);
  assert.equal(h.flags.length, 1);
  assert.match(h.flags[0].reason, /^gauge-critical:/);
  assert.equal(h.contacts.length, 0);                       // contact is opt-in
  assert.ok(Number.isFinite(h.written.water.escalatedAt));  // stamped once
});

test('past deadline, contact opt-in → flag + trusted-contact reach with the named contact', async () => {
  const gc = gauge('meds', 'extreme', esc({ contact: true, contact_id: 'Sam' }));
  const h = harness({ candidates: [gc], state: { meds: { checkOpenedAt: NOW - 7 * HOUR } } });
  const r = await runGaugeCrisisTick(h.deps);
  assert.equal(r.escalated, 1);
  assert.equal(r.contacted, 1);
  assert.equal(h.contacts.length, 1);
  assert.equal(h.contacts[0].name, 'Sam');
  assert.match(h.contacts[0].message, /Familiar/);
  // The flag reason records who is being alerted (audit legibility).
  assert.match(h.flags[0].reason, /Alerting Sam/);
});

test('re-running after an escalation does not re-flag (escalatedAt dedup)', async () => {
  const h = harness({ candidates: [gauge('water', 'extreme')], state: { water: { checkOpenedAt: NOW - 7 * HOUR, escalatedAt: NOW - 60_000 } } });
  const r = await runGaugeCrisisTick(h.deps);
  assert.equal(r.escalated, 0);
  assert.equal(h.flags.length, 0);
});

test('flag THROWS → check left un-stamped so the raise retries; contact not attempted', async () => {
  const gc = gauge('water', 'extreme', esc({ contact: true, contact_id: 'Sam' }));
  const h = harness({
    candidates: [gc], state: { water: { checkOpenedAt: NOW - 7 * HOUR } },
    flagImpl: async () => { throw new Error('threat store down'); },
  });
  const r = await runGaugeCrisisTick(h.deps);
  assert.equal(r.escalated, 0);
  assert.equal(h.contacts.length, 0);                        // never contact without the raise
  assert.ok(!h.written.water.escalatedAt);                   // un-stamped → retry next tick
});

test('contact THROWS → the flag still stands and the tick does not crash', async () => {
  const gc = gauge('meds', 'extreme', esc({ contact: true, contact_id: 'Sam' }));
  const h = harness({
    candidates: [gc], state: { meds: { checkOpenedAt: NOW - 7 * HOUR } },
    contactImpl: async () => { throw new Error('webhook 500'); },
  });
  const r = await runGaugeCrisisTick(h.deps);
  assert.equal(r.escalated, 1);
  assert.equal(r.contacted, 0);
  assert.ok(Number.isFinite(h.written.meds.escalatedAt));    // flag stamped; contact failure is logged, not fatal
});

test('unruh unavailable (fetch throws) → graceful no-op', async () => {
  const r = await runGaugeCrisisTick({
    now: NOW, enabled: true,
    fetchCandidates: async () => { throw new Error('mcp down'); },
    readState: async () => ({}), writeState: async () => {}, readSettings: () => SETTINGS,
    flag: async () => ({ ok: true }), deliverContact: async () => ({ ok: true }),
  });
  assert.equal(r.reason, 'unruh-unavailable');
});

// ── structural: the crisis calls are isolated to THIS module ──────────────────
test('G-C.2 crisis calls live only in gauge-crisis.js (check module stays clean)', () => {
  const crisis = readFileSync(new URL('../src/schedule/gauge-crisis.js', import.meta.url), 'utf8');
  assert.match(crisis, /flagDistress/);                    // the teeth are here
  assert.match(crisis, /deliverToTrustedContact/);
  const check = readFileSync(new URL('../src/schedule/gauge-escalation.js', import.meta.url), 'utf8');
  assert.ok(!check.includes('flagDistress') && !check.includes('deliverToTrustedContact'), 'check module has no crisis calls');
});
