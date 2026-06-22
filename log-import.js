/**
 * Foreign-log import (day-anchoring Phase 4).
 *
 * Parses logs from elsewhere into Proto-Familiar's normalized message shape so
 * they can be placed by date (segmentByDay) and ingested through the normal
 * memorization pipeline. Parsers are tried in order; each returns
 * { messages, format } or null. Unknown input → a loud, structured error (no
 * silent best-effort — a mis-parsed log is worse than a rejected one).
 *
 * Normalized message: { role:'user'|'assistant'|'system', content, timestamp(ISO|null), speaker? }
 * Date placement needs timestamps, so a parse with NO timestamps anywhere is
 * rejected too (segmentByDay can forward-fill gaps, but it needs an anchor).
 */

// Coerce a value to an ISO string, or null. Accepts epoch (s or ms), ISO, and
// most Date-parseable strings.
export function toIso(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v; // 10-digit = seconds, 13-digit = ms
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function normRole(r) {
  return r === 'assistant' ? 'assistant' : r === 'system' ? 'system' : 'user';
}

// Pull a YYYY-MM-DD out of a filename for logs with no per-message timestamps
// (e.g. a SillyTavern export named "...2025-05-23..." or "...20250523...").
// Matches an ISO-ish run anywhere in the name, validating month/day; null if none.
export function dateFromFilename(name) {
  if (typeof name !== 'string') return null;
  const m = name.match(/(20\d{2})[-_]?(0[1-9]|1[0-2])[-_]?(0[1-9]|[12]\d|3[01])/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Stamp undated messages with a single calendar date (local noon, so the local
// day can't drift at timezone edges). Used when a whole log lacks timestamps.
export function applyFallbackDate(messages, date) {
  const [y, mo, d] = date.split('-').map(Number);
  const iso = new Date(y, mo - 1, d, 12).toISOString();
  return messages.map(m => (m.timestamp ? m : { ...m, timestamp: iso }));
}

// ── Parser: Proto-Familiar session-log JSON (single, bundle, or raw array) ────
function parsePfJson(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return null; }

  let msgs = null;
  if (Array.isArray(data)) {
    if (data.length && Array.isArray(data[0]?.messages)) msgs = data.flatMap(s => s.messages ?? []);
    else if (data.length && (typeof data[0]?.content === 'string')) msgs = data; // raw message array
  } else if (Array.isArray(data?.sessions)) {
    msgs = data.sessions.flatMap(s => s.messages ?? []);
  } else if (Array.isArray(data?.messages)) {
    msgs = data.messages;
  }
  if (!Array.isArray(msgs)) return null;

  const out = msgs
    .filter(m => typeof m?.content === 'string' && m.content.trim())
    .map(m => ({ role: normRole(m.role), content: m.content, timestamp: toIso(m.timestamp) }));
  return out.length ? { messages: out, format: 'Proto-Familiar JSON' } : null;
}

// ── Parser: timestamped text/markdown ────────────────────────────────────────
// Lines shaped `[<timestamp>] <Speaker>: <text>`; untagged lines continue the
// previous message. `selfNames` (the AI/assistant speaker name[s]) map to the
// assistant role — everyone else is 'user' (dyadic assumption; multi-party logs
// collapse non-self speakers to one role, documented as a v1 limitation).
const TS_LINE = /^\s*\[([^\]]+)\]\s*([^:]{1,60}?):\s*(.*)$/;
export function parseTimestampedText(raw, { selfNames = [] } = {}) {
  const self = new Set(selfNames.map(s => String(s).trim().toLowerCase()).filter(Boolean));
  const out = [];
  let cur = null;
  for (const line of String(raw).split(/\r?\n/)) {
    const m = line.match(TS_LINE);
    if (m) {
      const speaker = m[2].trim();
      cur = {
        role: self.has(speaker.toLowerCase()) ? 'assistant' : 'user',
        content: m[3],
        timestamp: toIso(m[1].trim()),
        speaker,
      };
      out.push(cur);
    } else if (cur && line.trim()) {
      cur.content += '\n' + line;
    }
  }
  const usable = out.filter(m => m.content.trim());
  if (usable.length < 2 || !usable.some(m => m.timestamp)) return null;
  return { messages: usable, format: 'timestamped text' };
}

// ── Parser: SillyTavern chat (.jsonl) ────────────────────────────────────────
// One JSON object per line: an optional metadata line first ({chat_metadata,
// user_name, character_name}), then messages {name, is_user, is_system,
// send_date, mes, swipes…}. is_user gives the role; send_date is ISO; mes is the
// active swipe. System lines are skipped.
export function parseSillyTavern(raw) {
  const lines = String(raw).split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return null;
  const out = [];
  let sawMessage = false;
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { return null; } // a non-JSON line → not ST JSONL
    if (o && typeof o.mes === 'string' && ('is_user' in o)) {
      sawMessage = true;
      if (o.is_system || !o.mes.trim()) continue;
      out.push({
        role: o.is_user ? 'user' : 'assistant',
        content: o.mes,
        timestamp: toIso(o.send_date),
        speaker: typeof o.name === 'string' ? o.name : undefined,
      });
    } else if (o && (o.chat_metadata !== undefined || o.user_name !== undefined || o.character_name !== undefined)) {
      continue; // metadata line — skip
    } else {
      return null; // unexpected shape → let another parser try (it won't), then error
    }
  }
  return sawMessage && out.length >= 2 ? { messages: out, format: 'SillyTavern' } : null;
}

// Registry — order matters (JSON shapes before the text catch-all). OpenClaw
// slots in here once its real format is confirmed.
const PARSERS = [
  parsePfJson,
  parseSillyTavern,
  parseTimestampedText,
];

export const SUPPORTED_FORMATS = ['Proto-Familiar JSON', 'SillyTavern (.jsonl)', 'timestamped text'];

/**
 * Parse `raw` into normalized messages. Returns { ok, messages, format } or
 * { ok:false, error }. `opts.selfNames` aids the text parser's role mapping.
 */
export function parseImport(raw, opts = {}) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'Nothing to import (empty content).' };
  }
  for (const parser of PARSERS) {
    let r = null;
    try { r = parser(raw, opts); } catch { r = null; }
    if (r && Array.isArray(r.messages) && r.messages.length) {
      return { ok: true, messages: r.messages, format: r.format };
    }
  }
  return {
    ok: false,
    error: `Couldn't recognise this log format. Supported: ${SUPPORTED_FORMATS.join(', ')}.`,
  };
}
