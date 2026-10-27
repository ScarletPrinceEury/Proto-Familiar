/**
 * tome-reader.js — how I read my own tomes on purpose (the read_tome tool).
 *
 * Tome lore only reaches me when a keyword in the conversation wakes an entry,
 * and a quiet moment (noticing, a free cycle) has no conversation to wake
 * anything. So without this I couldn't open a note I wrote myself unless
 * someone happened to say its keyword. Here I can open a tome, see its entries
 * newest first, search inside one or across all of them, and read one entry in
 * full, in parts when it's long.
 *
 * Entries are keyed by uid (a UUID for the ones I save, a number for imported
 * lorebooks). What I see instead is a readable alias, `slugifyLabel(title)-xx`,
 * where the tail comes from the uid, so it's the same every time I look and
 * needs nothing stored. The tail grows when two entries in one tome would share
 * an alias. A lookup accepts the alias, a shorter older alias that still points
 * at one entry, the raw uid, or the entry's title.
 *
 * Pure apart from the tomes passed in. Returns the text I read; never throws.
 */
import { slugifyLabel, slugCore } from '../../slug-ids.js';

export const PAGE_SIZE   = 25;
export const ENTRY_CHARS = 16_000;
const SEARCH_PAGE = 15;
const SNIPPET     = 90;
const KEYS_SHOWN  = 4;

const lc      = (s) => String(s ?? '').trim().toLowerCase();
const nameOf  = (t) => String(t?.name ?? '').trim() || '(unnamed)';
const titleOf = (e) => String(e?.comment ?? '').trim() || '(untitled)';
const dateOf  = (e) => String(e?.learnedAt || e?.created_at || '').slice(0, 10);
const num     = (n) => n.toLocaleString('en-US');

/** A tome's entries as a list: { uid, e }, newest first; undated ones keep file order after. */
export function tomeEntries(tome) {
  const raw = tome?.entries && typeof tome.entries === 'object' ? Object.entries(tome.entries) : [];
  const list = raw
    .filter(([, e]) => e && typeof e === 'object')
    .map(([key, e], i) => ({ uid: String(e.uid ?? key), e, i }));
  const at = (x) => Date.parse(x.e.learnedAt || x.e.created_at || '') || null;
  return list.sort((a, b) => {
    const ta = at(a), tb = at(b);
    if (ta && tb && ta !== tb) return tb - ta;
    if (ta && !tb) return -1;
    if (tb && !ta) return 1;
    return a.i - b.i;
  });
}

const tailOf = (uid) => slugCore(uid).replace(/-/g, '') || '0';
const baseOf = (e) => slugifyLabel(e?.comment) || 'entry';

/** uid → alias for every entry in one tome. */
export function entryAliases(list) {
  const groups = new Map();
  for (const x of list) {
    const base = baseOf(x.e);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(x);
  }
  const out = new Map();
  for (const [base, group] of groups) {
    const longest = Math.max(...group.map(x => tailOf(x.uid).length));
    let len = Math.min(2, longest);
    while (len < longest && new Set(group.map(x => tailOf(x.uid).slice(0, len))).size < group.length) len++;
    const tails = group.map(x => tailOf(x.uid).slice(0, len));
    const clash = new Set(tails).size < group.length;
    group.forEach((x, i) => out.set(x.uid, `${base}-${tails[i]}${clash ? `-${i + 1}` : ''}`));
  }
  return out;
}

/** Pick a tome by name: exact (any case), else the only one whose name contains it. */
export function findTome(tomes, name) {
  const want = lc(name);
  if (!want) return { tome: null, matches: [] };
  const exact = tomes.filter(t => lc(nameOf(t)) === want);
  if (exact.length) return { tome: exact.length === 1 ? exact[0] : null, matches: exact };
  const part = tomes.filter(t => lc(nameOf(t)).includes(want));
  return { tome: part.length === 1 ? part[0] : null, matches: part };
}

