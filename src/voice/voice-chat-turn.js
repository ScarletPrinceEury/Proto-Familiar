/**
 * voice-chat-turn.js — one spoken chat turn over /api/chat, shared by every call
 * transport (web Pass 2, Discord Pass 3b).
 *
 * Extracted from voice-call-server.js when the Discord ward turn needed the exact
 * same request (the no-copy-paste rule). It owns only the provider round-trip and
 * its RULE-A guarantees; the caller owns history, sessions, and who is allowed to
 * speak (the audience gate). `sessionAudience` is passed THROUGH to /api/chat so
 * the server enriches + gates the turn for the right surface — this module never
 * decides audience itself.
 */

import { extractTurnReply } from '../../llm-call.js';
import { connectionReady } from '../../providers.js';
import { stripLlmTimestamps } from '../../message-sanitize.mjs';

// A hung turn must not hang the call forever. The enriched chat path can be slow
// (an MCP cold start on the first turn, a thinking model), but it has to end so
// the caller can reset my human off "Thinking…". Generous, but finite.
const VOICE_TURN_TIMEOUT_MS = 90_000;

/**
 * @param {object}   deps
 * @param {number}   deps.port
 * @param {function} deps.readSettings          () => settings
 * @param {function} deps.connectionForFeature  (settings, feature) => {provider, apiKey, model}
 * @param {function} [deps.log]
 * @param {function} [deps.fetchFn]             injectable for tests
 * @returns {function} runVoiceTurn({ transcript, history?, sessionAudience? }) => Promise<string|null>
 */
export function createVoiceChatTurn({ port, readSettings, connectionForFeature, log = () => {}, fetchFn = fetch } = {}) {
  return async function runVoiceTurn({ transcript, history = [], sessionAudience = 'ward-private', speaker = null } = {}) {
    const text = String(transcript ?? '').trim();
    if (!text) return null;
    const s = readSettings();
    const conn = connectionForFeature(s, 'chat') || connectionForFeature(s, 'pondering');
    if (!connectionReady(conn)) {
      log('no usable connection for a voice turn — staying silent');
      return null;
    }
    // A diarized non-ward voice (open-mic §8.3) rides its speaker through so
    // /api/chat's name-field stamp labels it as that villager, not my human; a
    // ward turn carries no speaker (→ ward-<slug>).
    const userTurn = speaker ? { role: 'user', content: text, speaker } : { role: 'user', content: text };
    const messages = [...history, userTurn];
    // Tools on a call (ward setting, default ON): a spoken "add that to my
    // calendar" should actually DO it, not just talk about it. When on, the
    // server runs the tool loop (capped tighter than a typed turn, voiceMode)
    // and the model's natural per-round preamble ("let me check…") is spoken
    // ahead of the answer below, so the tool-use is announced, never silent.
    // Off (setting or env) → the fast no-tool reply the call path always had.
    const toolsOn = process.env.PROTO_FAMILIAR_VOICE_CALL_TOOLS_DISABLED !== '1'
      && s.voiceCallToolsEnabled !== false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), VOICE_TURN_TIMEOUT_MS);
    const started = Date.now();
    try {
      const res = await fetchFn(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          provider: conn.provider, apiKey: conn.apiKey, model: conn.model, baseUrl: conn.baseUrl,
          // stream:false lands on /api/chat's RAW non-stream path, so we
          // replicate BOTH of callProviderChat's guarantees ourselves (RULE A,
          // 0.9 post-mortem): a generous max_tokens (a thinking model bills
          // reasoning against the cap — no cap = empty content = dead silence)
          // and extractTurnReply at the reply boundary (the answer may sit in
          // reasoning_content, not content — BUT a budget-exhausted turn
          // (finish_reason 'length', empty content) is no answer at all, only
          // raw chain-of-thought; extractTurnReply returns '' there so we go
          // quiet instead of speaking the CoT aloud). runToolLoop follows the ward's
          // per-call setting; the server caps voiceMode tool rounds tightly so a
          // spoken "Eury?" still gets a fast "Hey?" and only a real go-look-it-up
          // request spends rounds.
          messages, stream: false, runToolLoop: toolsOn, enrich: true,
          max_tokens: 4000,
          userMessage: text,
          voiceMode: true,          // reply comes out speech-shaped, not screen-shaped
          injectCorePrompts: true,  // no browser here — the server folds in the ward's four core prompts
          sessionAudience,          // the caller's gate decides this — passed through, never invented here
        }),
      });
      const data = await res.json().catch(() => null);
      const finalReply = extractTurnReply(data?.choices?.[0] ?? {});
      // When she used tools, speak her own preamble on each round first ("let me
      // check…" — the carrier `content` runToolCallLoop records per round), then
      // the answer. Absent on a no-tool turn, so this is a no-op there. Timestamps
      // stripped like every other outgoing boundary before it reaches TTS.
      const preambles = Array.isArray(data?._toolRounds)
        ? data._toolRounds.map(r => (typeof r?.content === 'string' ? r.content.trim() : '')).filter(Boolean)
        : [];
      const reply = stripLlmTimestamps([...preambles, finalReply].filter(Boolean).join(' ')).trim();
      if (!res.ok) { log(`voice turn /api/chat returned ${res.status}: ${JSON.stringify(data)?.slice(0, 300)}`); return null; }
      if (!reply) { log(`voice turn produced no content after ${Date.now() - started}ms (thinking model with empty content?)`); return null; }
      return reply;
    } catch (err) {
      if (err?.name === 'AbortError') log(`voice turn timed out after ${VOICE_TURN_TIMEOUT_MS}ms — giving up so the call can reset`);
      else log(`voice turn /api/chat failed: ${err?.message ?? err}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
