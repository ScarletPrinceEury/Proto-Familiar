/**
 * text-tool-calls.js — tool calls a model wrote into its reply as text.
 *
 * DeepSeek writes its calls in its own markup (DSML):
 *
 *   <｜DSML｜tool_calls>
 *   <｜DSML｜invoke name="read_file">
 *   <｜DSML｜parameter name="path" string="true">logs/x.json</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜tool_calls>
 *
 * The provider usually turns that into structured `tool_calls`. Sometimes it
 * doesn't, and the markup arrives as the reply's text: nothing runs, and my
 * human (or the bridge) gets markup instead of an answer. Seen live twice on
 * 2026-10-26: a mid-turn call (with a misremembered tool name), and a call
 * written in the closing round after the tool budget ran out, when tools are
 * off.
 *
 * - extractDsmlToolCalls: the complete calls in a text, plus the text without the markup.
 * - settleTextToolCalls: the one decision both tool loops make each round:
 *   recover the calls on a working round, strip them on the closing round.
 * - createDsmlStreamGuard / guardStreamEvent: keep the markup out of a live
 *   stream, so it never renders in the browser.
 *
 * Only DSML is recovered. Its fullwidth-bar tags never occur in prose, so a
 * match is a call. Other written-out shapes (`<tool_call>{…}`, a bare JSON
 * blob) stay detection-only in findTextToolCalls, because prose can produce
 * them. Pure, apart from the guard's own buffer.
 */

const BAR = '[｜|]';
const WRAP = '(?:tool_calls|function_calls)';
const OPEN_RE   = new RegExp(`<${BAR}DSML${BAR}${WRAP}>`);
const CLOSE_RE  = new RegExp(`</${BAR}DSML${BAR}${WRAP}>`);
// A block runs to its closing tag, or to the end of the text when it was cut off.
const BLOCK_RE  = new RegExp(`<${BAR}DSML${BAR}${WRAP}>([\\s\\S]*?)(?:</${BAR}DSML${BAR}${WRAP}>|$)`, 'g');
const INVOKE_RE = new RegExp(`<${BAR}DSML${BAR}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)</${BAR}DSML${BAR}invoke>`, 'g');
const PARAM_RE  = new RegExp(`<${BAR}DSML${BAR}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)</${BAR}DSML${BAR}parameter>`, 'g');
const OPEN_FORMS = ['<｜DSML｜tool_calls>', '<｜DSML｜function_calls>', '<|DSML|tool_calls>', '<|DSML|function_calls>'];

// string="false" marks a JSON value (number, boolean, object); anything else is text.
function paramValue(raw, stringAttr) {
  if (stringAttr === 'false') { try { return JSON.parse(raw); } catch { return raw; } }
  return raw;
}

/** The complete calls in `text` (an invoke cut off mid-way is dropped, never
 *  run half-formed) and the text with every DSML block removed. */
export function extractDsmlToolCalls(text) {
  const s = typeof text === 'string' ? text : '';
  if (!OPEN_RE.test(s)) return { found: false, calls: [], text: s };
  const calls = [];
  const rest = s.replace(BLOCK_RE, (_m, body) => {
    for (const inv of body.matchAll(INVOKE_RE)) {
      const args = {};
      for (const p of inv[2].matchAll(PARAM_RE)) args[p[1]] = paramValue(p[3], p[2]);
      calls.push({ name: inv[1].trim(), arguments: args });
    }
    return '';
  });
  return { found: true, calls, text: rest.replace(/\n{3,}/g, '\n\n').trim() };
}

/** `text` without its DSML blocks; unchanged when it has none. */
export function stripDsmlToolCalls(text) {
  return extractDsmlToolCalls(text).text;
}

/** The tool names written as DSML invokes in `text`, in order (for records). */
export function dsmlInvokeNames(text) {
  const s = typeof text === 'string' ? text : '';
  return [...s.matchAll(INVOKE_RE)].map(m => m[1].trim());
}

/**
 * One round's settling, shared by runToolCallLoop and the streaming loop.
 * - No DSML: everything unchanged.
 * - A working round with no structured calls: the DSML calls become real
 *   tool_calls (ids `${idPrefix}-n`) and run like any other call. A wrong
 *   tool name gets the ordinary unknown-tool result, which tells me.
 * - The closing round (tools off), or a round that also has structured calls:
 *   the markup is stripped and nothing extra runs.
 * Returns { content, toolCalls, recovered, stripped, names }.
 */
export function settleTextToolCalls({ content, toolCalls = [], closing = false, idPrefix = 'textcall' } = {}) {
  const parsed = extractDsmlToolCalls(content);
  if (!parsed.found) return { content, toolCalls, recovered: 0, stripped: false, names: [] };
  const names = parsed.calls.map(c => c.name);
  const hasReal = Array.isArray(toolCalls) && toolCalls.length > 0;
  if (closing || hasReal || !parsed.calls.length) {
    return { content: parsed.text, toolCalls, recovered: 0, stripped: true, names };
  }
  const recovered = parsed.calls.map((c, i) => ({
    id: `${idPrefix}-${i + 1}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.arguments) },
  }));
  return { content: parsed.text, toolCalls: recovered, recovered: recovered.length, stripped: true, names };
}

/**
 * Holds DSML back from a live stream. push(delta) returns the part that is
 * safe to show now; a tail that could still become an opening tag waits for
 * the next delta, and everything inside a block is held. end() returns what
 * was waiting, unless it was an unfinished block.
 */
export function createDsmlStreamGuard() {
  let pending = '';
  let inBlock = false;
  const couldOpen = (tail) => OPEN_FORMS.some(f => f.startsWith(tail));
  function drain() {
    let out = '';
    for (;;) {
      if (inBlock) {
        const m = pending.match(CLOSE_RE);
        if (!m) return out;
        pending = pending.slice(m.index + m[0].length);
        inBlock = false;
        continue;
      }
      const m = pending.match(OPEN_RE);
      if (m) {
        out += pending.slice(0, m.index);
        pending = pending.slice(m.index);
        inBlock = true;
        continue;
      }
      const lt = pending.lastIndexOf('<');
      if (lt >= 0 && couldOpen(pending.slice(lt))) {
        out += pending.slice(0, lt);
        pending = pending.slice(lt);
      } else {
        out += pending;
        pending = '';
      }
      return out;
    }
  }
  return {
    push(delta) { pending += String(delta ?? ''); return drain(); },
    end() { const out = inBlock ? '' : pending; pending = ''; inBlock = false; return out; },
  };
}

/**
 * One parsed SSE event through the guard. Returns the line to forward: the
 * original when nothing changed, a rewritten event when part of its content
 * was held, or null when the event carried only held content.
 */
export function guardStreamEvent(evt, line, guard) {
  const delta = evt?.choices?.[0]?.delta;
  if (typeof delta?.content !== 'string' || !delta.content) return line;
  const safe = guard.push(delta.content);
  if (safe === delta.content) return line;
  const onlyContent = Object.keys(delta).every(k => k === 'content' || k === 'role')
    && !evt.choices[0].finish_reason && !evt.usage;
  if (!safe && onlyContent) return null;
  const copy = { ...evt, choices: [{ ...evt.choices[0], delta: { ...delta, content: safe } }, ...evt.choices.slice(1)] };
  return `data: ${JSON.stringify(copy)}`;
}
