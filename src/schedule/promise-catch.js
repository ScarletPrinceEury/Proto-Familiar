/**
 * promise-catch.js — a promise I make in chat gets a real intention behind it.
 *
 * When I told someone "I'll do that tonight", nothing backed it. The
 * memorization pass caught it as a timeless follow-up hours later, once the
 * session had sat idle for six hours, and only a future chat would ever show it
 * to me, so "tonight" came and went (seen 2026-10-26).
 *
 * Two ways in, one backing:
 * - Right after a turn (catchPromisesAfterTurn). Code checks my reply for a
 *   promise with a time word ("I'll … tonight", "tomorrow I'll …"). Only then,
 *   and only if I didn't set an intention or a schedule item that turn, one
 *   small call reads that single exchange and names each promise and its when.
 * - The memorization pass, as the backstop for promises the check misses
 *   (memorization.js → backPromises), deduped against what I already hold.
 * Both go through backPromise. Code works out the time from when I SAID it
 * (promise-time.js), pins relative words like "tonight" to that day, and keeps
 * it as a timed Unruh intention (source 'promise'), so noticing brings it back
 * to me when it's due. A promise whose time had already passed is due at once,
 * with a line saying when the app picked it up.
 *
 * My human's own room only: their web chat, the Claude Code bridge (which runs
 * through it) and their Discord DM. Same switch as follow-ups (`followupsEnabled`,
 * PROTO_FAMILIAR_FOLLOWUPS_DISABLED=1). Never throws into the chat path. Every
 * catch that gets as far as a decision lands in logs/promise-events.jsonl. When
 * Unruh is down or my open-intention cap is full, the promise is kept as a
 * follow-up in my tome instead, so it isn't lost.
 */
import path from 'path';
import { promises as fsp } from 'fs';
import { setIntention, listIntentions } from '../../thalamus.js';
import { createSessionFollowup, normalizeFollowupText } from '../memory/recent-ponderings.js';
import { readSettingsSync, connectionForFeature, openOneShots } from '../../cerebellum.js';
import { connectionReady, resolveReasoningEffort } from '../../providers.js';
import { callProviderChat, familiarDeliberationMessages } from '../../llm-call.js';
import { substituteMacros } from '../../macros.js';
import { wardLocalNowISO } from '../../relative-time.js';
import { stripLlmTimestamps } from '../../message-sanitize.mjs';
import { stripDsmlToolCalls } from '../util/text-tool-calls.js';
import { normalizeWhen, resolvePromiseTime, anchorRelativeWords, naiveLabel } from './promise-time.js';
import { PROMISE_SOURCE } from './promise-source.js';
import { REPO_ROOT } from '../../repo-root.js';

export { PROMISE_SOURCE };

const LOG_FILE = path.join(REPO_ROOT, 'logs', 'promise-events.jsonl');
export const MAX_PROMISES = 5;
const HEARD_CAP  = 2000;
const REPLY_HEAD = 1500;
const REPLY_TAIL = 4500;

// Tools that already make a promise real. If I used one this turn, I backed it
// myself and there's nothing to catch.
export const BACKING_TOOLS = new Set(['intention_set', 'schedule_add_reminder', 'schedule_add_task', 'schedule_add_event']);

/** The switch: the env kill-switch wins, then my human's `followupsEnabled` (default on). */
export function promisesEnabled(settings) {
  if (process.env.PROTO_FAMILIAR_FOLLOWUPS_DISABLED === '1') return false;
  return settings?.followupsEnabled !== false;
}

// ── The cheap check ──────────────────────────────────────────────────

