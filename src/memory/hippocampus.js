/**
 * hippocampus.js — the short-term cross-channel memory buffer.
 *
 * The Familiar is one being across web, Discord, and voice, but until a session's
 * memorization runs there's a gap: on web it doesn't know what just happened on
 * Discord ten minutes ago. This is that missing recent-past window — a rolling
 * buffer every surface writes to as things happen, injected into each turn as a
 * short "recently, elsewhere" block so the Familiar carries the last little while
 * across all its presences.
 *
 * It is a pure SHORT-TERM read overlay, NOT a memory store:
 *   • It never drains to Phylactery. Every surface's messages already get
 *     memorized through their own session (now guarded by the memory-integrity
 *     gate, Stage 1) — draining the buffer too would double-count. The buffer
 *     just mirrors the recent past for live context and prunes itself.
 *   • It lives LOCAL to Proto-Familiar (`tomes/.hippocampus.json`, a dotfile,
 *     never a tome, never memorized). It is cross-CHANNEL within this embodiment,
 *     never synced to the canonical self as itself.
 *   • It never feeds identity (ward decision): identity graduates from established
 *     memory + ponderings, never from raw recent input — the least-vetted content
 *     is the last thing that should reach the canonical self.
 *
 * Exact-values discipline: every `ts` is a machine timestamp set on arrival; the
 * relative phrasing ("12 min ago") is computed in code from `ts`, never authored
 * by the model. Non-ward inbound text is run through the injection guard exactly
 * as the live path already does, so the buffer can't smuggle an injection into a
 * later turn's context.
 */

import path from 'path';
import { promises as fsp } from 'fs';

import { REPO_ROOT } from '../../repo-root.js';
import { meaningSlugId } from '../../slug-ids.js';
import { sanitizeExternal } from '../../injection-guard.js';

const DEFAULT_TOMES_DIR = path.join(REPO_ROOT, 'tomes');
const STORE_NAME = '.hippocampus.json';
const storePath = (tomesDir) => path.join(tomesDir, STORE_NAME);

// Retention: how long an event stays in the buffer at all, and a hard count cap
// so a busy day can't grow it without bound. These bound the STORE; the injection
// window below is smaller (only the genuinely-recent past is worth surfacing).
export const HIPPOCAMPUS_RETENTION_MS = 6 * 60 * 60 * 1000;   // 6h
export const HIPPOCAMPUS_MAX_EVENTS = 250;

// Injection window: what "recently, elsewhere" actually shows — the last little
// while, a handful of lines, newest first.
export const RECENT_WINDOW_MS = 90 * 60 * 1000;   // 90min
export const RECENT_MAX_LINES = 8;

const MAX_TEXT = 280;   // one line's worth; the buffer is a gist, not a transcript

async function readStore(tomesDir) {
  try {
    const raw = await fsp.readFile(storePath(tomesDir), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.events) ? data : { events: [] };
  } catch { return { events: [] }; }
}

