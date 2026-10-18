/**
 * Sorting my older tome notes for shared rooms (0.14.91) — the review half of
 * the tome room gate (room-lore.js). New notes get a share tag when I save
 * them; this pass goes back through the ones that have none and lets me sort
 * them myself, a batch at a time.
 *
 * Only notes that could actually reach a room are looked at: an enabled entry,
 * in an enabled tome whose room setting is 'content' (an 'always' or 'never'
 * tome, or a private one like Session Memories, doesn't use entry tags). Code
 * picks the batch, I judge it in ONE call, and code checks every tag
 * (checkTomeTag: a note that names a person is held at sensitive). Careful by
 * construction: anything I'm unsure about, leave out, or tag in a way that
 * doesn't parse stays unsorted, which keeps it out of shared rooms. A note I
 * skip three times is marked looked-at so it isn't asked about forever.
 * Everything I sort is visible and changeable in the Tomes modal, and every
 * pass is logged (logs/tome-tagging-events.jsonl).
 *
 * Pure except the default state/log I/O; the loop (tome-tagging-loop.js)
 * injects the tome reads/writes and the model call.
 */
import path from 'path';
import { promises as fsp, mkdirSync } from 'fs';
import { CONTENT_TOPICS } from '../memory/content-tags.js';
import { summarizeCircles } from '../memory/content-regate.js';
import { familiarDeliberationMessages } from '../../llm-call.js';
import { tomeRoomShare } from './room-lore.js';
import { normalizeTomeTag, peopleNames, checkTomeTag, applyTomeTag, entryShareKind } from './tome-tags.js';
import { REPO_ROOT } from '../../repo-root.js';

const TOMES_DIR = path.join(REPO_ROOT, 'tomes');
const LOGS_DIR  = path.join(REPO_ROOT, 'logs');
mkdirSync(TOMES_DIR, { recursive: true });
mkdirSync(LOGS_DIR, { recursive: true });
const STATE_FILE = path.join(TOMES_DIR, '.tome-tagging-state.json');
const EVENTS_FILE = path.join(LOGS_DIR, 'tome-tagging-events.jsonl');

export const DEFAULT_BATCH_SIZE = 12;
export const MAX_MISSES = 3;
const MAX_CONTENT_CHARS = 700;

// ── Which notes (pure) ────────────────────────────────────────────────

const entriesOf = (tome) => Array.isArray(tome?.entries) ? tome.entries : Object.values(tome?.entries ?? {});

/** Could this entry reach a shared room at all, and does its tag matter there? */
function inScope(tome, entry) {
  return tome?.enabled !== false && tomeRoomShare(tome) === 'content' && entry?.enabled !== false;
}

/**
 * Unsorted notes that could reach a room, oldest first: [{ key, file, tomeId,
 * tomeName, uid, comment, content }]. `files` is [{ tome, file }]. Pure.
 */
