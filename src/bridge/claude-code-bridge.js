/**
 * The Claude Code bridge (0.14.88, ward decision): a direct line between Claude
 * Code — the coding agent my human builds me with — and me.
 *
 * Claude Code used to reach me by driving the web chat, sitting in my human's
 * seat; I answered my human, and its words counted as theirs. Through this
 * bridge, every message is Claude Code's by construction: its own conversation,
 * every turn tagged with the `Claude Code` speaker (web-speakers.js), so I read
 * "[Claude Code]: …", memory files it under that name, and it is never scored as
 * my human's distress or counted as them being around.
 *
 * One rule, not two: the bridge only runs while "Claude Code" is on my human's
 * list of others who may type in my web chat. Take it off and the bridge stops,
 * rather than Claude Code's words quietly becoming my human's.
 *
 * Nothing here is hidden from my human: the conversation is an ordinary session
 * log (location "Claude Code bridge") they can open like any other.
 *
 * The turn itself is the ordinary /api/chat path (tools, enrichment, the [Now]
 * line, the turn log), the same seam voice-chat-turn.js uses — never a second
 * copy of the chat machinery.
 */
import path from 'path';
import { promises as fsp, mkdirSync } from 'fs';
import { REPO_ROOT } from '../../repo-root.js';
import { extractTurnReply } from '../../llm-call.js';
import { connectionReady } from '../../providers.js';
import { stripLlmTimestamps } from '../../message-sanitize.mjs';
import { sessionSlugId } from '../../slug-ids.js';
import { writeSessionLog } from '../sessions/session-log.js';
import { speakerOf } from '../village/web-speakers.js';

export const BRIDGE_SPEAKER = 'Claude Code';
export const BRIDGE_LOCATION = { platform: 'bridge', label: 'Claude Code bridge' };

// A thinking model on high effort can take minutes per turn, and a turn may run
// several tool rounds. Long, but finite.
const BRIDGE_TURN_TIMEOUT_MS = 9 * 60_000;
// RULE A: thinking models bill reasoning against max_tokens.
const BRIDGE_MAX_TOKENS = 8000;

const STATE_FILE = path.join(REPO_ROOT, 'tomes', '.claude-code-bridge.json');

/**
 * What one bridge turn stores: Claude Code's message, each tool round in the
 * shape the web client stores (so "[Last turn, tools used: …]" works here too),
 * and my reply. Pure.
 */
export function bridgeTurnMessages({ text, data, reply, at = new Date().toISOString() }) {
  let n = 0;
  const id = () => `${at}-${n++}`;
  const out = [{ id: id(), role: 'user', content: text, timestamp: at, speaker: BRIDGE_SPEAKER }];
  for (const round of (Array.isArray(data?._toolRounds) ? data._toolRounds : [])) {
    const ts = round.timestamp || at;
    const calls = Array.isArray(round.toolCalls) ? round.toolCalls : [];
    out.push({ id: id(), role: 'assistant', content: round.content || null, tool_calls: calls, timestamp: ts });
    for (const r of (Array.isArray(round.results) ? round.results : [])) {
      out.push({ id: id(), role: 'tool', tool_call_id: r.tool_call_id, content: r.content, timestamp: ts, _toolName: r.name });
    }
  }
  out.push({ id: id(), role: 'assistant', content: reply, timestamp: new Date().toISOString() });
  return out;
}

/** History as /api/chat takes it: role/content/tool fields, plus the speaker. */
function toApiHistory(messages) {
  return (Array.isArray(messages) ? messages : []).map(m => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    const base = { role: m.role, content: m.content ?? null };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) base.tool_calls = m.tool_calls;
    if (m.role === 'user' && m.speaker) base.speaker = m.speaker;
    return base;
  });
}