/** Find one entry by alias, older shorter alias, uid, or title (as stored, or with its macros filled in by `r`). */
export function findEntry(list, aliases, ref, r = (s) => s) {
  const want = lc(ref);
  if (!want) return { hit: null, matches: [] };
  const one = (xs) => ({ hit: xs.length === 1 ? xs[0] : null, matches: xs });
  const byAlias = list.filter(x => aliases.get(x.uid) === want);
  if (byAlias.length) return one(byAlias);
  const byUid = list.filter(x => lc(x.uid) === want);
  if (byUid.length) return one(byUid);
  // An alias minted before the tome grew a look-alike (its tail was shorter).
  const m = /^(.*)-([a-z0-9]+)$/.exec(want);
  if (m) {
    const older = list.filter(x => baseOf(x.e) === m[1] && tailOf(x.uid).startsWith(m[2]));
    if (older.length) return one(older);
  }
  const titles = (x) => [lc(titleOf(x.e)), lc(r(titleOf(x.e)))];
  const byTitle = list.filter(x => titles(x).includes(want));
  if (byTitle.length) return one(byTitle);
  return one(list.filter(x => titles(x).some(t => t.includes(want))));
}

function entryLine(x, alias, r) {
  const keys = Array.isArray(x.e.keys) ? x.e.keys.filter(Boolean) : [];
  const bits = [
    alias,
    `"${r(titleOf(x.e))}"`,
    `${num(String(x.e.content ?? '').length)} chars`,
    dateOf(x.e),
    keys.length ? `keys: ${keys.slice(0, KEYS_SHOWN).join(', ')}${keys.length > KEYS_SHOWN ? ', …' : ''}` : '',
  ].filter(Boolean);
  return `- ${bits.join(' · ')}${x.e.enabled === false ? ' [off]' : ''}`;
}

function snippet(text, words) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  const at = Math.min(...words.map(w => low.indexOf(w)).filter(i => i >= 0));
  if (!Number.isFinite(at)) return '';
  const start = Math.max(0, at - SNIPPET);
  const end = Math.min(flat.length, at + SNIPPET);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

function pageOf(total, size, page) {
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  return { p, pages, start: (p - 1) * size, end: Math.min(total, p * size) };
}

function listTome(tome, page, r) {
  const list = tomeEntries(tome);
  const name = nameOf(tome);
  if (!list.length) return `${name} has no entries yet.`;
  const aliases = entryAliases(list);
  const { p, pages, start, end } = pageOf(list.length, PAGE_SIZE, page);
  const head = pages > 1
    ? `${name}: ${num(list.length)} entries, newest first. Page ${p} of ${pages} (${start + 1}–${end}).`
    : `${name}: ${num(list.length)} entr${list.length === 1 ? 'y' : 'ies'}, newest first.`;
  const lines = list.slice(start, end).map(x => entryLine(x, aliases.get(x.uid), r));
  const more = p < pages ? ` Page ${p + 1} has the next ones.` : '';
  return `${head}${tome.enabled === false ? ' (This tome is switched off, so it doesn\'t come up on its own.)' : ''}\n${lines.join('\n')}\nI read one in full with read_tome, this tome and its id as entry.${more}`;
}

function searchTomes(tomes, query, page, r) {
  const words = lc(query).split(/\s+/).filter(Boolean);
  const hits = [];
  for (const tome of tomes) {
    const list = tomeEntries(tome);
    const aliases = entryAliases(list);
    for (const x of list) {
      const hay = lc([r(titleOf(x.e)), ...(Array.isArray(x.e.keys) ? x.e.keys : []), r(String(x.e.content ?? ''))].join('\n'));
      if (words.every(w => hay.includes(w))) hits.push({ tome, x, alias: aliases.get(x.uid) });
    }
  }
  const where = tomes.length === 1 ? nameOf(tomes[0]) : 'my tomes';
  if (!hits.length) return `Nothing in ${where} has all of "${words.join(' ')}".`;
  const { p, pages, start, end } = pageOf(hits.length, SEARCH_PAGE, page);
  const head = `${num(hits.length)} entr${hits.length === 1 ? 'y' : 'ies'} in ${where} with "${words.join(' ')}"${pages > 1 ? `, page ${p} of ${pages}` : ''}:`;
  const lines = hits.slice(start, end).map(({ tome, x, alias }) => {
    const s = snippet(r(String(x.e.content ?? '')), words);
    return `${entryLine(x, alias, r)}${tomes.length > 1 ? ` · in ${nameOf(tome)}` : ''}${s ? `\n  ${s}` : ''}`;
  });
  const more = p < pages ? ` Page ${p + 1} has the next ones.` : '';
  return `${head}\n${lines.join('\n')}\nI read one in full with read_tome, its tome and its id as entry.${more}`;
}

