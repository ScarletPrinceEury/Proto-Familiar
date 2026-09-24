// LLM-generated timestamp patterns that must be stripped from any outgoing
// message before it reaches a human or a platform.  The model sees these in
// injected history and imitates them in its replies; only machine-set
// timestamps (from the message's own `timestamp` field) may be trusted.
//
// Both patterns stripped globally so they are removed wherever the LLM
// echoed them — accumulation at the head is the common case, but mid-prose
// echoes have also been observed.
//
// Browser-side mirror: public/app.js `stripDisplayTimestamps` — kept
// separate because the browser can't import server ESM modules.

const _TS_CHEVRON = /⫸\d{1,2}:\d{2}⫷\s*/g;   // web-chat format
const _TS_BRACKET = /\[\d{1,2}:\d{2}\]\s*/g;    // Discord / legacy web format

export function stripLlmTimestamps(text) {
  if (typeof text !== 'string') return text;
  return text.replace(_TS_CHEVRON, '').replace(_TS_BRACKET, '');
}

// ── Tool-call scaffolding is turn-internal, not conversational history ───────
//
// A turn that used tools is stored as several messages: an assistant "carrier"
// (often `content: null`, sometimes a mid-sentence preamble like "Let me check—")
// carrying `tool_calls`, then the `role:'tool'` results, then the final reply.
// That whole run is scaffolding for ONE reply. When it is re-injected verbatim
// as history on a LATER turn, the model reads its own past turns as `null`
// (the null carrier) or as a sentence that stops mid-thought (the preamble
// carrier, split from the answer it belonged to) — even though my human received
// the reply whole. Reported on both web and Discord (a null carrier renders as
// literal "[HH:MM] null" once a machine timestamp is prepended); unified sessions
// carry web-origin carriers onto the Discord side too.
//
// So before history reaches the model, collapse each tool-scaffolding run into
// the single clean assistant turn it represents: drop `role:'tool'` results,
// drop the `tool_calls` field, and MERGE a carrier with the reply it precedes so
// all the text my human actually saw survives as one coherent turn. Two
// genuinely independent assistant messages (e.g. proactive banners, with no
// tool_calls and no tool run between them) are never merged. Pure; tolerates a
// vision-era array `content` (keeps its text part).
export function collapseToolTurns(messages = []) {
  if (!Array.isArray(messages)) return messages;
  const textOf = (m) => {
    const c = m?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.find(p => p?.type === 'text')?.text ?? '';
    return '';
  };
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') { out.push(m); continue; }
    if (m.role === 'tool') continue;                    // tool results never re-enter history
    if (m.role === 'assistant') {
      const isCarrier = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      const text = textOf(m);
      const prev = out[out.length - 1];
      // Merge only within a tool-scaffolding run: the previous emitted turn was a
      // carrier, or this message is one. Never fold two standalone replies together.
      if (prev && prev.role === 'assistant' && (prev._carrier || isCarrier)) {
        prev.content = [prev.content, text].map(s => String(s ?? '').trim()).filter(Boolean).join('\n\n');
        prev._carrier = isCarrier;   // still mergeable mid-run; sealed once a plain final lands
        continue;
      }
      const { tool_calls, ...rest } = m;               // drop tool_calls from history
      out.push({ ...rest, content: text, _carrier: isCarrier });
      continue;
    }
    out.push(m);                                        // user / system / anything else
  }
  return out
    .map(m => {
      if (!m || typeof m !== 'object') return m;
      // Drop the internal merge marker AND `moodTag` (mood-send, §6, INVARIANT
      // T1). A mood tag is metadata for the Mood tracker + the memorization
      // calibration corpus ONLY — it must never reach a live provider prompt.
      // This is THE provider-history boundary (web /api/chat + Discord), so
      // stripping here guarantees a tagged message's assembled payload is
      // byte-free of it, whatever a client sends (belt to the client's suspenders).
      const { _carrier, moodTag, ...rest } = m;
      return rest;
    })
    .filter(m => !(m && m.role === 'assistant' && !String(m.content ?? '').trim()));
}

// The dynamic-context depth: how many turns from the END the dynamic block sits,
// so it rides just above the freshest exchange (where it's most salient) while
// the stable prefix above it stays byte-identical for the provider's prefix
// cache. Pure — reads a settings object, clamps [1,50], defaults 4. Shared by
// the web turn (server.js) and the Discord turn (discord-gateway.js) so both
// surfaces place the block identically.
export function resolveDynamicDepth(settings) {
  const d = parseInt(settings?.thalamusDynamicDepth, 10);
  if (Number.isFinite(d) && d >= 1 && d <= 50) return d;
  return 4;
}

// Insert `dynamicContent` as a system message `depth` positions from the end of
// `messages`, leaving the array stable above that point for the provider's
// prefix cache. Returns the new array plus the actual index used (so an inspector
// can show where it landed). Pure.
//
// Two clamps:
//   - lower bound `1` when there's a system message at index 0 — keeps the
//     dynamic injection BELOW the static prefix so the cache stays valid; `0`
//     otherwise (no leading system → no prefix to protect).
//   - upper bound is the array length — on a very short conversation `len - depth`
//     would go negative, so it's floored to the lower bound.
//
// No-op (messages unchanged, injectedAt=null) when dynamicContent is empty.
export function injectDynamicAtDepth(messages, dynamicContent, depth) {
  if (!dynamicContent) return { messages, injectedAt: null };
  const list = Array.isArray(messages) ? messages : [];
  const hasSystemAtStart = list.length > 0 && list[0]?.role === 'system';
  const minIdx = hasSystemAtStart ? 1 : 0;
  const injectedAt = Math.max(minIdx, list.length - depth);
  const dynamicMsg = { role: 'system', content: dynamicContent };
  return {
    messages: [...list.slice(0, injectedAt), dynamicMsg, ...list.slice(injectedAt)],
    injectedAt,
  };
}
