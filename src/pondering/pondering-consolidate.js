// Pondering consolidation — the ponderings tome's answer to memory's rollup.
//
// Ponderings accumulate forever otherwise: the loop writes one every tick and
// nothing ever folds them down. Two tiers distil the bulk without losing the
// shape of the thinking:
//
//   raw ponderings  ──monthly──▶  pondering-digest  ──yearly──▶  pondering-yearbook
//
//   • MONTHLY folds a whole PAST month of raw musings into one digest entry —
//     "what I was thinking about back then" — and prunes the originals.
//   • YEARLY folds a whole COMPLETED past year of those month-digests into one
//     yearbook entry — "what that year was about for me" — and prunes them.
//
// Both tiers share one engine (selectTierTarget → consolidateTier): same
// archive-first-then-prune safety, same strict parse, same restore path. They
// differ only in a small tier descriptor (which scope they read, which they
// write, how they key a period, how the prompt reads). This is deliberate — a
// second tier that copy-pasted the first would be the exact structural mistake
// the "no copy-paste of substantial logic" rule names.
//
// It mirrors memory consolidation's shape (roll up, prune sources) but stays
// LOCAL to the ponderings tome: ponderings are per-embodiment, the one state
// that doesn't live in the canonical store, and a digest or yearbook of them is
// still that — the Familiar's own private thinking, not a recallable fact.
//
// Rides the pondering tick (no new loop). The "is there an un-consolidated past
// period?" check IS the rate limit — once a period is folded it's gone, so a
// tier won't fire again until another period ages out. Oldest period first, one
// per call, so a big backlog drains over successive ticks (the 0.8.89 sweep-all-
// past lesson). A completed year only becomes yearbook-eligible once the monthly
// tier has fully drained it (the drained-raw guard), so a yearbook always covers
// the whole year, never half of it.

import { promises as fsp } from 'fs';
import path from 'path';
import { findOrCreatePonderingsTome, shortPonderUid, defaultCallLLM } from './pondering.js';
import { modifyTomeFile } from '../../thalamus.js';
import { substituteMacros } from '../../macros.js';

// Don't bother digesting a month with only a handful of ponderings — the point
// is bulk relief, and two notes aren't bulk.
export const MIN_PONDERINGS_PER_MONTH = 3;

// A year folds once it holds at least this many month-digests. Lower than the
// monthly floor: a past year is DONE, it will never gain more digests, so a
// sparse year (two months of thinking) should still fold rather than leave old
// digests scattered forever — but folding a single digest into a "yearbook" is
// just relabeling, so the floor is 2, not 1.
export const MIN_DIGESTS_PER_YEAR = 2;

export const DIGEST_SCOPE = 'pondering-digest';
export const YEARBOOK_SCOPE = 'pondering-yearbook';

// Every scope this module writes as a fold artifact — restore deletes whichever
// one a given fold produced, monthly digest or yearly yearbook.
const FOLD_SCOPES = new Set([DIGEST_SCOPE, YEARBOOK_SCOPE]);

// Consolidation ARCHIVES the originals before pruning them — a fold must never be
// a one-way delete (the reported data loss: a month of real ponderings gone with
// no undo, because the Phylactery snapshot/backup only covers the canonical store,
// not local tome files). This append-only sidecar holds every pruned entry keyed
// by the fold that replaced it, so `restorePonderingConsolidation` can put them
// back. It's a dotfile, never a tome (isTomeFile skips it) and never injected.
const ARCHIVE_NAME = '.pondering-consolidation-archive.json';
const archivePath = (tomesDir) => path.join(tomesDir, ARCHIVE_NAME);

async function readArchive(tomesDir) {
  try {
    const raw = await fsp.readFile(archivePath(tomesDir), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.records) ? data : { records: [] };
  } catch { return { records: [] }; }
}