const SAY_RE = /\b(?:i['’]ll|i will|i['’]m going to|i am going to|i['’]m gonna|i shall|let me|i plan to|i mean to)\b/i;
const DAYNAME = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
const WHEN_RE = new RegExp([
  'tonight', 'tomorrow', 'later', 'soon', 'next time', 'next week', 'first thing', 'end of (?:the )?day',
  'this (?:morning|afternoon|evening|week|weekend)',
  'in (?:a|an|\\d+|a few|a couple of) (?:bit|while|moment|minutes?|hours?|days?)',
  DAYNAME,
  'at \\d{1,2}(?::\\d{2})?(?:\\s*(?:am|pm))?',
  'after (?:dinner|lunch|breakfast|work|that|this)',
].map(p => `\\b${p}\\b`).join('|'), 'i');

/** True when one sentence of the reply both promises ("I'll", "let me") and names a later time. */
export function promiseCue(text) {
  const s = stripDsmlToolCalls(String(text ?? ''));
  return s.split(/(?<=[.!?])\s+|\n+/).some(line => SAY_RE.test(line) && WHEN_RE.test(line));
}

// ── The small call ───────────────────────────────────────────────────

const clip = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n)} …` : t; };
// Promises tend to come at the end of a reply, so a long one keeps its tail.
const clipReply = (s) => {
  const t = String(s ?? '').trim();
  return t.length > REPLY_HEAD + REPLY_TAIL ? `${t.slice(0, REPLY_HEAD)}\n…\n${t.slice(-REPLY_TAIL)}` : t;
};

export function buildPromisePrompt({ heard = '', reply = '', partner = 'my human', toolsUsed = [] } = {}) {
  const used = [...new Set(toolsUsed.filter(Boolean))];
  const tools = used.length ? `Tools I used in that turn: ${used.join(', ')}.` : 'I used no tools in that turn.';
  return `These are my own notes, written right after a turn in my chat with ${partner}.

What ${partner} said:
"""
${clip(heard, HEARD_CAP)}
"""

What I said back:
"""
${clipReply(reply)}
"""

${tools}

Did I promise to do something later: tonight, tomorrow, after something, the next time we talk? I list each one I haven't already set up. If I used intention_set or a schedule tool for it in that turn, it's set up, so I leave it out. Something I did right there in the turn isn't a promise, and neither is something ${partner} said they'd do.

For each promise:
- what: what I'll do, in first person and short, without the time words ("I look up the bus times for Saturday"). The time goes in the fields below.
- day: "today", "tomorrow", a weekday ("wednesday"), "next_contact" (the next time we talk), or "none".
- part: "soon", "morning", "afternoon", "evening", "night", or "none". Tonight is "evening".
- time: a clock time I actually named, as 24-hour "HH:MM", or "none".

I answer with JSON only: {"promises":[{"what":"…","day":"…","part":"…","time":"…"}]}. If I promised nothing: {"promises":[]}`;
}

/** One promise from the model (or a plain string), reduced to { what, when, quote }; null if empty. */
export function promiseItem(x) {
  const o = typeof x === 'string' ? { what: x } : (x && typeof x === 'object' ? x : null);
  const what = String(o?.what ?? o?.summary ?? '').trim();
  if (!what) return null;
  const quote = String(o?.quote ?? '').trim().slice(0, 200);
  return { what: what.slice(0, 300), when: normalizeWhen(o), quote: quote || null };
}

/** The promise list under `key` in a JSON reply. Malformed or missing → []. */
export function parsePromises(raw, { key = 'promises', max = MAX_PROMISES } = {}) {
  const cleaned = String(raw ?? '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return []; }
  const arr = Array.isArray(parsed?.[key]) ? parsed[key] : [];
  return arr.map(promiseItem).filter(Boolean).slice(0, max);
}

// RULE A: callProviderChat (generous cap, reasoning-content recovery). The
// memorization connection: this is the same kind of reading-back-my-own-words
// job. null when no connection is ready.
async function callPromiseModel(prompt, settings) {
  const conn = connectionForFeature(settings, 'memorization');
  if (!connectionReady(conn)) return null;
  return callProviderChat({
    provider: conn.provider, apiKey: conn.apiKey, model: conn.model, baseUrl: conn.baseUrl,
    messages: familiarDeliberationMessages({ identity: '', body: prompt, cue: '(looking back at what I just promised)' }),
    temperature: 0.2, maxTokens: 4000, reasoningEffort: resolveReasoningEffort(conn),
  });
}

// ── The backing ──────────────────────────────────────────────────────

// Lexical containment, like follow-up dedup: the same promise caught twice
// (the turn check, then the backstop) lands once.
function sameCommitment(a, b) {
  const x = normalizeFollowupText(a);
  const y = normalizeFollowupText(b);
  if (!x || !y) return false;
  if (x.length < 8 || y.length < 8) return x === y;
  return x.includes(y) || y.includes(x);
}

/** The intention's `why`: who I promised, for when, when I said it, and when the app caught it if late. */
export function promiseWhy({ partner = 'my human', time, caughtAt }) {
  const late = time.late ? ` The app only picked the promise up at ${naiveLabel(caughtAt)}, after that time.` : '';
  return `I told ${partner} I'd do this ${time.forLabel} (said ${time.saidLabel}).${late}`;
}