export function selectTaggingCandidates(files = []) {
  const out = [];
  for (const { tome, file } of (Array.isArray(files) ? files : [])) {
    for (const e of entriesOf(tome)) {
      if (!e?.uid || !inScope(tome, e) || entryShareKind(e) !== 'unsorted') continue;
      out.push({
        key: `${tome.id ?? file}:${e.uid}`, file, tomeId: tome.id ?? null, tomeName: String(tome.name ?? ''),
        uid: e.uid, comment: String(e.comment ?? ''), content: String(e.content ?? ''),
        createdAt: e.created_at ?? e.learnedAt ?? '',
      });
    }
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/**
 * Where my notes stand: counts over the notes that could reach a room
 * ({ total, unsorted, self, topic, private, unsure }), plus how many tomes are
 * set to always/never share. Pure.
 */
export function tomeTaggingStatus(tomes = []) {
  const counts = { total: 0, unsorted: 0, self: 0, topic: 0, private: 0, unsure: 0 };
  let alwaysTomes = 0, neverTomes = 0;
  for (const tome of (Array.isArray(tomes) ? tomes : [])) {
    if (tome?.enabled === false) continue;
    const share = tomeRoomShare(tome);
    if (share === 'always') { alwaysTomes++; continue; }
    if (share === 'never') { neverTomes++; continue; }
    for (const e of entriesOf(tome)) {
      if (!inScope(tome, e)) continue;
      counts.total++;
      counts[entryShareKind(e)]++;
    }
  }
  return { ...counts, alwaysTomes, neverTomes };
}

// ── Prompt (first person, said plainly) ───────────────────────────────

export function buildTaggingPrompt({ items = [], circlesSummary = '' } = {}) {
  const notes = items.map(it => {
    const body = it.content.length > MAX_CONTENT_CHARS ? `${it.content.slice(0, MAX_CONTENT_CHARS)}…` : it.content;
    return `${it.ref}. [${it.tomeName || 'a tome'}] ${it.comment || '(untitled)'}\n    ${body.replace(/\s*\n\s*/g, ' ')}`;
  }).join('\n\n');
  return `I'm sorting my tome notes for when I'm somewhere with other people: a friend's DM, a Discord channel, a chat my human shares with someone. A note I mark as mine comes with me into all of those. A note about my human or someone else only comes along where my human has trusted the people there with that topic.

Who's trusted with what right now:
${circlesSummary}

For each note I pick one tag:
- "self": my own thinking, my interests, or general knowledge that isn't about anyone. These go everywhere, so I only pick it when no person is in the note.
- "<topic>:open" or "<topic>:sensitive": it's about my human or someone else. If it names or describes a person, it's sensitive. A note that covers more than one topic gets all of them, joined with "+" ("work:open+mental-health:sensitive"); a room then needs every one.
- "private": it stays between my human and me, wherever I am.
- "unsure": I can't tell. Unsure notes stay out of shared rooms.

Topics: ${CONTENT_TOPICS.join(', ')}

The notes:

${notes}

I answer with only a JSON array, nothing else:
[{"ref": "n1", "tag": "self"}, {"ref": "n2", "tag": "work:sensitive"}]
A note I leave out stays unsorted for now.`;
}

// ── Parse (careful by default) ────────────────────────────────────────

/**
 * Map ref → { tag } ('self' | 'private' | 'topic:level') or { unsure: true }.
 * An unknown ref is ignored; an unreadable tag or a missing note is simply
 * absent (a miss — it stays unsorted). Unparseable output → empty map.
 */
export function parseTaggingDecision(raw, validRefs) {
  const valid = validRefs instanceof Set ? validRefs : new Set(validRefs ?? []);
  const out = new Map();
  let arr;
  try { arr = JSON.parse(String(raw ?? '').match(/\[[\s\S]*\]/)?.[0] ?? 'null'); }
  catch { arr = null; }
  if (!Array.isArray(arr)) return out;
  for (const d of arr) {
    const ref = String(d?.ref ?? '').trim();
    if (!valid.has(ref) || out.has(ref)) continue;
    const said = String(d?.tag ?? '').trim().toLowerCase();
    if (said === 'unsure') { out.set(ref, { unsure: true }); continue; }
    const tag = normalizeTomeTag(said);
    if (tag) out.set(ref, { tag });
  }
  return out;
}

// ── State + log (default I/O) ─────────────────────────────────────────

export async function readTaggingState() {
  try {
    const s = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
    return { misses: (s?.misses && typeof s.misses === 'object') ? s.misses : {} };
  } catch { return { misses: {} }; }
}

async function writeTaggingState(state) {
  const tmp = STATE_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(tmp, STATE_FILE);
}

async function appendTaggingEvent(event) {
  try { await fsp.appendFile(EVENTS_FILE, JSON.stringify({ ...event, loggedAt: new Date().toISOString() }) + '\n', 'utf8'); }
  catch { /* a log write never breaks the pass */ }
}

/** The latest passes, newest first. Never throws. */
export async function readTaggingEvents(limit = 20) {
  try {
    const lines = (await fsp.readFile(EVENTS_FILE, 'utf8')).split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, limit)).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ── One pass (injectable I/O) ─────────────────────────────────────────

/**
 * Sort one batch. Injected:
 *   readTomes()                 → [{ tome, file }]
 *   modifyTomeFile(file, fn)    → the locked read-modify-write (thalamus)
 *   callLLM(messages)           → raw text
 *   getRegistry(), getSettings() → for the circle summary and people's names
 *   buildMessages({ prompt })   → provider messages (the loop adds identity)
 * Returns { reason, looked, sorted, unsure, held, missed, errors }. Never throws.
 */
export async function runOneTaggingTick({
  readTomes,
  modifyTomeFile,
  callLLM,
  getRegistry = async () => null,
  getSettings = () => ({}),
  buildMessages = ({ prompt }) => familiarDeliberationMessages({ body: prompt, cue: '(sorting my tome notes)' }),
  batchSize = DEFAULT_BATCH_SIZE,
  now = () => new Date().toISOString(),
  readState = readTaggingState,
  writeState = writeTaggingState,
  appendEvent = appendTaggingEvent,
} = {}) {
  const empty = { looked: 0, sorted: 0, unsure: 0, held: 0, missed: 0, errors: [] };
  for (const [name, fn] of Object.entries({ readTomes, modifyTomeFile, callLLM })) {
    if (typeof fn !== 'function') return { reason: `${name}_missing`, ...empty };
  }
  let batch;
  try { batch = selectTaggingCandidates(await readTomes()).slice(0, Math.max(1, batchSize)); }
  catch (err) { return { reason: 'read_failed', error: err?.message ?? String(err), ...empty }; }
  if (!batch.length) return { reason: 'all_sorted', ...empty };

  const items = batch.map((c, i) => ({ ...c, ref: `n${i + 1}` }));
  const registry = await Promise.resolve().then(getRegistry).catch(() => null);
  const settings = (() => { try { return getSettings() ?? {}; } catch { return {}; } })();
  const names = peopleNames({ settings, registry });
  const prompt = buildTaggingPrompt({
    items,
    circlesSummary: summarizeCircles(registry, {
      emptyText: "  (no one's been trusted with any topic yet, so for now only my own notes come along.)",
    }),
  });

  let text;
  try { text = await callLLM(buildMessages({ prompt })); }
  catch (err) { return { reason: 'llm_failed', error: err?.message ?? String(err), ...empty }; }
  const decisions = parseTaggingDecision(text, new Set(items.map(i => i.ref)));

  const state = await readState().catch(() => ({ misses: {} }));
  const misses = { ...(state.misses ?? {}) };
  const plans = [];        // { item, tag, reviewed, heldBy }
  let missed = 0;
  for (const it of items) {
    const d = decisions.get(it.ref);
    if (!d) {
      missed++;
      misses[it.key] = (misses[it.key] ?? 0) + 1;
      if (misses[it.key] >= MAX_MISSES) plans.push({ item: it, tag: null, reviewed: true, heldBy: null, gaveUp: true });
      continue;
    }
    if (d.unsure) { plans.push({ item: it, tag: null, reviewed: true, heldBy: null }); continue; }
    const checked = checkTomeTag(d.tag, `${it.comment}\n${it.content}`, names);
    plans.push({ item: it, tag: checked.tag, reviewed: false, heldBy: checked.heldBy });
  }

  const at = now();
  const errors = [];
  const applied = [];
  const byFile = new Map();
  for (const p of plans) byFile.set(p.item.file, [...(byFile.get(p.item.file) ?? []), p]);
  for (const [file, list] of byFile) {
    try {
      await modifyTomeFile(file, (fresh) => {
        const map = fresh?.entries;
        if (!map || typeof map !== 'object' || Array.isArray(map)) return fresh;
        for (const p of list) {
          const e = map[p.item.uid];
          // Sorted by someone else meanwhile (my human in the editor) → leave it.
          if (!e || entryShareKind(e) !== 'unsorted') continue;
          map[p.item.uid] = applyTomeTag(e, p.tag, { source: 'review', now: at, reviewed: p.reviewed });
          applied.push(p);
        }
        return fresh;
      });
    } catch (err) {
      errors.push({ file: path.basename(file), error: err?.message ?? String(err) });
    }
  }
  for (const p of applied) delete misses[p.item.key];
  await writeState({ misses }).catch(() => {});

  const summary = {
    reason: 'sorted',
    looked: items.length,
    sorted: applied.filter(p => p.tag).length,
    unsure: applied.filter(p => !p.tag).length,
    held: applied.filter(p => p.heldBy).length,
    missed,
    errors,
  };
  await appendEvent({
    ...summary,
    notes: applied.map(p => ({
      tome: p.item.tomeName, title: p.item.comment.slice(0, 60),
      tag: p.tag ?? (p.gaveUp ? 'unsure (skipped 3 times)' : 'unsure'),
      ...(p.heldBy ? { heldBecause: 'names someone' } : {}),
    })),
  });
  return summary;
}
