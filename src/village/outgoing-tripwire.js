/**
 * Outgoing tripwire — what code checks in a message before it goes to someone
 * other than my human (docs/known-issues-fix-plans.md C1).
 *
 * The incident: a referral code that was my human's full legal name turned
 * into a handle went to a group channel through relay_message. Nothing could
 * catch it: the restricted-memory check only matches things stored as
 * private, and the name was stored nowhere.
 *
 * Two checks, two strengths:
 *  - The keep-between-us list (`privateIdentifiers` in settings.json, set by my
 *    human in the Knowledge editor, never put in any prompt). Matched with its
 *    spelling variants ("Robin Smith" also catches Robin_Smith01, robin.smith,
 *    RobinSmith, Smith Robin). Checked on EVERY path out to others; a relay is
 *    held and can't be sent as-is, a live reply gets the match swapped for
 *    "[private]".
 *  - The shape check: things shaped like a name turned into a handle, a code
 *    or id, contact info, an invite/referral link. Relays only, since relaying
 *    is carrying my human's material to someone; in a live room people share
 *    handles and codes on purpose. A hit holds the relay until my human okays
 *    it (held-relays.js). I have no way to okay it myself, so text I was handed
 *    can't talk me into sending it.
 *
 * Pure: no I/O, no settings reads. Callers pass the list in.
 */

export const PRIVATE_STAND_IN = '[private]';

// Separators a name gets welded with when it becomes a handle.
const SEP = '[\\s._\\-]*';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function tokensOf(entry) {
  return String(entry ?? '').trim().split(/[\s._\-]+/).filter(Boolean);
}

/** The list as my human saved it: trimmed, de-duplicated, ≥3 characters. */
export function normalizePrivateList(list) {
  const out = [], seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const entry = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (entry.replace(/[\s._\-]/g, '').length < 3) continue;   // too short to match safely
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry.slice(0, 120));
  }
  return out.slice(0, 50);
}

// One entry → a regex source matching it with any separators, in either order
// for two-or-more-word entries, plus trailing digits (Robin_Smith01).
function entryPattern(entry) {
  const tokens = tokensOf(entry).map(escapeRe);
  if (!tokens.length) return null;
  const orders = [tokens];
  if (tokens.length > 1) orders.push([...tokens].reverse());
  const body = orders.map(t => t.join(SEP)).join('|');
  return `(?<![\\p{L}\\p{N}])(?:${body})\\d*(?![\\p{L}\\p{N}])`;
}

/**
 * Every place `text` contains something from the list. Non-overlapping,
 * in order. Returns [{entry, match, index}].
 */
export function protectedHits(text, list) {
  const s = String(text ?? '');
  const hits = [];
  for (const entry of normalizePrivateList(list)) {
    const src = entryPattern(entry);
    if (!src) continue;
    for (const m of s.matchAll(new RegExp(src, 'giu'))) hits.push({ entry, match: m[0], index: m.index });
  }
  hits.sort((a, b) => a.index - b.index || b.match.length - a.match.length);
  const out = [];
  let end = -1;
  for (const h of hits) {
    if (h.index < end) continue;
    out.push(h);
    end = h.index + h.match.length;
  }
  return out;
}

/** `text` with each list match swapped for the stand-in. */
export function redactProtected(text, list, standIn = PRIVATE_STAND_IN) {
  const s = String(text ?? '');
  const hits = protectedHits(s, list);
  if (!hits.length) return { text: s, hits };
  let out = '', at = 0;
  for (const h of hits) {
    out += s.slice(at, h.index) + standIn;
    at = h.index + h.match.length;
  }
  return { text: out + s.slice(at), hits };
}

/** A few of the spellings an entry will catch, for the Knowledge editor. */
export function variantExamples(entry) {
  const t = tokensOf(entry);
  if (!t.length) return [];
  if (t.length === 1) return [t[0], `${t[0]}01`, t[0].toLowerCase()];
  const [a, b] = [t[0], t[t.length - 1]];
  return [t.join(' '), t.join('_') + '01', t.join('.').toLowerCase(), t.join(''), `${b} ${a}`];
}

// ── The relay-only shape check ───────────────────────────────────────────────