export function createClaudeCodeBridge({
  port, readSettings, connectionForFeature, logsDir,
  fetchFn = fetch, stateFile = STATE_FILE, log = (...a) => console.log('[bridge]', ...a),
} = {}) {
  async function currentSessionId(fresh) {
    if (!fresh) {
      try {
        const st = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
        if (st?.sessionId) return { sessionId: st.sessionId, isNew: false };
      } catch { /* none yet */ }
    }
    const sessionId = sessionSlugId();
    try {
      mkdirSync(path.dirname(stateFile), { recursive: true });
      await fsp.writeFile(stateFile, JSON.stringify({ sessionId, startedAt: new Date().toISOString() }, null, 2));
    } catch (err) { log('could not save the bridge session id:', err?.message ?? err); }
    return { sessionId, isNew: true };
  }

  async function readHistory(sessionId) {
    try {
      const logData = JSON.parse(await fsp.readFile(path.join(logsDir, `${sessionId}.json`), 'utf8'));
      return { messages: Array.isArray(logData?.messages) ? logData.messages : [], startedAt: logData?.startedAt ?? null };
    } catch { return { messages: [], startedAt: null }; }
  }

  /**
   * One message from Claude Code, my reply back.
   * @returns {Promise<{ok:true, reply:string, toolsUsed:string[], sessionId:string} | {ok:false, error:string}>}
   */
  async function send({ message, newConversation = false } = {}) {
    const text = String(message ?? '').trim();
    if (!text) return { ok: false, error: 'an empty message' };
    const s = readSettings() || {};
    if (!speakerOf({ role: 'user', speaker: BRIDGE_SPEAKER }, s)) {
      return { ok: false, error: `"${BRIDGE_SPEAKER}" isn't on the list of others who may type in the web chat (Open Knowledge editor → Prompts), so the bridge is off.` };
    }
    const conn = connectionForFeature(s, 'chat');
    if (!connectionReady(conn)) return { ok: false, error: 'no usable chat connection' };

    const { sessionId } = await currentSessionId(newConversation === true);
    const { messages: history, startedAt } = await readHistory(sessionId);
    const at = new Date().toISOString();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BRIDGE_TURN_TIMEOUT_MS);
    try {
      const res = await fetchFn(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          provider: conn.provider, apiKey: conn.apiKey, model: conn.model, baseUrl: conn.baseUrl,
          ...(conn.reasoningEffort ? { reasoningEffort: conn.reasoningEffort } : {}),
          messages: [...toApiHistory(history), { role: 'user', content: text, speaker: BRIDGE_SPEAKER }],
          userMessage: text,
          speaker: BRIDGE_SPEAKER,
          stream: false, runToolLoop: true, enrich: true,
          max_tokens: BRIDGE_MAX_TOKENS,
          injectCorePrompts: true,           // no browser: the server folds in the four core prompts
          sessionAudience: 'ward-private',   // my human's own instance, on their behalf
          sessionInfo: { sessionId },
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, error: `the chat turn failed (HTTP ${res.status}): ${JSON.stringify(data)?.slice(0, 200)}` };
      const reply = stripLlmTimestamps(extractTurnReply(data?.choices?.[0] ?? {})).trim();
      const toolsUsed = (Array.isArray(data?._toolRounds) ? data._toolRounds : [])
        .flatMap(r => (Array.isArray(r.toolCalls) ? r.toolCalls : []).map(tc => tc?.function?.name).filter(Boolean));
      const turn = bridgeTurnMessages({ text, data, reply: reply || null, at });
      const saved = await writeSessionLog({
        sessionId, startedAt: startedAt || at, endedAt: new Date().toISOString(),
        provider: conn.provider, model: conn.model, location: BRIDGE_LOCATION,
        messages: [...history, ...turn],
      }, { logsDir, merge: true });
      if (!saved.ok) log('could not save the bridge turn:', saved.reason);
      if (!reply) return { ok: false, error: 'no reply came back (an empty turn)', toolsUsed, sessionId };
      return { ok: true, reply, toolsUsed, sessionId };
    } catch (err) {
      return { ok: false, error: err?.name === 'AbortError' ? `no reply within ${BRIDGE_TURN_TIMEOUT_MS / 60000} minutes` : (err?.message ?? String(err)) };
    } finally {
      clearTimeout(timer);
    }
  }

  return { send };
}
