// Pondering consolidation — the ponderings tome's answer to memory's rollup.
//
// Ponderings accumulate forever otherwise: the loop writes one every tick and
// nothing ever folds them down. This distils a whole PAST month of musings into
// a single digest entry — "what I was thinking about back then" — and prunes the
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

import { promises as fsp } from 'fs';
import path from 'path';
import { findOrCreatePonderingsTome, shortPonderUid, defaultCallLLM } from './pondering.js';
import { modifyTomeFile } from '../../thalamus.js';
import { substituteMacros } from '../../macros.js';

// Don't bother digesting a month with only a handful of ponderings — the point
// is bulk relief, and two notes aren't bulk.
export const MIN_PONDERINGS_PER_MONTH = 3;

const DIGEST_SCOPE = 'pondering-digest';

// Consolidation ARCHIVES the originals before pruning them — a fold must never be
// a one-way delete (the reported data loss: a month of real ponderings gone with
// no undo, because the Phylactery snapshot/backup only covers the canonical store,
// not local tome files). This append-only sidecar holds every pruned entry keyed
// by the digest that replaced it, so `restorePonderingConsolidation` can put them
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

// First-person, plain — the Familiar looking back over a month of its OWN notes.
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

// Parse the digest out of the model's reply. STRICT — this gates a destructive
// prune, so it only accepts a COMPLETE, parseable JSON object with a non-empty
// `digest`. A reply cut off mid-sentence (finish_reason='length') leaves the JSON
// unterminated, JSON.parse throws, and we return null → the fold is refused and
// the originals are kept (the reported truncated-digest-that-also-deleted bug).
// There is deliberately NO bare-text fallback here: a delete must never ride on
// an ambiguous or partial response.
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
 * Consolidate the oldest eligible past month, if any. Best-effort and
 * self-limiting (one month per call). Returns { monthPrefix, count, digestUid }
 * or null when there was nothing to do / the LLM call failed (the month stays
 * eligible and is retried next tick).
 *
 * `callLLM` matches ponderOnce's contract: ({provider,apiKey,model,baseUrl,prompt}) → string.
 */
export async function consolidatePonderings({ tomesDir, provider, apiKey, model, baseUrl = null, callLLM = defaultCallLLM, identity = '', settings = {}, now = new Date() }) {
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
  // `identity` rides in so the fold reads its own month AS the Familiar, not as a
  // handed-in roleplay request (the frame-break). Empty string → unchanged call.
  try { raw = await callLLM({ provider, apiKey, model, baseUrl, prompt, identity }); }
  catch { return null; }   // transient — month stays eligible, retried next tick
  const digest = parseDigest(raw);
  if (!digest) return null;

  const digestUid0 = shortPonderUid();
  const nowIso = now.toISOString();

  // Collect the entries we intend to prune (re-validated under the lock) WITHOUT
  // deleting yet, so we can archive them first — a fold never deletes what it
  // hasn't backed up.
  let digestUid = digestUid0;
  let toArchive = null;
  await modifyTomeFile(file, (fresh) => {
    fresh.entries = fresh.entries || {};
    const stillThere = target.uids.filter(uid => {
      const e = fresh.entries[uid];
      return e && isEligible(e) && monthPrefixOf(e.created_at) === target.monthPrefix;
    });
    if (stillThere.length < MIN_PONDERINGS_PER_MONTH) return fresh;   // raced away — skip
    while (fresh.entries[digestUid]) digestUid = shortPonderUid();
    toArchive = {};
    for (const uid of stillThere) toArchive[uid] = { ...fresh.entries[uid] };
    return fresh;   // no mutation yet — this pass only captures
  });
  if (!toArchive || Object.keys(toArchive).length < MIN_PONDERINGS_PER_MONTH) return null;

  // Archive FIRST. If this throws, we prune nothing (the month stays eligible and
  // retries next tick) — losing a fold is cheap, losing the notes is not.
  try {
    await appendArchiveRecord(tomesDir, {
      digestUid, monthPrefix: target.monthPrefix, label: target.label,
      archivedAt: nowIso, restoredAt: null, entries: toArchive,
    });
  } catch { return null; }

  // Now it's safe to add the digest and delete the archived originals.
  let count = 0;
  await modifyTomeFile(file, (fresh) => {
    fresh.entries = fresh.entries || {};
    fresh.entries[digestUid] = {
      uid: digestUid,
      comment: `What I was thinking about in ${target.label}`,
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
      consolidated_count: Object.keys(toArchive).length,
    };
    // Delete only the uids we actually archived AND that are still eligible.
    for (const uid of Object.keys(toArchive)) {
      const e = fresh.entries[uid];
      if (e && isEligible(e) && monthPrefixOf(e.created_at) === target.monthPrefix) {
        delete fresh.entries[uid];
        count += 1;
      }
    }
    return fresh;
  });
  if (!count) return null;
  return { monthPrefix: target.monthPrefix, count, digestUid };
}

/**
 * Undo a fold: put a month's archived ponderings back into the tome and remove
 * the digest that replaced them. With no `monthPrefix`, restores the most recent
 * un-restored fold. Idempotent-ish: an entry already present is not duplicated;
 * an already-restored record is skipped. Returns { restored, monthPrefix } or
 * null when there's nothing to restore.
 */
export async function restorePonderingConsolidation({ tomesDir, monthPrefix = null } = {}) {
  const data = await readArchive(tomesDir);
  const live = data.records.filter(r => r && !r.restoredAt && r.entries && Object.keys(r.entries).length);
  if (!live.length) return null;
  const record = monthPrefix
    ? [...live].reverse().find(r => r.monthPrefix === monthPrefix)   // most recent for that month
    : live[live.length - 1];                                         // most recent overall
  if (!record) return null;

  const { file } = await findOrCreatePonderingsTome(tomesDir);
  let restored = 0;
  await modifyTomeFile(file, (fresh) => {
    fresh.entries = fresh.entries || {};
    for (const [uid, entry] of Object.entries(record.entries)) {
      if (!fresh.entries[uid]) { fresh.entries[uid] = entry; restored += 1; }
    }
    if (record.digestUid && fresh.entries[record.digestUid]?.scope === DIGEST_SCOPE) {
      delete fresh.entries[record.digestUid];   // the fold is undone — its digest goes too
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

  return { restored, monthPrefix: record.monthPrefix };
}