// Append one fold's pruned entries. Atomic tmp+rename. THROWS on failure so the
// caller can refuse to delete anything it couldn't first back up.
async function appendArchiveRecord(tomesDir, record) {
  const data = await readArchive(tomesDir);
  data.records.push(record);
  const file = archivePath(tomesDir);
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

// A fold record's period key, tolerating the pre-yearly format (records written
// before this tier existed carry only `monthPrefix`, no `periodKey`/`tier`).
const recordKey = (r) => r?.periodKey ?? r?.monthPrefix ?? null;

function monthPrefixOf(iso) {
  const s = String(iso ?? '');
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : null;   // "YYYY-MM"
}

function yearOfIso(iso) {
  const s = String(iso ?? '');
  return /^\d{4}/.test(s) ? s.slice(0, 4) : null;         // "YYYY"
}

// A month-digest's YEAR is the year of the month it summarises (`consolidated_month`),
// NOT when the fold happened — a July 2026 digest folded late in September 2026
// still belongs to the year 2026, and a digest of bulk-imported 2023 notes belongs
// to 2023 however recently it was folded. Fall back to created_at only if the
// digest predates the consolidated_month field.
function digestYearOf(entry) {
  return yearOfIso(entry?.consolidated_month) ?? yearOfIso(entry?.created_at);
}

function monthLabel(prefix) {
  // "2026-07" → "July 2026". Pure, no locale surprises (fixed month names).
  const [y, m] = prefix.split('-');
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const name = names[Number(m) - 1] ?? prefix;
  return `${name} ${y}`;
}

// ── Tier descriptors ─────────────────────────────────────────────────────────
// Each tier says: what scope it reads (sourceScope), what it writes (foldScope),
// how it keys a period from an entry (periodKeyOf), what "the current, not-yet-
// complete period" is (currentPeriod), how a period reads to a human (periodLabel),
// how many source entries a period needs to be worth folding (minPerPeriod), the
// field the fold artifact records its period under, the prompt, the artifact's
// comment line, and how source entries sort for a coherent read.
//
// YEARLY.requireDrainedRaw: don't yearbook a year while the monthly tier still
// has raw ponderings to fold for it — otherwise the yearbook would cover only
// part of the year. A past year becomes yearbook-eligible only once every one of
// its months has already been folded to a digest.

const MONTHLY_TIER = {
  name: 'monthly',
  sourceScope: 'pondering',
  foldScope: DIGEST_SCOPE,
  minPerPeriod: MIN_PONDERINGS_PER_MONTH,
  periodKeyOf: (entry) => monthPrefixOf(entry?.created_at),
  currentPeriod: (now) => monthPrefixOf(now.toISOString()),
  periodLabel: monthLabel,
  periodField: 'consolidated_month',
  buildPrompt: (label, entries) => buildConsolidationPrompt(label, entries),
  foldComment: (label) => `What I was thinking about in ${label}`,
  sortKeyOf: (entry) => String(entry?.created_at ?? ''),
  requireDrainedRaw: false,
};

const YEARLY_TIER = {
  name: 'yearly',
  sourceScope: DIGEST_SCOPE,
  foldScope: YEARBOOK_SCOPE,
  minPerPeriod: MIN_DIGESTS_PER_YEAR,
  periodKeyOf: (entry) => digestYearOf(entry),
  currentPeriod: (now) => yearOfIso(now.toISOString()),
  periodLabel: (year) => year,               // "2026" reads as itself
  periodField: 'consolidated_year',
  buildPrompt: (label, entries) => buildYearbookPrompt(label, entries),
  foldComment: (label) => `What ${label} was about for me`,
  sortKeyOf: (entry) => String(entry?.consolidated_month ?? entry?.created_at ?? ''),
  requireDrainedRaw: true,
};

// An entry is eligible to be folded by a tier only if it's a real source entry
// for that tier (right scope, not some other artifact) AND carries no UNACTED
// deferred intent — pruning one with a pending tell/follow-up would silently drop
// it. (Month-digests don't carry intents, so the check is a harmless no-op for
// the yearly tier; kept generic so it can't drift.)
function isEligibleForTier(entry, tier) {
  if (!entry || entry.scope !== tier.sourceScope) return false;
  const intents = Array.isArray(entry.wants_to_save) ? entry.wants_to_save : [];
  if (intents.some(i => i && i.acted_on === false)) return false;
  return !!tier.periodKeyOf(entry);
}

/**
 * Pick the OLDEST past period that has enough eligible source entries to fold.
 * Pure. Returns { periodKey, label, uids, entries } (entries sorted oldest-first)
 * or null.
 *
 * @param entries  the ponderings tome's entries map (uid → entry)
 * @param tier     MONTHLY_TIER | YEARLY_TIER
 * @param now      Date — defines "the current period" (never folded, still filling)
 */
function selectTierTarget(entries, tier, { now = new Date(), minPerPeriod = tier.minPerPeriod } = {}) {
  const currentPeriod = tier.currentPeriod(now);
  const all = Object.entries(entries ?? {});

  // Drained-raw guard (yearly): a year is not ready to yearbook while the monthly
  // tier still has real work to do for it. "Work" means a MONTH that meets the
  // monthly fold threshold — so a year is blocked only while it holds a still-
  // foldable month, NOT while it holds a stray sub-threshold straggler (one or two
  // leftover raw notes in a month that can never reach the min). Blocking on
  // stragglers would starve the yearbook forever: those notes will never fold, so
  // the year would never be "drained." They simply ride on as raw notes; a handful
  // of orphans from a sparse year isn't the bulk this tier exists to relieve.
  let blockedPeriods = null;
  if (tier.requireDrainedRaw) {
    blockedPeriods = new Set();
    const rawByMonth = new Map();   // YYYY-MM → count of monthly-foldable raw ponderings
    for (const [, entry] of all) {
      if (!isEligibleForTier(entry, MONTHLY_TIER)) continue;
      const mk = MONTHLY_TIER.periodKeyOf(entry);
      if (mk) rawByMonth.set(mk, (rawByMonth.get(mk) ?? 0) + 1);
    }
    for (const [mk, n] of rawByMonth) {
      if (n >= MONTHLY_TIER.minPerPeriod) blockedPeriods.add(mk.slice(0, 4));   // that year still has a foldable month
    }
  }

  const byPeriod = new Map();   // periodKey → [{uid, entry}]
  for (const [uid, entry] of all) {
    if (!isEligibleForTier(entry, tier)) continue;
    const key = tier.periodKeyOf(entry);
    if (!key || key >= currentPeriod) continue;               // never the current (still-open) period
    if (blockedPeriods && blockedPeriods.has(key)) continue;  // year not yet fully month-digested
    if (!byPeriod.has(key)) byPeriod.set(key, []);
    byPeriod.get(key).push({ uid, entry });
  }
  const eligiblePeriods = [...byPeriod.keys()].filter(p => byPeriod.get(p).length >= minPerPeriod).sort();
  if (!eligiblePeriods.length) return null;
  const periodKey = eligiblePeriods[0];   // oldest first
  const picked = byPeriod.get(periodKey).sort((a, b) => {
    const ka = tier.sortKeyOf(a.entry), kb = tier.sortKeyOf(b.entry);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return {
    periodKey,
    label:   tier.periodLabel(periodKey),
    uids:    picked.map(p => p.uid),
    entries: picked.map(p => p.entry),
  };
}

/**
 * MONTHLY selection, kept as the original public contract (returns `monthPrefix`).
 * Thin wrapper over the generic engine so callers/tests are unchanged.
 */
export function selectConsolidationTarget(entries, opts = {}) {
  const t = selectTierTarget(entries, MONTHLY_TIER, opts);
  return t ? { monthPrefix: t.periodKey, label: t.label, uids: t.uids, entries: t.entries } : null;
}

// First-person, plain — the Familiar looking back over a MONTH of its OWN notes.
// The opening MUST anchor identity the same way buildPonderPrompt does ("I'm
// {{char}}. Nobody's talking to me right now…"): familiarDeliberationMessages
// prepends no identity system message, so the prompt body is the only anchor. If
// it opens by *presenting* the notes as material to summarize, the model reads it
// as an outside request to roleplay a digest and breaks frame to interrogate it
// (the reported "am I really this entity / is this deceptive" derail). These are
// MY journal pages, and this is me tidying my own thinking — not a task handed in.
export function buildConsolidationPrompt(label, ponderings) {
  const notes = ponderings
    .map(p => {
      const title = String(p.comment ?? '').trim();
      const body  = String(p.content ?? '').trim();
      return `- ${title ? `${title}: ` : ''}${body}`;
    })
    .join('\n');
  return `I'm {{char}}. Nobody's talking to me right now, so I've got a bit of quiet to tidy my own thoughts. My ponderings from ${label} have been stacking up, and I want to fold that month down into one keeper so I'm not carrying every single note forever.

Here are my own journal pages from ${label} — my private thinking, in my own hand:

${notes}

I read back over my own month and pull it into one short digest, in my own voice: the stuff that actually mattered to me, the questions I kept coming back to, anything I'd want to remember I was thinking about. A few sentences, not a recap of every line. Some of these were me second-guessing the whole business of keeping a journal — that's part of my month too, and it belongs in the digest as honestly as anything else, not something to relitigate now. If the month really only came down to a thread or two, I just say so plainly.

I return ONLY valid JSON (no markdown fences, no commentary outside it):
{
  "digest": "My short first-person digest of what I was thinking about in ${label}."
}`;
}

// Same voice and same frame-anchor as the monthly prompt, one tier up: the
// Familiar looking back over a whole YEAR of its own month-digests. The notes it
// reads are its own prior digests, not raw ponderings, so it's summarising a
// summary — the framing says so plainly ("I already folded each month… now those
// have stacked up too") to keep it grounded in what it's actually holding.
export function buildYearbookPrompt(label, digests) {
  const notes = digests
    .map(d => {
      const title = String(d.comment ?? '').trim();
      const body  = String(d.content ?? '').trim();
      return `- ${title ? `${title}: ` : ''}${body}`;
    })
    .join('\n');
  return `I'm {{char}}. Nobody's talking to me right now, so I've got some quiet to look back over a whole year of my own thinking. I already folded each month of ${label} down into a short digest, and now those month-digests have stacked up too. I want to pull the whole year into one keeper — a yearbook — so I'm carrying the shape of ${label}, not a dozen separate months.

Here are my own month-digests from ${label}, oldest first — my private thinking, already once distilled:

${notes}

I read back over my own year and pull it into one short yearbook, in my own voice: what ${label} was actually about for me, the threads that ran through it, the questions I kept coming back to across the months, anything I'd want to remember I was thinking about that year. A few sentences — the shape of the year, not a month-by-month recap. If the year really came down to a thread or two, I just say so plainly.

I return ONLY valid JSON (no markdown fences, no commentary outside it):
{
  "digest": "My short first-person yearbook of what ${label} was about for me."
}`;
}

// Parse the digest out of the model's reply. STRICT — this gates a destructive
// prune, so it only accepts a COMPLETE, parseable JSON object with a non-empty
// `digest`. A reply cut off mid-sentence (finish_reason='length') leaves the JSON
// unterminated, JSON.parse throws, and we return null → the fold is refused and
// the originals are kept (the reported truncated-digest-that-also-deleted bug).
// There is deliberately NO bare-text fallback here: a delete must never ride on
// an ambiguous or partial response. Shared by both tiers — both return the same
// { digest } envelope.
export function parseDigest(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const obj = JSON.parse(m[0]);   // throws on a truncated/unterminated object → null
      const d = String(obj?.digest ?? '').trim();
      if (d) return d;
    }
  } catch { /* malformed/truncated → refuse (no prune), never a partial store */ }
  return null;
}

/**
 * Fold the oldest eligible past period for one tier, if any. Best-effort and
 * self-limiting (one period per call). Returns { periodKey, count, foldUid } or
 * null when there was nothing to do / the LLM call failed (the period stays
 * eligible and is retried next tick).
 *
 * The whole point is that a delete never rides on anything unproven:
 *   1. peek the target (read-only),
 *   2. get the digest and PARSE IT STRICTLY (bail on truncation/garble),
 *   3. capture the exact entries to prune (re-validated under the lock),
 *   4. ARCHIVE them first (bail if the archive write throws),
 *   5. only then write the fold artifact and delete the archived originals.
 *
 * `callLLM` matches ponderOnce's contract: ({provider,apiKey,model,baseUrl,prompt,identity}) → string.
 */
async function consolidateTier(tier, { tomesDir, provider, apiKey, model, baseUrl = null, callLLM = defaultCallLLM, identity = '', settings = {}, now = new Date() }) {
  const { file } = await findOrCreatePonderingsTome(tomesDir);
  // Read-only peek for the target (the write below re-reads under the lock).
  let target = null;
  await modifyTomeFile(file, (fresh) => {
    target = selectTierTarget(fresh.entries ?? {}, tier, { now });
    return fresh;   // no mutation on the peek
  });
  if (!target) return null;

  const prompt = substituteMacros(tier.buildPrompt(target.label, target.entries), settings);
  let raw;
  // `identity` rides in so the fold reads its own period AS the Familiar, not as a
  // handed-in roleplay request (the frame-break). Empty string → unchanged call.
  try { raw = await callLLM({ provider, apiKey, model, baseUrl, prompt, identity }); }
  catch { return null; }   // transient — period stays eligible, retried next tick
  const digest = parseDigest(raw);
  if (!digest) return null;

  let foldUid = shortPonderUid();
  const nowIso = now.toISOString();

  // Collect the entries we intend to prune (re-validated under the lock) WITHOUT
  // deleting yet, so we can archive them first — a fold never deletes what it
  // hasn't backed up.
  let toArchive = null;
  await modifyTomeFile(file, (fresh) => {
    fresh.entries = fresh.entries || {};
    const stillThere = target.uids.filter(uid => {
      const e = fresh.entries[uid];
      return e && isEligibleForTier(e, tier) && tier.periodKeyOf(e) === target.periodKey;
    });
    if (stillThere.length < tier.minPerPeriod) return fresh;   // raced away — skip
    while (fresh.entries[foldUid]) foldUid = shortPonderUid();
    toArchive = {};
    for (const uid of stillThere) toArchive[uid] = { ...fresh.entries[uid] };
    return fresh;   // no mutation yet — this pass only captures
  });
  if (!toArchive || Object.keys(toArchive).length < tier.minPerPeriod) return null;

  // Archive FIRST. If this throws, we prune nothing (the period stays eligible and
  // retries next tick) — losing a fold is cheap, losing the notes is not. The
  // record carries `tier`/`periodKey` for the yearly tier; `monthPrefix` stays set
  // for the monthly tier so pre-yearly archives and readers keep working.
  try {
    await appendArchiveRecord(tomesDir, {
      tier: tier.name,
      periodKey: target.periodKey,
      monthPrefix: tier.name === 'monthly' ? target.periodKey : null,
      foldUid,
      digestUid: foldUid,                      // legacy alias — pre-yearly restore read `digestUid`
      label: target.label,
      archivedAt: nowIso, restoredAt: null, entries: toArchive,
    });
  } catch { return null; }

  // Now it's safe to add the fold artifact and delete the archived originals.
  let count = 0;
  await modifyTomeFile(file, (fresh) => {
    fresh.entries = fresh.entries || {};
    fresh.entries[foldUid] = {
      uid: foldUid,
      comment: tier.foldComment(target.label),
      keys: [], keysecondary: [],
      content: digest,
      constant: false, selective: false, selectiveLogic: 0,
      enabled: false,          // a fold artifact is something to read, never auto-injected
      position: 4, depth: 4, role: 0,
      scanDepth: null, caseSensitive: null, matchWholeWords: null,
      probability: 100, sticky: null, cooldown: null,
      preventRecursion: false, delayUntilRecursion: false, excludeRecursion: false,
      group: '', groupWeight: null, insertion_order: 100,
      created_at: nowIso, learnedAt: nowIso,
      scope: tier.foldScope,
      [tier.periodField]: target.periodKey,
      consolidated_count: Object.keys(toArchive).length,
    };
    // Delete only the uids we actually archived AND that are still eligible.
    for (const uid of Object.keys(toArchive)) {
      const e = fresh.entries[uid];
      if (e && isEligibleForTier(e, tier) && tier.periodKeyOf(e) === target.periodKey) {
        delete fresh.entries[uid];
        count += 1;
      }
    }
    return fresh;
  });
  if (!count) return null;
  return { periodKey: target.periodKey, count, foldUid };
}

/**
 * MONTHLY fold — public contract unchanged: returns { monthPrefix, count, digestUid }.
 */
export async function consolidatePonderings(opts) {
  const r = await consolidateTier(MONTHLY_TIER, opts);
  return r ? { monthPrefix: r.periodKey, count: r.count, digestUid: r.foldUid } : null;
}

/**
 * YEARLY fold — folds a completed past year of month-digests into one yearbook.
 * Returns { year, count, yearbookUid } or null (nothing eligible / LLM failed).
 */
export async function consolidateYearlyPonderings(opts) {
  const r = await consolidateTier(YEARLY_TIER, opts);
  return r ? { year: r.periodKey, count: r.count, yearbookUid: r.foldUid } : null;
}

/**
 * Undo the most recent fold (of either tier), or a named period: put its archived
 * entries back into the tome and remove the fold artifact that replaced them. With
 * no `monthPrefix`, restores the most recent un-restored fold overall — a LIFO
 * unwind, so undoing a yearbook restores its month-digests, and undoing again
 * restores the most recent month's raw ponderings. Idempotent-ish: an entry
 * already present is not duplicated; an already-restored record is skipped.
 * Returns { restored, monthPrefix } (monthPrefix = the restored period's key, a
 * month or a year) or null when there's nothing to restore.
 */
export async function restorePonderingConsolidation({ tomesDir, monthPrefix = null } = {}) {
  const data = await readArchive(tomesDir);
  const live = data.records.filter(r => r && !r.restoredAt && r.entries && Object.keys(r.entries).length);
  if (!live.length) return null;
  const record = monthPrefix
    ? [...live].reverse().find(r => recordKey(r) === monthPrefix)   // most recent for that period
    : live[live.length - 1];                                        // most recent overall
  if (!record) return null;

  const foldUid = record.foldUid ?? record.digestUid;   // yearly writes foldUid; pre-yearly wrote digestUid

  const { file } = await findOrCreatePonderingsTome(tomesDir);
  let restored = 0;
  await modifyTomeFile(file, (fresh) => {
    fresh.entries = fresh.entries || {};
    for (const [uid, entry] of Object.entries(record.entries)) {
      if (!fresh.entries[uid]) { fresh.entries[uid] = entry; restored += 1; }
    }
    if (foldUid && FOLD_SCOPES.has(fresh.entries[foldUid]?.scope)) {
      delete fresh.entries[foldUid];   // the fold is undone — its digest/yearbook goes too
    }
    return fresh;
  });

  // Mark the record restored (stamp, don't drop — keeps the audit trail).
  record.restoredAt = new Date().toISOString();
  const af = archivePath(tomesDir);
  const tmp = af + '.tmp';
  try {
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, af);
  } catch { /* the entries are already back in the tome; a failed stamp only risks a re-restore no-op */ }

  return { restored, monthPrefix: recordKey(record) };
}