/**
 * Keep one promise as a timed intention.
 *   what, when — from the model; saidAt — local-naive ISO of the message I said
 *   it in; now — local-naive ISO of right now; partner — who I promised.
 * Returns { ok, id, at, late } on a new intention, { ok, deduped } when I already
 * hold it, { ok, fallback } when it went to my tome instead (Unruh down, cap
 * full, the write failed), or { ok:false, reason }.
 */
export async function backPromise({ what, when, saidAt = null, now = null, partner = 'my human', deps = {} } = {}) {
  const d = { setIntention, listIntentions, createSessionFollowup, settings: null, ...deps };
  const settings = d.settings ?? readSettingsSync();
  const caughtAt = now || wardLocalNowISO(settings?.wardTimeZone);
  const said = saidAt || caughtAt;
  const time = resolvePromiseTime(when, said, caughtAt);
  const text = anchorRelativeWords(String(what ?? '').trim(), said);
  if (!text) return { ok: false, reason: 'empty' };
  if (!time) return { ok: false, reason: 'bad-time', what: text };
  const why = promiseWhy({ partner, time, caughtAt });

  const keepInTome = async (reason) => {
    const r = await d.createSessionFollowup({ summary: `${text} (${why})` })
      .catch(err => ({ ok: false, error: err?.message ?? String(err) }));
    return r?.ok === false
      ? { ok: false, reason, what: text, error: r.error ?? 'could not keep it in my tome either' }
      : { ok: true, fallback: reason, what: text };
  };

  const listed = await d.listIntentions({ limit: 500 }).catch(err => ({ ok: false, error: err?.message }));
  if (!listed || listed.ok === false) return keepInTome('unruh-unavailable');
  const items = Array.isArray(listed.intentions) ? listed.intentions : [];
  const held = items.find(i => sameCommitment(i?.what, text));
  if (held) return { ok: true, deduped: held.id, what: text };
  if (openOneShots(items, settings).full) return keepInTome('cap-full');

  const trigger = time.kind === 'on_next_contact' ? { kind: 'on_next_contact' } : { kind: 'at', at: time.at };
  const r = await d.setIntention({ what: text, why, trigger, source: PROMISE_SOURCE })
    .catch(err => ({ ok: false, error: err?.message }));
  if (!r || r.ok === false || !r.id) return keepInTome('set-failed');
  return { ok: true, id: r.id, what: text, at: time.at ?? null, late: time.late };
}

const summarize = (r) => ({
  what: String(r?.what ?? '').slice(0, 100),
  ...(r?.id ? { id: r.id, at: r.at, late: r.late } : {}),
  ...(r?.deduped ? { deduped: r.deduped } : {}),
  ...(r?.fallback ? { fallback: r.fallback } : {}),
  ...(r?.ok === false ? { failed: r.reason, error: r.error } : {}),
});

/** Append one decision to logs/promise-events.jsonl (never throws) and return it. */
export async function logPromiseEvent(entry) {
  const row = { ...entry, loggedAt: new Date().toISOString() };
  try {
    await fsp.mkdir(path.dirname(LOG_FILE), { recursive: true });
    await fsp.appendFile(LOG_FILE, JSON.stringify(row) + '\n', 'utf8');
  } catch (err) { console.warn('[promises] could not write the event log:', err?.message ?? err); }
  if (entry.reason === 'caught') {
    const parts = (entry.results ?? []).map(r => r.id ? `${r.id}${r.late ? ' (late)' : ''}` : r.deduped ? 'already held' : r.fallback ? `kept in tome (${r.fallback})` : `failed (${r.failed})`);
    console.log(`[promises] ${entry.surface}: ${parts.length} promise(s) → ${parts.join(', ')}`);
  } else if (entry.reason === 'llm_failed') {
    console.warn(`[promises] ${entry.surface}: couldn't read the turn for promises — ${entry.error}`);
  }
  return row;
}

/**
 * After one of my turns in my human's own room: catch the promises in my reply.
 *   reply     — what I said (final text)
 *   heard     — the message I was answering
 *   toolsUsed — tool names the turn ran
 *   partner   — who I was talking to ("my human", or a listed speaker like "Claude Code")
 *   surface   — 'web' | 'voice' | 'discord', for the log
 * Fire-and-forget from the turn paths. Never throws.
 */
