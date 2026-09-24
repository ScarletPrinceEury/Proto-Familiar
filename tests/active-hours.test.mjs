// Active-hours accounting — the quiet-hours-aware deadline math (gauge G-C.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQuietHour, activeMsInInterval, ACTIVE_STEP_MS } from '../src/schedule/active-hours.js';

const HOUR = 60 * 60_000;

// ── isQuietHour ───────────────────────────────────────────────────────────────
test('isQuietHour: midnight-wrapping window (23→08)', () => {
  for (const h of [23, 0, 3, 7]) assert.ok(isQuietHour(h, 23, 8), `${h} should be quiet`);
  for (const h of [8, 12, 22]) assert.ok(!isQuietHour(h, 23, 8), `${h} should be active`);
});

test('isQuietHour: non-wrapping window (01→06) and disabled (start===end)', () => {
  assert.ok(isQuietHour(3, 1, 6));
  assert.ok(!isQuietHour(7, 1, 6));
  assert.ok(!isQuietHour(3, 9, 9));   // start===end → never quiet
});

// ── activeMsInInterval ────────────────────────────────────────────────────────
// A deterministic hourAt seam: ward-local hour advances with real elapsed time
// from a fixed epoch anchored at hour 0. Lets us assert exact active spans
// without depending on the machine zone.
const anchor = Date.UTC(2026, 0, 1, 0, 0, 0);           // treat as ward-local 00:00
const hourAt = (ts) => Math.floor(((ts - anchor) / HOUR) % 24 + 24) % 24;

test('non-positive / invalid intervals → 0', () => {
  assert.equal(activeMsInInterval(100, 100, { hourAt }), 0);
  assert.equal(activeMsInInterval(200, 100, { hourAt }), 0);
  assert.equal(activeMsInInterval(NaN, 100, { hourAt }), 0);
});

test('a fully-active interval (all daytime) counts every ms', () => {
  // 09:00 → 12:00, quiet 23→08: entirely active.
  const start = anchor + 9 * HOUR;
  const end   = anchor + 12 * HOUR;
  const active = activeMsInInterval(start, end, { quietStart: 23, quietEnd: 8, hourAt });
  assert.ok(Math.abs(active - 3 * HOUR) <= ACTIVE_STEP_MS, `≈3h active, got ${active / HOUR}h`);
});

test('a fully-quiet interval (all night) counts ~0', () => {
  // 00:00 → 06:00, quiet 23→08: entirely quiet.
  const active = activeMsInInterval(anchor, anchor + 6 * HOUR, { quietStart: 23, quietEnd: 8, hourAt });
  assert.ok(active <= ACTIVE_STEP_MS, `≈0 active, got ${active / HOUR}h`);
});

test('a check opened at bedtime does not accrue active time overnight, then does at dawn', () => {
  // Opened 22:00; quiet 23→08. From 22:00 to next 08:00 only 22:00–23:00 is
  // active (~1h). Extending to 11:00 adds the full 08:00–11:00 (~3h) → ~4h.
  const opened = anchor + 22 * HOUR;
  const overnight = activeMsInInterval(opened, anchor + 32 * HOUR, { quietStart: 23, quietEnd: 8, hourAt }); // → 08:00
  assert.ok(Math.abs(overnight - 1 * HOUR) <= ACTIVE_STEP_MS, `≈1h active overnight, got ${overnight / HOUR}h`);
  const toMorning = activeMsInInterval(opened, anchor + 35 * HOUR, { quietStart: 23, quietEnd: 8, hourAt }); // → 11:00
  assert.ok(Math.abs(toMorning - 4 * HOUR) <= ACTIVE_STEP_MS, `≈4h active by 11:00, got ${toMorning / HOUR}h`);
});

test('capMs short-circuits the walk once reached', () => {
  // Over a long daytime span, capping at 2h returns ~2h (never the full span).
  const start = anchor + 8 * HOUR;
  const end   = anchor + 20 * HOUR;                        // 12 daytime hours
  const capped = activeMsInInterval(start, end, { quietStart: 23, quietEnd: 8, capMs: 2 * HOUR, hourAt });
  assert.ok(capped >= 2 * HOUR && capped <= 2 * HOUR + ACTIVE_STEP_MS, `≈2h (cap), got ${capped / HOUR}h`);
});

test('start===end disables the quiet window → whole interval active', () => {
  const active = activeMsInInterval(anchor, anchor + 6 * HOUR, { quietStart: 9, quietEnd: 9, hourAt });
  assert.ok(Math.abs(active - 6 * HOUR) <= ACTIVE_STEP_MS, `≈6h active (no quiet), got ${active / HOUR}h`);
});
