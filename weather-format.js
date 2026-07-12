/**
 * weather-format.js — code speaks the weather (Weather sense, Session W-A).
 *
 * Pure formatters. Every value the model reads about weather is turned into
 * words HERE — temperatures, precipitation, wind all carry a code-derived
 * qualitative band ("6°C (cold)", "light rain"), and the times ("easing off
 * around 17:00") are read off the forecast's own hourly array, never computed
 * by the model. This is the exact-machine-values rule applied to weather; the
 * plainInterval precedent is the shape.
 *
 * Internal forecast shape (what the fetch half normalises everything to):
 *   current: { temp_c, weather_code, precip_mm, wind_kmh }
 *   hourly:  [ { time: local-naive ISO, temp_c, weather_code, precip_mm,
 *               precip_prob, wind_kmh } ]  (next ~48h, ascending)
 * WMO weather codes throughout (Open-Meteo native; the MET-Norway adapter
 * maps its symbol_codes onto these).
 */

// How stale a cached forecast may be before it stops speaking as "now"
// (honesty rule — the baselines precedent: no data beats wrong data).
export const WEATHER_STALE_MS = 12 * 60 * 60_000;   // 12h
// How far ahead a precipitation-transition phrase may reach.
const TRANSITION_LOOKAHEAD_MS = 12 * 60 * 60_000;

// ── WMO weather codes → words ────────────────────────────────────────
const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'heavy showers',
  85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
};
export function wmoToWords(code) {
  return WMO[code] ?? (Number.isFinite(code) ? 'unsettled' : '');
}
// Precipitation-bearing codes (drizzle and up; fog excluded — it isn't precip).
export function isPrecipCode(code) {
  return (code >= 51 && code <= 67) || (code >= 71 && code <= 86) || (code >= 95 && code <= 99);
}
// Codes we call genuinely adverse (for the W-B severe-weather join; defined
// here with the rest of the code vocabulary): heavy rain, freezing rain, any
// snow, heavy showers, thunderstorms.
const ADVERSE_CODES = new Set([65, 66, 67, 71, 73, 75, 77, 82, 85, 86, 95, 96, 99]);
export function isAdverseCode(code) {
  return ADVERSE_CODES.has(code);
}

// ── Qualitative bands (fixed, code-owned) ────────────────────────────
export function tempBand(c) {
  if (!Number.isFinite(c)) return '';
  if (c < 0)  return 'freezing';
  if (c < 10) return 'cold';
  if (c < 18) return 'mild';
  if (c < 26) return 'warm';
  if (c <= 32) return 'hot';
  return 'very hot';
}
export function precipBand(mmPerH) {
  if (!Number.isFinite(mmPerH) || mmPerH <= 0) return 'none';
  if (mmPerH < 2.5) return 'light';
  if (mmPerH < 7.6) return 'moderate';
  return 'heavy';
}
export function windBand(kmh) {
  if (!Number.isFinite(kmh)) return '';
  if (kmh < 12) return 'calm';
  if (kmh < 29) return 'breezy';
  if (kmh < 50) return 'windy';
  if (kmh < 75) return 'strong wind';
  return 'gale';
}

// ── Value renderers (value + band, machine-formatted) ────────────────
export function formatTemp(c) {
  if (!Number.isFinite(c)) return '';
  const band = tempBand(c);
  return `${Math.round(c)}°C${band ? ` (${band})` : ''}`;
}

function hhmm(iso) {
  const m = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/.exec(String(iso) || '');
  return m ? `${m[1]}:${m[2]}` : '';
}

// ── Precipitation transition (read off the hourly array) ─────────────
/**
 * Given the hourly forecast and "now", find the next change in whether it's
 * raining/snowing. Returns { kind: 'easing'|'starting'|'none', at: 'HH:MM' }.
 * Pure — `now` is passed in. A wet-now forecast reports when it eases; a
 * dry-now forecast reports when precip is likely to start; capped to the
 * look-ahead so we never say "easing off" 30h out.
 */
export function precipTransition(current, hourly, now = Date.now()) {
  const arr = Array.isArray(hourly) ? hourly : [];
  const wetNow = (Number(current?.precip_mm) > 0) || isPrecipCode(current?.weather_code);
  const limit = now + TRANSITION_LOOKAHEAD_MS;
  const future = arr
    .map(h => ({ ...h, ms: Date.parse(h?.time) }))
    .filter(h => Number.isFinite(h.ms) && h.ms > now && h.ms <= limit)
    .sort((a, b) => a.ms - b.ms);
  const isWet = (h) => (Number(h.precip_mm) > 0) || isPrecipCode(h.weather_code);
  for (const h of future) {
    if (wetNow && !isWet(h)) return { kind: 'easing', at: hhmm(h.time) };
    if (!wetNow && isWet(h)) return { kind: 'starting', at: hhmm(h.time) };
  }
  return { kind: 'none', at: '' };
}

// ── The [Now] weather line ───────────────────────────────────────────
/**
 * The single line the [Now] block carries: "Weather where my human is: 6°C
 * (cold), light rain, easing off around 17:00." Returns '' when there's no
 * usable/fresh forecast (absence renders as absence). `mirror` is the
 * read-mirror shape { fetched_at, current, hourly }.
 */
export function buildNowWeatherLine(mirror, { now = Date.now() } = {}) {
  if (!mirror || typeof mirror !== 'object') return '';
  const fetchedMs = Date.parse(mirror.fetched_at);
  if (!Number.isFinite(fetchedMs) || (now - fetchedMs) > WEATHER_STALE_MS) return '';
  const cur = mirror.current;
  if (!cur || !Number.isFinite(Number(cur.temp_c))) return '';

  const parts = [];
  parts.push(formatTemp(Number(cur.temp_c)));
  const words = wmoToWords(cur.weather_code);
  if (words) parts.push(words);
  const wb = windBand(Number(cur.wind_kmh));
  if (wb === 'strong wind' || wb === 'gale') parts.push(wb);

  const tr = precipTransition(cur, mirror.hourly, now);
  let tail = '';
  if (tr.kind === 'easing' && tr.at)   tail = `, easing off around ${tr.at}`;
  else if (tr.kind === 'starting' && tr.at) tail = `, rain likely from around ${tr.at}`;

  return `Weather where my human is: ${parts.join(', ')}${tail}.`;
}