export async function catchPromisesAfterTurn({ reply, heard = '', toolsUsed = [], partner = 'my human', surface = 'web', sessionId = null, saidAt = null, deps = {} } = {}) {
  const d = { readSettings: readSettingsSync, callLLM: callPromiseModel, backPromise, log: logPromiseEvent, ...deps };
  try {
    const settings = d.readSettings() || {};
    if (!promisesEnabled(settings)) return { reason: 'disabled' };
    const text = stripDsmlToolCalls(stripLlmTimestamps(String(reply ?? ''))).trim();
    if (!promiseCue(text)) return { reason: 'no_cue' };
    const base = { surface, sessionId };
    const used = (Array.isArray(toolsUsed) ? toolsUsed : []).filter(Boolean);
    if (used.some(n => BACKING_TOOLS.has(n))) return d.log({ ...base, reason: 'backed_in_turn' });

    const said = saidAt || wardLocalNowISO(settings.wardTimeZone);
    const prompt = substituteMacros(buildPromisePrompt({ heard, reply: text, partner, toolsUsed: used }), settings);
    let raw;
    try { raw = await d.callLLM(prompt, settings); }
    catch (err) { return d.log({ ...base, reason: 'llm_failed', error: String(err?.message ?? err).slice(0, 200) }); }
    if (raw == null) return d.log({ ...base, reason: 'no_connection' });

    const promises = parsePromises(raw);
    const now = wardLocalNowISO(settings.wardTimeZone);
    const results = [];
    for (const p of promises) results.push(await d.backPromise({ what: p.what, when: p.when, saidAt: said, now, partner }));
    return d.log({ ...base, reason: promises.length ? 'caught' : 'none_found', saidAt: said, results: results.map(summarize) });
  } catch (err) {
    console.warn('[promises] after-turn catch failed:', err?.message ?? err);
    return { reason: 'error', error: err?.message ?? String(err) };
  }
}

// ── The memorization backstop ────────────────────────────────────────

const tsMs = (ts) => (typeof ts === 'number' ? ts : Date.parse(ts ?? ''));

/**
 * When I said a promise the backstop found: the time of my latest message that
 * contains its quote (code looks it up; the model only quotes my words), else
 * my last message in the slice. Local-naive ISO, or null when no message has a
 * time.
 */
export function saidAtFor(quote, messages = [], timeZone = null) {
  const mine = (Array.isArray(messages) ? messages : [])
    .filter(m => m?.role === 'assistant' && typeof m.content === 'string' && Number.isFinite(tsMs(m.timestamp)));
  const q = normalizeFollowupText(quote);
  const hit = q.length >= 6 ? [...mine].reverse().find(m => normalizeFollowupText(m.content).includes(q)) : null;
  const pick = hit ?? mine[mine.length - 1];
  return pick ? wardLocalNowISO(timeZone, tsMs(pick.timestamp)) : null;
}

/**
 * Back the follow-ups one memorization slice found (items from parsePromises).
 * Each one's "said at" comes from saidAtFor over the slice's messages.
 */
export async function backPromises(items = [], { messages = [], partner = 'my human', timeZone = null, deps = {} } = {}) {
  const back = deps.backPromise ?? backPromise;
  const log  = deps.log ?? logPromiseEvent;
  const out = [];
  for (const it of items) {
    const saidAt = saidAtFor(it.quote, messages, timeZone);
    out.push(await back({ what: it.what, when: it.when, saidAt, partner }).catch(err => ({ ok: false, reason: 'error', error: err?.message })));
  }
  if (out.length) await log({ surface: 'memorization', reason: 'caught', results: out.map(summarize) });
  return out;
}

/**
 * The promises I already hold that were caught since `sinceIso` — handed to the
 * backstop so it doesn't list them again under different words. Best-effort: [].
 */
export async function heldPromisesSince(sinceIso, { deps = {} } = {}) {
  const list = deps.listIntentions ?? listIntentions;
  const r = await list({ limit: 500 }).catch(() => null);
  const items = Array.isArray(r?.intentions) ? r.intentions : [];
  const since = String(sinceIso ?? '');
  return items.filter(i => i?.source === PROMISE_SOURCE && (!since || String(i.created_at ?? '') >= since)).map(i => String(i.what));
}
