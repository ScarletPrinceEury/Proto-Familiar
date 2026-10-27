/**
 * promise-time.js — when a promise I made in chat should come back to me.
 *
 * I say things like "I'll do that tonight" or "tomorrow morning I'll check".
 * Code turns those words into a real local time, worked out from WHEN I SAID
 * IT, never from when the promise was caught: a promise said Monday at 18:03
 * and only picked up at 00:05 still means Monday evening. The model only names
 * the words (a day, a part of the day, maybe a clock time it heard); every date
 * and time here is computed in code (CLAUDE.md: the LLM is not a source of
 * exact machine values).
 *
 * Times are Unruh's local-naive ISO ("YYYY-MM-DDTHH:MM:SS", my human's wall
 * clock). The arithmetic treats them as UTC so the server's own zone never
 * leaks in; a DST change can shift a result by an hour, the same bounded
 * trade-off Unruh documents. Pure.
 *
 * Conventions (plain clock times, not routine-phase names, because phase names
 * are personal: an "Evening Wind-Down" can start at 22:00):
 * - Before 05:00 still counts as the night before. Said at 00:30, "tonight"
 *   means now and "tomorrow" means the coming day.
 * - morning 08:00, afternoon 12:00, evening 17:00, night 20:00.
 * - "soon" is 30 minutes after I said it. No time on the same day is 2 hours
 *   after. A later day with no time is that day's morning.
 * - A time that had already come when I said it ("tonight", said at 18:03) is
 *   30 minutes after I said it.
 */

export const DAY_START_HOUR = 5;
export const PART_START = Object.freeze({ morning: '08:00', afternoon: '12:00', evening: '17:00', night: '20:00' });
export const SOON_MS     = 30 * 60_000;
export const SAME_DAY_MS = 2 * 60 * 60_000;

