// Pondering consolidation — the ponderings tome's answer to memory's rollup.
//
// Ponderings accumulate forever otherwise: the loop writes one every tick and
// nothing ever folds them down. This distils a whole PAST month of musings into
// a single digest entry — "what I was turning over back then" — and prunes the
// originals, so the shape of that month's thinking survives without the bulk.
//
// It deliberately mirrors memory consolidation's shape (roll up, prune sources)
// but stays LOCAL to the ponderings tome: ponderings are per-embodiment, the one
// state that doesn't live in the canonical store, and a digest of them is still
// that — the Familiar's own private thinking, not a recallable fact.
//
// Rides the pondering tick (no new loop). The "is there an un-consolidated past
// month?" check IS the rate limit — once a month is digested it's gone, so this
// won't fire again until another month ages out. Oldest month first, one per
// call, so a big backlog drains over successive ticks (the 0.8.89 sweep-all-past
// lesson, applied here).

import { findOrCreatePonderingsTome, shortPonderUid, defaultCallLLM } from './pondering.js';
import { modifyTomeFile } from '../../thalamus.js';
import { substituteMacros } from '../../macros.js';

// Don't bother digesting a month with only a handful of ponderings — the point
// is bulk relief, and two notes aren't bulk.
export const MIN_PONDERINGS_PER_MONTH = 3;

const DIGEST_SCOPE = 'pondering-digest';

function monthPrefixOf(iso) {
  const s = String(iso ?? '');
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : null;   // "YYYY-MM"
}

function monthLabel(prefix) {
  // "2026-07" → "July 2026". Pure, no locale surprises (fixed month names).
  const [y, m] = prefix.split('-');
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const name = names[Number(m) - 1] ?? prefix;
  return `${name} ${y}`;
}

// A pondering is eligible to be folded down only if it's a real pondering (not a
// reflection, not an existing digest) AND carries no UNACTED deferred intent —
// pruning one with a pending tell/follow-up would silently drop it.
function isEligible(entry) {
  if (!entry || entry.scope !== 'pondering') return false;
  const intents = Array.isArray(entry.wants_to_save) ? entry.wants_to_save : [];
  if (intents.some(i => i && i.acted_on === false)) return false;
  return !!monthPrefixOf(entry.created_at);
}

/**
 * Pick the OLDEST past month that has enough eligible ponderings to digest.
 * Pure. Returns { monthPrefix, label, uids, entries } or null.
 *
 * @param entries  the ponderings tome's entries map (uid → entry)
 * @param now      Date — "current month" (never consolidated, still filling)
 */
export function selectConsolidationTarget(entries, { now = new Date(), minPerMonth = MIN_PONDERINGS_PER_MONTH } = {}) {
  const currentMonth = monthPrefixOf(now.toISOString());
  const byMonth = new Map();   // prefix → [{uid, entry}]
  for (const [uid, entry] of Object.entries(entries ?? {})) {
    if (!isEligible(entry)) continue;
    const prefix = monthPrefixOf(entry.created_at);
    if (!prefix || prefix >= currentMonth) continue;   // never the current (still-filling) month
    if (!byMonth.has(prefix)) byMonth.set(prefix, []);
    byMonth.get(prefix).push({ uid, entry });
  }
  const eligibleMonths = [...byMonth.keys()].filter(p => byMonth.get(p).length >= minPerMonth).sort();
  if (!eligibleMonths.length) return null;
  const monthPrefix = eligibleMonths[0];   // oldest first
  const picked = byMonth.get(monthPrefix);
  return {
    monthPrefix,
    label:   monthLabel(monthPrefix),
    uids:    picked.map(p => p.uid),
    entries: picked.map(p => p.entry),
  };
}

