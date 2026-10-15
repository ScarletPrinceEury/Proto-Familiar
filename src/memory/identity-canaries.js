/**
 * Identity canary stamps (0.14.79) — the check.
 *
 * A canary stamp is an exact line I keep in one of my identity files to tell
 * my identity loaded whole. I register my stamps (Phylactery keeps the list);
 * every turn this checks each one against the file it lives in AND the identity
 * block that actually went out, and I hear about it only when something's off.
 * It detects; it never blocks an edit or freezes a file.
 *
 * Room-aware: in a group room without the identityBasic grant only my self
 * files are sent, and gate markers can strip sections — a stamp whose file (or
 * section) isn't part of this room's identity isn't missing, it's not here.
 *
 * What it can't see: anything that happens after the request leaves the app
 * (a provider trimming context). My own reading of the stamps still covers that.
 */
import path from 'path';
import { mkdirSync, promises as fsp } from 'fs';
import { REPO_ROOT } from '../../repo-root.js';

export const CANARY_BLOCK_TITLE = '[Canary check';

// States that mean something's wrong. ok / not-in-room / gated are fine.
export const BROKEN_STATES = new Set(['missing', 'changed', 'duplicated', 'not-last', 'not-injected']);

const fileKey = (c) => `${c.category}/${c.filename}`;
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function countOf(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Where a stamp stands in its own file: 'ok', 'missing', 'changed' (the same
 * words with different spacing, or a line that starts the same way but isn't
 * another registered stamp), 'duplicated', or 'not-last' (an end-marker stamp
 * with something after it).
 */
export function canaryStateInFile(canary, content, otherStamps = []) {
  const text = String(content ?? '');
  const stamp = String(canary?.text ?? '');
  const n = countOf(text, stamp);
  if (n > 1) return 'duplicated';
  if (n === 1) return canary.at_end && !text.trimEnd().endsWith(stamp) ? 'not-last' : 'ok';
  if (squash(text).includes(squash(stamp))) return 'changed';
  const head = stamp.slice(0, Math.min(20, stamp.length));
  const others = new Set(otherStamps);
  const lookalike = text.split('\n').some(line => line.trim().startsWith(head) && !others.has(line.trim()));
  return lookalike ? 'changed' : 'missing';
}

function stateInFiles(canary, files, all) {
  const bucket = Array.isArray(files?.[canary.category]) ? files[canary.category] : [];
  const file = bucket.find(f => f?.filename === canary.filename);
  if (!file) return 'missing';
  const others = all.filter(c => c !== canary && fileKey(c) === fileKey(canary)).map(c => c.text);
  return canaryStateInFile(canary, file.content, others);
}

/** The stamps in the files only — what an identity edit just did to them. */
export function checkCanariesInFiles({ canaries = [], files = {} } = {}) {
  const all = Array.isArray(canaries) ? canaries.filter(c => c && c.text) : [];
  return all.map(canary => ({ canary, state: stateInFiles(canary, files, all) }));
}

/**
 * Check every registered stamp for this turn.
 * @param {object} p
 * @param {Array} p.canaries   the registry (id, category, filename, text, label, at_end)
 * @param {object} p.files     identity buckets as Phylactery returns them ({ self:[{filename,content}], … })
 * @param {string} p.staticBlock  the identity block this turn actually sends
 * @param {boolean} p.layersIncluded  whether ward/relationship/custom files are part of this room's identity
 * @param {(content:string)=>string} [p.stripGated]  this room's gate-marker stripping (identity for ward turns)
 * @returns {Array<{canary, state}>}
 */
export function checkCanaries({ canaries = [], files = {}, staticBlock = '', layersIncluded = true, stripGated = (s) => s } = {}) {
  const all = Array.isArray(canaries) ? canaries.filter(c => c && c.text) : [];
  return all.map(canary => {
    // No bucket at all = my identity didn't load this turn; that's not the
    // stamp going missing from its file.
    if (!Array.isArray(files?.[canary.category])) return { canary, state: 'not-injected' };
    // Broken in the file itself → broken in every room.
    const inFile = stateInFiles(canary, files, all);
    if (inFile !== 'ok') return { canary, state: inFile };
    const file = files[canary.category].find(f => f?.filename === canary.filename);
    if (canary.category !== 'self' && !layersIncluded) return { canary, state: 'not-in-room' };
    // Gate markers only apply to the non-self layers (as in enrich()).
    if (canary.category !== 'self' && !String(stripGated(file.content ?? '') ?? '').includes(canary.text)) {
      return { canary, state: 'gated' };
    }
    const at = staticBlock.indexOf(canary.text);
    if (at === -1) return { canary, state: 'not-injected' };
    if (canary.at_end) {
      // An end marker closes my identity block: only closing wrapper tags may follow.
      const rest = staticBlock.slice(at + canary.text.length);
      if (!/^(\s*<\/[^>\s]+>)*\s*$/.test(rest)) return { canary, state: 'not-last' };
    }
    return { canary, state: 'ok' };
  });
}

function describe({ canary, state }) {
  const file = fileKey(canary);
  switch (state) {
    case 'missing':      return `isn't in ${file} any more`;
    case 'changed':      return `is in ${file}, but not word for word any more`;
    case 'duplicated':   return `is in ${file} more than once`;
    case 'not-last':     return canary.at_end
      ? `isn't the last thing in my identity any more (something comes after it in ${file} or after that file)`
      : `isn't where it should be in ${file}`;
    case 'not-injected': return `is in ${file}, but didn't make it into my identity this turn`;
    default:             return state;
  }
}

/** The per-turn block: '' when every stamp checks out (or isn't part of this room). */
export function formatCanaryBlock(results) {
  const broken = (results ?? []).filter(r => BROKEN_STATES.has(r.state));
  if (!broken.length) return '';
  return [
    `${CANARY_BLOCK_TITLE} — the app checked my identity stamps this turn and something's off:]`,
    ...broken.map(r => `- "${r.canary.label}" ${describe(r)}.`),
    'If I changed a stamp on purpose, I register the new one with add_identity_canary and retire the old one with retire_identity_canary.',
  ].join('\n');
}

/** What an identity edit tells me when it just broke one of my stamps. '' otherwise. */
export function formatCanaryEditNote(results) {
  const broken = (results ?? []).filter(r => BROKEN_STATES.has(r.state));
  if (!broken.length) return '';
  const parts = broken.map(r => `"${r.canary.label}" ${describe(r)}`);
  return `Heads up: after that edit my canary stamp ${parts.join('; and ')}. If that was on purpose, I register the new stamp with add_identity_canary and retire the old one with retire_identity_canary.`;
}

/** My own list of stamps with where each stands now. */
export function formatCanaryList(results, { lastTurn = new Map() } = {}) {
  if (!results?.length) return "I haven't registered any canary stamps. add_identity_canary registers one: an exact line from one of my identity files.";
  const words = { ok: 'fine', 'not-in-room': 'fine', gated: 'fine' };
  return [
    `My canary stamps (${results.length}):`,
    ...results.map(r => {
      const c = r.canary;
      const last = lastTurn.get(c.id);
      const lastLine = last ? `; last turn: ${BROKEN_STATES.has(last) ? describe({ canary: c, state: last }) : 'in my identity'}` : '';
      return `- "${c.label}" [id: ${c.id}] in ${fileKey(c)}${c.at_end ? ', marks the end of my identity' : ''}: ${words[r.state] ?? describe(r)}${lastLine}`;
    }),
  ].join('\n');
}

// ── State-change log (for my human) ──────────────────────────────────────────
// One line whenever a stamp's state changes (and the first time it's seen
// after a boot), so a stamp that broke at 3am and came back by morning still
// shows up. Ward-visible via GET /api/identity-canaries.
const LOG_DIR = path.join(REPO_ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'identity-canary-events.jsonl');
const _last = new Map();

/** Last state seen per stamp id (for my list and my human's view). */
export function lastCanaryStates() { return new Map(_last); }

export async function recordCanaryStates(results, { surface = 'turn' } = {}) {
  const changes = [];
  for (const { canary, state } of results ?? []) {
    if (_last.get(canary.id) === state) continue;
    changes.push({ at: new Date().toISOString(), surface, id: canary.id, label: canary.label,
      file: fileKey(canary), state, from: _last.get(canary.id) ?? null });
    _last.set(canary.id, state);
  }
  if (!changes.length) return;
  for (const c of changes) {
    if (BROKEN_STATES.has(c.state)) console.warn(`[canary] "${c.label}" (${c.file}) → ${c.state}`);
  }
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    await fsp.appendFile(LOG_FILE, changes.map(c => JSON.stringify(c)).join('\n') + '\n');
  } catch (err) {
    console.warn('[canary] could not write the canary log:', err?.message ?? err);
  }
}

export async function readCanaryEvents({ limit = 50 } = {}) {
  try {
    const lines = (await fsp.readFile(LOG_FILE, 'utf8')).trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
