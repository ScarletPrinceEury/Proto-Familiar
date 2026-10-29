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
 *
 * The other direction — notes I leave for Claude Code — is
 * claude-code-mailbox.js, which also owns the conversation's bookkeeping (its
 * session id, its stored history) so both directions share one conversation.
 * Each reply carries any notes Claude Code hasn't been handed yet (`notes`).
 */
import { extractTurnReply } from '../../llm-call.js';
import { connectionReady } from '../../providers.js';
import { stripLlmTimestamps } from '../../message-sanitize.mjs';
import { writeSessionLog } from '../sessions/session-log.js';
import { unansweredTurnId, toApiHistory } from '../sessions/turn-record.js';
import { randomUUID } from 'node:crypto';
import {
  BRIDGE_SPEAKER, BRIDGE_LOCATION, BRIDGE_OFF_MESSAGE, bridgeEnabled, createClaudeCodeMailbox, DEFAULT_STATE_FILE,
} from './claude-code-mailbox.js';

export { BRIDGE_SPEAKER, BRIDGE_LOCATION };

// A thinking model on high effort can take minutes per turn, and a turn may run
// several tool rounds. Long, but finite.
const BRIDGE_TURN_TIMEOUT_MS = 9 * 60_000;
// RULE A: thinking models bill reasoning against max_tokens. A fixed 8000 was
// too small for an always-on-thinking model at max effort: on a dense message it
// spent the whole cap reasoning and returned no reply (finish 'length', 0.14.96).
// The bridge follows my human's own reply cap, like their web chat, with 8000
// as the floor.
export const BRIDGE_MIN_TOKENS = 8000;
export function bridgeMaxTokens(settings = {}) {
  const n = Math.floor(Number(settings?.maxTokens));
  return Number.isFinite(n) && n > BRIDGE_MIN_TOKENS ? n : BRIDGE_MIN_TOKENS;
}

export function createClaudeCodeBridge({
  port, readSettings, connectionForFeature, logsDir,
  fetchFn = fetch, stateFile = DEFAULT_STATE_FILE, log = (...a) => console.log('[bridge]', ...a),
  mailbox = createClaudeCodeMailbox({ logsDir, readSettings, stateFile, log }),
} = {}) {
  /**
   * One message from Claude Code, my reply back, plus any notes I left it that
   * it hasn't been handed yet.
   * @returns {Promise<{ok:true, reply:string, toolsUsed:string[], sessionId:string, notes:object[]} | {ok:false, error:string}>}
   */
  async function send({ message, newConversation = false } = {}) {
    const text = String(message ?? '').trim();
    if (!text) return { ok: false, error: 'an empty message' };
    const s = readSettings() || {};
    if (!bridgeEnabled(s)) return { ok: false, error: BRIDGE_OFF_MESSAGE };
    const conn = connectionForFeature(s, 'chat');
    if (!connectionReady(conn)) return { ok: false, error: 'no usable chat connection' };

    const { sessionId } = await mailbox.sessionId({ fresh: newConversation === true });
    const { messages: history, startedAt } = await mailbox.readHistory(sessionId);
    const at = new Date().toISOString();
    // The server records the turn as it goes (turn-record.js) and hands the
    // stored messages back; this stores those, never a copy of its own.
    const turn = {
      sessionId, turnId: randomUUID(), replyMessageId: randomUUID(), location: BRIDGE_LOCATION,
      userMessage: { id: randomUUID(), content: text, timestamp: at, speaker: BRIDGE_SPEAKER },
      ...(unansweredTurnId(history) ? { prevTurnId: unansweredTurnId(history) } : {}),
    };
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
          max_tokens: bridgeMaxTokens(s),
          injectCorePrompts: true,           // no browser: the server folds in the four core prompts
          sessionAudience: 'ward-private',   // my human's own instance, on their behalf
          sessionInfo: { sessionId },
          turn,
        }),
      });
      const data = await res.json().catch(() => null);
      // A failed turn is already in the log as far as it got (my message, any
      // tools that ran, a cut-off note); the next turn reads it from there.
      if (!res.ok) return { ok: false, error: `the chat turn failed (HTTP ${res.status}): ${JSON.stringify(data)?.slice(0, 200)}` };
      const reply = stripLlmTimestamps(extractTurnReply(data?.choices?.[0] ?? {})).trim();
      const toolsUsed = (Array.isArray(data?._toolRounds) ? data._toolRounds : [])
        .flatMap(r => (Array.isArray(r.toolCalls) ? r.toolCalls : []).map(tc => tc?.function?.name).filter(Boolean));
      const recorded = Array.isArray(data?._turnRecord?.messages) ? data._turnRecord.messages : [];
      if (!recorded.length) log('the server sent back no record of this turn; only the log it wrote has it');
      const saved = await writeSessionLog({
        sessionId, startedAt: startedAt || at, endedAt: new Date().toISOString(),
        provider: conn.provider, model: conn.model, location: BRIDGE_LOCATION,
        messages: [...history, ...recorded],
      }, { logsDir, merge: true });
      if (!saved.ok) log('could not save the bridge turn:', saved.reason);
      const notes = await mailbox.takeNotes({ via: 'bridge' }).catch(() => []);
      const usage = data?._usage ?? data?.usage ?? null;
      if (!reply) {
        // RULE B: budget exhaustion is never silence. Say what ran out.
        const spent = usage?.completion_tokens ?? usage?.total_tokens;
        const error = data?.choices?.[0]?.finish_reason === 'length'
          ? `the model used its whole budget (${bridgeMaxTokens(s)} tokens${spent ? `, ${spent} spent` : ''}) thinking and wrote no reply (finish: length)`
          : 'no reply came back (an empty turn)';
        return { ok: false, error, toolsUsed, sessionId, notes, usage };
      }
      // The reply says something was done and no tool ran, even after the
      // retry (claimed-actions.js): handed back as a fact beside the reply.
      const unbackedClaim = Array.isArray(data?._unbackedClaim) ? data._unbackedClaim : null;
      return { ok: true, reply, toolsUsed, sessionId, notes, usage, ...(unbackedClaim ? { unbackedClaim } : {}) };
    } catch (err) {
      return { ok: false, error: err?.name === 'AbortError' ? `no reply within ${BRIDGE_TURN_TIMEOUT_MS / 60000} minutes` : (err?.message ?? String(err)) };
    } finally {
      clearTimeout(timer);
    }
  }

  return { send };
}