const DAY_MS   = 24 * 60 * 60_000;
const MIN_MS   = 60_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_LC = WEEKDAYS.map(d => d.toLowerCase());
const MONTHS   = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS     = new Set(['today', 'tomorrow', 'next_contact', ...WEEKDAYS_LC]);
const PARTS    = new Set(['soon', 'morning', 'afternoon', 'evening', 'night']);
const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;
const CLOCK_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** A local-naive ISO string as arithmetic ms (NaN when it isn't one). */
export function naiveMs(s) {
  const m = NAIVE_RE.exec(String(s ?? ''));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

/** Arithmetic ms back to a local-naive ISO string. */
export function msNaive(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const midnight = (ms) => ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS);
const clockMs  = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return (h * 60 + m) * MIN_MS; };
const dateOf   = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const weekday  = (ms) => WEEKDAYS[new Date(ms).getUTCDay()];

/** "Monday 26 Oct" */
export function dayLabel(ms) { return `${weekday(ms)} ${dateOf(ms)}`; }

/** "Monday 26 Oct, 18:03" for a local-naive ISO string ('' when unparseable). */
export function naiveLabel(s) {
  const ms = naiveMs(s);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${dayLabel(ms)}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Midnight of the day a moment belongs to: before 05:00 it's the day before. */
export function effectiveDayMs(ms) {
  const day = midnight(ms);
  return (ms - day) < DAY_START_HOUR * 60 * MIN_MS ? day - DAY_MS : day;
}

/**
 * The model's words for when, reduced to the fixed vocabulary. Anything else
 * reads as "none", and a clock time is kept only when it's a real HH:MM.
 * Returns { day, part, time } with time 'HH:MM' or null.
 */
export function normalizeWhen(raw = {}) {
  const w  = (raw && typeof raw === 'object') ? raw : {};
  const lc = (v) => String(v ?? '').trim().toLowerCase();
  let day  = lc(w.day);
  let part = lc(w.part);
  if (day === 'tonight') { day = 'today'; if (!PARTS.has(part)) part = 'evening'; }
  if (part === 'tonight') part = 'evening';
  if (!DAYS.has(day)) day = 'none';
  if (!PARTS.has(part)) part = 'none';
  const t = CLOCK_RE.exec(String(w.time ?? '').trim());
  return { day, part, time: t ? `${t[1].padStart(2, '0')}:${t[2]}` : null };
}

// A clock time on a day. A time before 05:00 belongs to that day's night, so it
// falls on the next calendar date ("Monday at 01:00" is early Tuesday).
function clockOn(dayMidnight, hhmm) {
  const off = clockMs(hhmm);
  return dayMidnight + (off < DAY_START_HOUR * 60 * MIN_MS ? DAY_MS : 0) + off;
}

function forLabel(kind, target, w) {
  if (kind === 'time') return `${dayLabel(target)} at ${w.time}`;
  if (kind === 'part') return `${weekday(target)} ${w.part} (${dateOf(target)})`;
  if (kind === 'soon') return `${dayLabel(target)}, soon after I said it`;
  if (kind === 'later') return `later on ${dayLabel(target)}`;
  return dayLabel(target);
}

/**
 * When a promise comes back to me.
 *   when   — { day, part, time } in the model's words (normalised here)
 *   saidAt — local-naive ISO of the message I said it in
 *   now    — local-naive ISO of right now (defaults to saidAt)
 * Returns null when saidAt isn't a time, else:
 *   { kind: 'at', at, late, forLabel, saidLabel }   at = local-naive ISO
 *   { kind: 'on_next_contact', late: false, forLabel, saidLabel }
 * `late` means the time had already passed by `now`: the promise is due at once.
 */
export function resolvePromiseTime(when, saidAt, now = saidAt) {
  const saidMs = naiveMs(saidAt);
  if (!Number.isFinite(saidMs)) return null;
  const nowMs = Number.isFinite(naiveMs(now)) ? naiveMs(now) : saidMs;
  const saidLabel = naiveLabel(saidAt);
  const w = normalizeWhen(when);
  if (w.day === 'next_contact') return { kind: 'on_next_contact', late: false, forLabel: 'the next time we talk', saidLabel };

  const eff = effectiveDayMs(saidMs);
  let target = eff;
  if (w.day === 'tomorrow') target = eff + DAY_MS;
  else if (WEEKDAYS_LC.includes(w.day)) {
    const ahead = (WEEKDAYS_LC.indexOf(w.day) - new Date(eff).getUTCDay() + 7) % 7;
    target = eff + ahead * DAY_MS;
  }
  const sameDay = target === eff;

  let kind, atMs;
  if (w.time) { kind = 'time'; atMs = clockOn(target, w.time); }
  else if (w.part !== 'none' && w.part !== 'soon') { kind = 'part'; atMs = clockOn(target, PART_START[w.part]); }
  else if (sameDay) { kind = w.part === 'soon' ? 'soon' : 'later'; atMs = saidMs + (w.part === 'soon' ? SOON_MS : SAME_DAY_MS); }
  else { kind = 'day'; atMs = clockOn(target, PART_START.morning); }
  // Its time had already come when I said it ("tonight", said in the evening).
  if (atMs <= saidMs) atMs = saidMs + SOON_MS;

  return { kind: 'at', at: msNaive(atMs), late: atMs < nowMs, forLabel: forLabel(kind, target, w), saidLabel };
}

/**
 * The same text with relative day words pinned to the day I said it, so a
 * stored note never carries a bare "tonight" that a later read takes for a
 * different night. "first pass tonight" said Monday → "first pass Monday
 * night (26 Oct)". Weekday names and clock times are left as they are.
 */
export function anchorRelativeWords(text, saidAt) {
  const s = String(text ?? '');
  const saidMs = naiveMs(saidAt);
  if (!s || !Number.isFinite(saidMs)) return s;
  const eff = effectiveDayMs(saidMs);
  const part = (ms, p) => `${weekday(ms)} ${p.toLowerCase()} (${dateOf(ms)})`;
  return s
    .replace(/\btomorrow (morning|afternoon|evening|night)\b/gi, (_m, p) => part(eff + DAY_MS, p))
    .replace(/\bthis (morning|afternoon|evening)\b/gi, (_m, p) => part(eff, p))
    .replace(/\btonight\b/gi, () => part(eff, 'night'))
    .replace(/\blater today\b/gi, () => `later on ${dayLabel(eff)}`)
    .replace(/\btoday\b/gi, () => dayLabel(eff))
    .replace(/\btomorrow\b/gi, () => dayLabel(eff + DAY_MS))
    .replace(/\byesterday\b/gi, () => dayLabel(eff - DAY_MS));
}
