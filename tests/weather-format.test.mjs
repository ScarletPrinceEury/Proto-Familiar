// weather-format.js — pure formatters, bands, the [Now] line, the honesty rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  wmoToWords, isPrecipCode, isAdverseCode,
  tempBand, precipBand, windBand, formatTemp,
  precipTransition, buildNowWeatherLine, WEATHER_STALE_MS,
} from '../weather-format.js';

const T = (iso) => Date.parse(iso);

// ── code vocabulary ──────────────────────────────────────────────────

test('wmoToWords: known codes and fallback', () => {
  assert.equal(wmoToWords(0), 'clear');
  assert.equal(wmoToWords(61), 'light rain');
  assert.equal(wmoToWords(95), 'thunderstorm');
  assert.equal(wmoToWords(999), 'unsettled');
  assert.equal(wmoToWords(NaN), '');
});

test('isPrecipCode / isAdverseCode', () => {
  assert.equal(isPrecipCode(0), false);   // clear
  assert.equal(isPrecipCode(45), false);  // fog is not precip
  assert.equal(isPrecipCode(61), true);   // rain
  assert.equal(isPrecipCode(71), true);   // snow
  assert.equal(isAdverseCode(61), false); // light rain not adverse
  assert.equal(isAdverseCode(65), true);  // heavy rain
  assert.equal(isAdverseCode(73), true);  // snow
  assert.equal(isAdverseCode(95), true);  // storm
});

// ── bands ─────────────────────────────────────────────────────────────

test('tempBand thresholds', () => {
  assert.equal(tempBand(-3), 'freezing');
  assert.equal(tempBand(6), 'cold');
  assert.equal(tempBand(14), 'mild');
  assert.equal(tempBand(22), 'warm');
  assert.equal(tempBand(30), 'hot');
  assert.equal(tempBand(36), 'very hot');
});

test('precipBand / windBand', () => {
  assert.equal(precipBand(0), 'none');
  assert.equal(precipBand(1), 'light');
  assert.equal(precipBand(5), 'moderate');
  assert.equal(precipBand(10), 'heavy');
  assert.equal(windBand(5), 'calm');
  assert.equal(windBand(20), 'breezy');
  assert.equal(windBand(40), 'windy');
  assert.equal(windBand(60), 'strong wind');
  assert.equal(windBand(90), 'gale');
});

test('formatTemp: value + band, rounded', () => {
  assert.equal(formatTemp(6.4), '6°C (cold)');
  assert.equal(formatTemp(34), '34°C (very hot)');
  assert.equal(formatTemp(NaN), '');
});

// ── precip transition (read off the hourly array) ────────────────────

const hourly = (specs) => specs.map(([time, precip_mm, code]) => ({
  time, precip_mm, weather_code: code ?? (precip_mm > 0 ? 61 : 0),
}));

test('precipTransition: wet now → reports when it eases', () => {
  const now = T('2026-07-11T14:00:00');
  const h = hourly([
    ['2026-07-11T15:00:00', 0.4], ['2026-07-11T16:00:00', 0.2],
    ['2026-07-11T17:00:00', 0], ['2026-07-11T18:00:00', 0],
  ]);
  const tr = precipTransition({ precip_mm: 0.5, weather_code: 61 }, h, now);
  assert.deepEqual(tr, { kind: 'easing', at: '17:00' });
});

test('precipTransition: dry now → reports when rain starts', () => {
  const now = T('2026-07-11T14:00:00');
  const h = hourly([
    ['2026-07-11T15:00:00', 0], ['2026-07-11T16:00:00', 0],
    ['2026-07-11T17:00:00', 1.0], ['2026-07-11T18:00:00', 1.0],
  ]);
  const tr = precipTransition({ precip_mm: 0, weather_code: 3 }, h, now);
  assert.deepEqual(tr, { kind: 'starting', at: '17:00' });
});

test('precipTransition: no change within lookahead → none', () => {
  const now = T('2026-07-11T14:00:00');
  const h = hourly([['2026-07-11T15:00:00', 0], ['2026-07-11T16:00:00', 0]]);
  assert.equal(precipTransition({ precip_mm: 0, weather_code: 0 }, h, now).kind, 'none');
});

// ── the [Now] line + honesty rule ────────────────────────────────────

test('buildNowWeatherLine: full line with easing', () => {
  const now = T('2026-07-11T14:00:00');
  const mirror = {
    fetched_at: '2026-07-11T13:30:00',
    current: { temp_c: 6, weather_code: 61, precip_mm: 0.4, wind_kmh: 12 },
    hourly: hourly([['2026-07-11T15:00:00', 0.2], ['2026-07-11T17:00:00', 0]]),
  };
  const line = buildNowWeatherLine(mirror, { now });
  assert.match(line, /^Weather where my human is: 6°C \(cold\), light rain, easing off around 17:00\.$/);
});

test('buildNowWeatherLine: strong wind is surfaced, calm is not', () => {
  const now = T('2026-07-11T14:00:00');
  const base = { fetched_at: '2026-07-11T13:30:00', hourly: [] };
  const windy = buildNowWeatherLine({ ...base, current: { temp_c: 10, weather_code: 3, precip_mm: 0, wind_kmh: 60 } }, { now });
  assert.match(windy, /strong wind/);
  const calm = buildNowWeatherLine({ ...base, current: { temp_c: 10, weather_code: 3, precip_mm: 0, wind_kmh: 8 } }, { now });
  assert.doesNotMatch(calm, /wind/);
});

test('buildNowWeatherLine: STALE forecast → empty (honesty rule)', () => {
  const now = T('2026-07-12T14:00:00');
  const mirror = {
    fetched_at: '2026-07-11T13:30:00',   // ~24h old, past the 12h staleness
    current: { temp_c: 6, weather_code: 61 },
    hourly: [],
  };
  assert.equal(buildNowWeatherLine(mirror, { now }), '');
  // Just inside the window renders.
  const fresh = buildNowWeatherLine({ ...mirror, fetched_at: new Date(now - WEATHER_STALE_MS + 60_000).toISOString() }, { now });
  assert.notEqual(fresh, '');
});

test('buildNowWeatherLine: missing/garbage → empty', () => {
  assert.equal(buildNowWeatherLine(null, {}), '');
  assert.equal(buildNowWeatherLine({}, {}), '');
  assert.equal(buildNowWeatherLine({ fetched_at: 'x', current: {} }, {}), '');
  assert.equal(buildNowWeatherLine({ fetched_at: new Date().toISOString(), current: { temp_c: 'nope' } }, {}), '');
});