// Two capitalised words welded by _ or . (Robin_Smith, Robin.Smith01), or
// welded with digits after (RobinSmith01, Robin-Smith01). A plain hyphen
// alone (Jean-Luc, New-York) is how names and places are written, not a handle.
const NAME_HANDLE = /(?<![\p{L}\p{N}])\p{Lu}\p{Ll}{2,}(?:[._]\p{Lu}\p{Ll}{2,}\d*|[._\-]?\p{Lu}\p{Ll}{2,}\d{2,})(?![\p{L}\p{N}])/gu;
const LOWER_HANDLE = /(?<![\p{L}\p{N}])\p{Ll}{3,}[._]\p{Ll}{3,}\d{2,}(?![\p{L}\p{N}])/gu;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /(?<![\w])\+?\d[\d\s().\-]{7,}\d(?![\w])/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const INVITE_URL = /([?&](ref|referral|refcode|invite|invite_code|code|token|aff|affiliate|promo)=)|discord\.gg\/|discord(app)?\.com\/invite\/|\/(invite|ref|referral)\//i;
// Codes: one token, letters AND at least two digits, uppercase or long.
const CODE_TOKEN = /(?<![\p{L}\p{N}_])[A-Za-z0-9][A-Za-z0-9\-]{5,}(?![\p{L}\p{N}_])/gu;

function looksLikeCode(tok) {
  const digits = (tok.match(/\d/g) ?? []).length;
  const letters = (tok.match(/[A-Za-z]/g) ?? []).length;
  if (digits < 2 || letters < 2) return false;
  if (/^[A-Z0-9\-]+$/.test(tok)) return true;              // REF-8842-KQ, A7K29XQ2
  return tok.replace(/-/g, '').length >= 10;              // aB3dE5fG7h-style ids
}

/**
 * Things in a relay that look like they shouldn't leave without my human's
 * okay. `knownNames` (my human's and villagers' names) also catch a known name
 * welded into a handle ("RobinSmith", "Sam42"). Returns [{kind, match}] where
 * kind is 'name-handle' | 'code' | 'contact' | 'link'.
 */
export function relayShapeHits(text, { knownNames = [] } = {}) {
  const s = String(text ?? '');
  const out = [], seen = new Set();
  const add = (kind, match) => {
    const key = `${kind}|${match.toLowerCase()}`;
    if (seen.has(key) || out.some(h => h.match.includes(match))) return;
    seen.add(key);
    out.push({ kind, match });
  };

  for (const m of s.matchAll(URL_RE)) if (INVITE_URL.test(m[0])) add('link', m[0]);
  const urlFree = s.replace(URL_RE, ' ');
  for (const m of urlFree.matchAll(EMAIL)) add('contact', m[0]);
  const noEmail = urlFree.replace(EMAIL, ' ');
  for (const m of noEmail.matchAll(PHONE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 9 && !ISO_DATE.test(m[0].trim())) add('contact', m[0].trim());
  }
  for (const m of noEmail.matchAll(NAME_HANDLE)) add('name-handle', m[0]);
  for (const m of noEmail.matchAll(LOWER_HANDLE)) add('name-handle', m[0]);
  for (const name of knownNames) {
    const tokens = tokensOf(name).map(escapeRe);
    if (!tokens.length || tokens.join('').length < 3) continue;
    const welded = tokens.length > 1
      ? `${tokens.join('[._\\-]?')}\\d*`
      : `${tokens[0]}[._\\-]?\\d{2,}`;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${welded})(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of noEmail.matchAll(re)) if (tokens.length === 1 || !/\s/.test(m[0])) add('name-handle', m[0]);
  }
  for (const m of noEmail.matchAll(CODE_TOKEN)) if (looksLikeCode(m[0])) add('code', m[0]);
  return out;
}

/**
 * Both checks for a relay. `hold` is 'protected' (something from the list —
 * never sent as-is), 'shape' (waits for my human's okay) or null (fine).
 */
export function checkRelay(text, { privateList = [], knownNames = [] } = {}) {
  if (protectedHits(text, privateList).length) return { hold: 'protected', hits: [] };
  const hits = relayShapeHits(text, { knownNames });
  return { hold: hits.length ? 'shape' : null, hits };
}

const KIND_PHRASE = {
  'name-handle': 'looks like somebody\'s name turned into a handle',
  code: 'looks like a code or an id',
  contact: 'looks like contact info',
  link: 'looks like an invite or referral link',
};

/** `"X" looks like …` for the first hit, plus "and N more". */
export function describeShapeHits(hits) {
  if (!Array.isArray(hits) || !hits.length) return '';
  const [first, ...rest] = hits;
  return `"${first.match}" ${KIND_PHRASE[first.kind] ?? 'looks like something private'}${rest.length ? `, and there's ${rest.length} more like it` : ''}`;
}