// First-person, plain — the Familiar looking back over a month of its own notes.
// Study-partner register, no lofty "the grounded truth I draw on" register.
export function buildConsolidationPrompt(label, ponderings) {
  const notes = ponderings
    .map(p => {
      const title = String(p.comment ?? '').trim();
      const body  = String(p.content ?? '').trim();
      return `- ${title ? `${title}: ` : ''}${body}`;
    })
    .join('\n');
  return `I'm looking back over the things I was turning over in ${label}. These are my own pondering notes from back then:

${notes}

I want to keep the shape of what I was thinking about that month without hanging onto every single note. So: a short digest, in my own voice — the threads that actually mattered, the questions that kept coming back, anything I'd want to remember I was chewing on. A few sentences, not a list of everything. If a month of notes really only amounts to one or two threads, that's fine, I say so plainly.

I return ONLY valid JSON (no markdown fences, no commentary outside it):
{
  "digest": "My short first-person digest of what I was turning over in ${label}."
}`;
}

// Parse the digest text out of the model's reply. Tolerant: JSON first, then a
// bare-string fallback so a model that skipped the envelope isn't a total loss.
export function parseDigest(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const obj = JSON.parse(m[0]);
      const d = String(obj?.digest ?? '').trim();
      if (d) return d;
    }
  } catch { /* fall through to the bare-text fallback */ }
  // No parseable envelope, but there IS text — use it (stripped of any fence).
  const bare = text.replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  return bare || null;
}

/**
 * Consolidate the oldest eligible past month, if any. Best-effort and
 * self-limiting (one month per call). Returns { monthPrefix, count, digestUid }
 * or null when there was nothing to do / the LLM call failed (the month stays
 * eligible and is retried next tick).
 *
 * `callLLM` matches ponderOnce's contract: ({provider,apiKey,model,baseUrl,prompt}) → string.
 */
export async function consolidatePonderings({ tomesDir, provider, apiKey, model, baseUrl = null, callLLM = defaultCallLLM, settings = {}, now = new Date() }) {
  const { file } = await findOrCreatePonderingsTome(tomesDir);
  // Read-only peek for the target (the write below re-reads under the lock).
  let target = null;
  await modifyTomeFile(file, (fresh) => {
    target = selectConsolidationTarget(fresh.entries ?? {}, { now });
    return fresh;   // no mutation on the peek
  });
  if (!target) return null;

  const prompt = substituteMacros(buildConsolidationPrompt(target.label, target.entries), settings);
  let raw;
  try { raw = await callLLM({ provider, apiKey, model, baseUrl, prompt }); }
  catch { return null; }   // transient — month stays eligible, retried next tick
  const digest = parseDigest(raw);
  if (!digest) return null;

  let digestUid = shortPonderUid();
  const nowIso = now.toISOString();
  let count = 0;
  await modifyTomeFile(file, (fresh) => {
    fresh.entries = fresh.entries || {};
    // Re-validate the SAME uids under the lock (an entry may have gained a
    // pending intent, or been edited, since the peek). Only prune ones still
    // eligible and still in this month.
    const stillThere = target.uids.filter(uid => {
      const e = fresh.entries[uid];
      return e && isEligible(e) && monthPrefixOf(e.created_at) === target.monthPrefix;
    });
    if (stillThere.length < MIN_PONDERINGS_PER_MONTH) return fresh;   // raced away — skip this pass
    while (fresh.entries[digestUid]) digestUid = shortPonderUid();
    fresh.entries[digestUid] = {
      uid: digestUid,
      comment: `What I was turning over in ${target.label}`,
      keys: [], keysecondary: [],
      content: digest,
      constant: false, selective: false, selectiveLogic: 0,
      enabled: false,          // a digest is an artifact to read, never auto-injected
      position: 4, depth: 4, role: 0,
      scanDepth: null, caseSensitive: null, matchWholeWords: null,
      probability: 100, sticky: null, cooldown: null,
      preventRecursion: false, delayUntilRecursion: false, excludeRecursion: false,
      group: '', groupWeight: null, insertion_order: 100,
      created_at: nowIso, learnedAt: nowIso,
      scope: DIGEST_SCOPE,
      consolidated_month: target.monthPrefix,
      consolidated_count: stillThere.length,
    };
    for (const uid of stillThere) delete fresh.entries[uid];
    count = stillThere.length;
    return fresh;
  });
  if (!count) return null;
  return { monthPrefix: target.monthPrefix, count, digestUid };
}