// A long entry comes in parts. A part ends at a line break or space near the
// limit, and `from` for the next part is worked out here, never by me.
function readEntry(tome, x, alias, from, resolve) {
  const text = resolve(String(x.e.content ?? ''));
  const total = text.length;
  const start = Math.min(Math.max(0, Math.floor(Number(from)) || 0), total);
  let end = Math.min(total, start + ENTRY_CHARS);
  if (end < total) {
    const cut = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf(' ', end));
    if (cut > start + ENTRY_CHARS * 0.8) end = cut;
  }
  const keys = Array.isArray(x.e.keys) ? x.e.keys.filter(Boolean) : [];
  const facts = [dateOf(x.e) && `saved ${dateOf(x.e)}`, `${num(total)} chars`, keys.length && `keys: ${keys.join(', ')}`, x.e.enabled === false && 'switched off'].filter(Boolean);
  const head = `"${resolve(titleOf(x.e))}" (${alias}) in ${nameOf(tome)} — ${facts.join(', ')}.`;
  if (!total) return `${head}\nThe entry is empty.`;
  if (start >= total) return `${head}\nThat's past the end: it has ${num(total)} characters.`;
  const part = start > 0 || end < total ? `\n(Characters ${num(start)}–${num(end)} of ${num(total)}.)` : '';
  const rest = end < total ? `\n…(The rest: read_tome with from: ${end}.)` : '';
  return `${head}${part}\n\n${text.slice(start, end)}${rest}`;
}

const names = (ts) => ts.map(nameOf).join(', ');

/**
 * The read_tome result.
 *   tomes  — every tome, parsed (readAllTomes)
 *   args   — { tome, entry, query, page, from } as I passed them
 *   resolve — turns tome macros into their live values (resolveTomeMacros)
 */
export function readTomeText(tomes, { tome, entry, query, page, from } = {}, { resolve = (s) => s } = {}) {
  const all = Array.isArray(tomes) ? tomes : [];
  if (!all.length) return 'I don\'t keep any tomes yet.';
  const q = typeof query === 'string' ? query.trim() : '';
  const tName = typeof tome === 'string' ? tome.trim() : '';
  const ref = entry == null ? '' : String(entry).trim();

  if (!tName) {
    if (q) return searchTomes(all, q, page, resolve);
    return `I need a tome's name, or something to search for across all of them. My tomes: ${names(all)}.`;
  }
  const { tome: t, matches } = findTome(all, tName);
  if (!t) {
    return matches.length
      ? `More than one tome fits "${tName}": ${names(matches)}. I use the full name.`
      : `I don't keep a tome called "${tName}". My tomes: ${names(all)}.`;
  }
  if (ref) {
    const list = tomeEntries(t);
    const aliases = entryAliases(list);
    const { hit, matches: found } = findEntry(list, aliases, ref, resolve);
    if (hit) return readEntry(t, hit, aliases.get(hit.uid), from, resolve);
    if (found.length) {
      const shown = found.slice(0, SEARCH_PAGE).map(x => entryLine(x, aliases.get(x.uid), resolve));
      return `More than one entry in ${nameOf(t)} fits "${ref}":\n${shown.join('\n')}\nI use one of these ids.`;
    }
    return `No entry in ${nameOf(t)} matches "${ref}". I can list them with read_tome and just the tome, or search it with query.`;
  }
  if (q) return searchTomes([t], q, page, resolve);
  return listTome(t, page, resolve);
}