async function writeStore(tomesDir, data) {
  const file = storePath(tomesDir);
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

// Drop events past the retention window or beyond the count cap (newest kept).
function prune(events, nowMs) {
  const live = events.filter(e => {
    const t = Date.parse(e?.ts ?? '');
    return Number.isFinite(t) && (nowMs - t) <= HIPPOCAMPUS_RETENTION_MS;
  });
  return live.length > HIPPOCAMPUS_MAX_EVENTS ? live.slice(live.length - HIPPOCAMPUS_MAX_EVENTS) : live;
}

/**
 * Record one cross-channel event. Best-effort and BOUNDED — it never throws into
 * a caller on the chat path (a buffer failure must never surface in the human's
 * conversation), so callers can fire-and-forget. Non-ward text is injection-guarded.
 *
 * @param {object} e
 * @param {'web'|'discord'|'voice'} e.surface
 * @param {string|null} e.locationKey  a surface-local key (Discord room key, a web session id) — used to exclude the CURRENT location from its own "elsewhere" block
 * @param {string} e.speaker           display name; 'me' for the Familiar's own line
 * @param {string} e.audienceTag       the event's audience (ward-private / a room's circle)
 * @param {string} e.text
 * @param {boolean} [e.isWard]         true if from my human's own direct words (skips the injection guard, like the live path)
 * @param {Date} [e.now]
 * @param {string} [e.tomesDir]
 */
export async function recordEvent({ surface, locationKey = null, speaker, audienceTag, text, isWard = false, now = new Date(), tomesDir = DEFAULT_TOMES_DIR } = {}) {
  try {
    const clean = String(text ?? '').trim();
    if (!clean) return;
    // Non-ward inbound text is scrubbed exactly like the live inbound seams; my
    // human's own words — and my Familiar's own lines ('me') — are kept verbatim
    // (their own text is trusted and must never be mangled).
    const trusted = isWard || String(speaker || '').trim() === 'me';
    const safe = trusted ? clean : sanitizeExternal(clean, { source: `hippocampus/${surface}`, context: 'hippocampus' });
    const nowMs = now.getTime();
    const data = await readStore(tomesDir);
    data.events = prune(data.events, nowMs);
    data.events.push({
      id: meaningSlugId(clean, { fallbackKind: 'hev' }),
      ts: now.toISOString(),
      surface: String(surface || 'web'),
      locationKey: locationKey ?? null,
      speaker: String(speaker || '').trim() || 'someone',
      audienceTag: String(audienceTag || 'ward-private'),
      text: safe.length > MAX_TEXT ? safe.slice(0, MAX_TEXT - 1) + '…' : safe,
    });
    await writeStore(tomesDir, data);
  } catch { /* the buffer never breaks a turn */ }
}

/**
 * The events to surface as "recently, elsewhere" for the current viewing context.
 * Pure filtering over the stored events. Returns oldest-first (reads as a little
 * timeline), already audience-gated and location-excluded.
 *
 * @param {object} opts
 * @param {Date} [opts.now]
 * @param {boolean} opts.wardView       true = my human's own context → sees everything
 * @param {string[]} [opts.visibleAudiences]  for a gated (villager) view, the audience tags this viewer may see; an event renders only if its tag is in here
 * @param {string|null} [opts.excludeKey]     the CURRENT location's key — its own events are already in the live history, so they're left out
 * @param {number} [opts.withinMs]
 * @param {number} [opts.limit]
 */
export async function recentElsewhere({ now = new Date(), wardView = false, visibleAudiences = [], excludeKey = null, withinMs = RECENT_WINDOW_MS, limit = RECENT_MAX_LINES, tomesDir = DEFAULT_TOMES_DIR } = {}) {
  const nowMs = now.getTime();
  const data = await readStore(tomesDir);
  const visible = new Set(visibleAudiences || []);
  const rows = (data.events || []).filter(e => {
    const t = Date.parse(e?.ts ?? '');
    if (!Number.isFinite(t) || (nowMs - t) > withinMs) return false;          // too old
    if (excludeKey && e.locationKey === excludeKey) return false;              // current location — already in live history
    // Audience gate, fail-closed: my human sees all; a villager sees only tags
    // their circle shares, and NEVER a ward-private event.
    if (!wardView) {
      if (e.audienceTag === 'ward-private') return false;
      if (!visible.has(e.audienceTag)) return false;
    }
    return true;
  });
  // Newest `limit`, returned oldest-first.
  return rows.slice(Math.max(0, rows.length - limit));
}

// "12 min ago" / "just now" / "2 h ago" — computed in code from machine ts.
function agoPhrase(fromMs, nowMs) {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} h ago`;
}

/**
 * Render the recent-elsewhere events as an injected context block, or '' when
 * there's nothing recent to show. Server-injected block → authored in the literal
 * "my human" voice, NO macros (it does not pass through the macro boundaries).
 * Pure: takes the already-filtered events + `now`.
 */
export function buildRecentElsewhereBlock(events, { now = new Date() } = {}) {
  if (!Array.isArray(events) || !events.length) return '';
  const nowMs = now.getTime();
  const lines = events.map(e => {
    const t = Date.parse(e?.ts ?? '');
    const when = Number.isFinite(t) ? agoPhrase(t, nowMs) : 'recently';
    const where = e.surface === 'discord' ? 'on Discord' : e.surface === 'voice' ? 'on a call' : 'on the web';
    const who = e.speaker === 'me' ? 'I said' : `${e.speaker} said`;
    return `- ${when}, ${where}: ${who}: ${e.text}`;
  });
  return `[Recently, elsewhere]\nA little of what's happened across my other conversations lately, so I'm not starting blank here:\n${lines.join('\n')}`;
}
