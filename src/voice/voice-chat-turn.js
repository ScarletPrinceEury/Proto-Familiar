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

// A thinking model bills its reasoning against max_tokens, so a small cap = empty
// content = dead silence (RULE A). The base cap gives room to finish; the retry
// cap doubles it for the ONE case a same-cap retry can't rescue — a first turn
// that came back finish_reason 'length' (spent the whole budget thinking), where
// the codebase's own remedy is "raise max_tokens".
const VOICE_BASE_MAX_TOKENS  = 4000;
const VOICE_RETRY_MAX_TOKENS = 8000;

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

    // One provider round-trip at a given token cap. stream:false lands on
    // /api/chat's RAW non-stream path, so this replicates callProviderChat's
    // RULE-A guarantees itself (0.9 post-mortem): a generous max_tokens (a
    // thinking model bills reasoning against the cap) + extractTurnReply at the
    // reply boundary — the answer may sit in reasoning_content, but a
    // budget-exhausted turn (finish_reason 'length', empty content) is no answer
    // at all, only raw chain-of-thought, and extractTurnReply returns '' there so
    // we never speak the CoT aloud. Returns the spoken reply (preambles + answer,
    // stripped) or '' when there was no answer, plus finish_reason + httpOk so the
    // caller can decide whether a retry is worth it.
    const attempt = async (maxTokens) => {
      const res = await fetchFn(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          provider: conn.provider, apiKey: conn.apiKey, model: conn.model, baseUrl: conn.baseUrl,
          // runToolLoop follows the ward's per-call setting; the server caps
          // voiceMode tool rounds tightly so a spoken "Eury?" still gets a fast
          // "Hey?" and only a real go-look-it-up request spends rounds.
          messages, stream: false, runToolLoop: toolsOn, enrich: true,
          max_tokens: maxTokens,
          userMessage: text,
          voiceMode: true,          // reply comes out speech-shaped, not screen-shaped
          injectCorePrompts: true,  // no browser here — the server folds in the ward's four core prompts
          sessionAudience,          // the caller's gate decides this — passed through, never invented here
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        log(`voice turn /api/chat returned ${res.status}: ${JSON.stringify(data)?.slice(0, 300)}`);
        return { reply: '', finishReason: null, httpOk: false };
      }
      const finalReply = extractTurnReply(data?.choices?.[0] ?? {});
      // When she used tools, speak her own preamble on each round first ("let me
      // check…" — the carrier `content` runToolCallLoop records per round), then
      // the answer. Absent on a no-tool turn, so this is a no-op there. Timestamps
      // stripped like every other outgoing boundary before it reaches TTS.
      const preambles = Array.isArray(data?._toolRounds)
        ? data._toolRounds.map(r => (typeof r?.content === 'string' ? r.content.trim() : '')).filter(Boolean)
        : [];
      const reply = stripLlmTimestamps([...preambles, finalReply].filter(Boolean).join(' ')).trim();
      return { reply, finishReason: data?.choices?.[0]?.finish_reason ?? null, httpOk: true };
    };

    try {
      let out = await attempt(VOICE_BASE_MAX_TOKENS);
      // An OK-but-empty reply → ONE bounded retry, the spoken counterpart to the
      // web client's empty-retry (capped at a single extra round-trip so a live
      // call stays responsive; the shared timer still bounds both attempts). If
      // the first empty was a length-truncation the model spent its whole budget
      // thinking, so a same-cap retry would just re-fail — give it more room
      // instead. A truly-empty (transient) reply retries at the base cap. An HTTP
      // error is NOT retried here (httpOk false): an immediate identical retry
      // rarely rescues a 4xx/5xx, and the call resets faster without it.
      if (out.httpOk && !out.reply) {
        const retryCap = out.finishReason === 'length' ? VOICE_RETRY_MAX_TOKENS : VOICE_BASE_MAX_TOKENS;
        log(`voice turn empty after ${Date.now() - started}ms (finish_reason=${out.finishReason}) — retrying once${retryCap !== VOICE_BASE_MAX_TOKENS ? ` with a larger cap (${retryCap})` : ''}`);
        out = await attempt(retryCap);
      }
      if (!out.reply) { log(`voice turn still no content after ${Date.now() - started}ms — staying silent so the call can reset`); return null; }
      return out.reply;
    } catch (err) {
      if (err?.name === 'AbortError') log(`voice turn timed out after ${VOICE_TURN_TIMEOUT_MS}ms — giving up so the call can reset`);
      else log(`voice turn /api/chat failed: ${err?.message ?? err}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
