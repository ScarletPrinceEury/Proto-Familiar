/**
 * voice-call-server.js — the server-side glue that turns the tested Pass 2b
 * modules into a live web voice call (voice spec §6.4).
 *
 * ⚠️ ON-HARDWARE PATH. Everything under here needs a microphone, a live LLM
 * provider, and the streaming ASR + TTS models on disk — none of which exist in
 * CI. It is written against the proven seams (the 2a worker, `/api/chat`, the
 * read-aloud TTS pattern, `connectionForFeature`) and every module it composes
 * is unit-tested, but the assembled path is verified by my human speaking into
 * it on the reference laptop, not here. Logs are deliberately verbose for that.
 *
 * It owns three things and delegates the rest:
 *   1. the real `onTurn` deps — `runTurn` (a full `/api/chat` turn, so a voice
 *      reply has identity + memory + tools, §4.4), `synthesize` (the reply →
 *      TTS PCM), `scoreThreat` (D2), `threatEnabled` (the D2 gate);
 *   2. the singleton call engine (one call at a time) + `clearStaleCallState`
 *      at boot;
 *   3. the WebSocket endpoint that binds one browser connection to the engine
 *      via the web adapter, and tears the call down when the socket closes.
 */

import path from 'node:path';

import { WebSocketServer } from 'ws';

import { createCallEngine, clearStaleCallState, callsDisabled } from './call-engine.js';
import { createWebCallAdapter } from './voice-web-adapter.js';
import { createVoiceTurnRunner } from './voice-call-turn.js';
import { speakableText, isLikelyNoiseTranscript } from './voice-speech.js';
import { createSynthesizer } from './voice-synthesize.js';
import { scoreMessage } from './crisis-signals.js';
import { recordThreat } from './threat-tracker.js';
import { MODELS_SUBDIR } from './voice-fetch.js';
import { ASR_MODEL_DIR, voiceOfflineAsrEnabled, ensureOfflineAsrModel, voiceCallSettleMs } from './voice-transcribe.js';
import { enqueueSessionByDay } from './memorization.js';
import { writeSessionLog, stampMessages, turnMessages } from './session-log.js';
import { sessionSlugId } from './slug-ids.js';
import { registerPushAdapterFactory, formatItemForPush } from './cerebellum.js';
import { createVoiceChatTurn } from './voice-chat-turn.js';

const WS_PATH = '/api/voice/call';

/** The D2 gate: is ward-voice→threat scoring on right now? Ward-signed ON by default.
 *  Exported so the Discord voice server shares the exact same gate (no copy-paste). */
export function voiceThreatEnabled(settings) {
  if (process.env.PROTO_FAMILIAR_THREAT_DISABLED === '1') return false;
  if (process.env.PROTO_FAMILIAR_VOICE_THREAT_DISABLED === '1') return false;
  return settings?.voiceThreatScoring !== false; // default ON
}

/**
 * @param {object} deps  server-bound helpers (all already exist in server.js)
 * @param {import('http').Server} deps.httpServer
 * @param {string}   deps.rootDir
 * @param {number}   deps.port
 * @param {function} deps.readSettings           () => settings
 * @param {function} deps.getListeningWorker      () => worker | Promise<worker>   (ASR)
 * @param {function} deps.getTtsWorker            () => Promise<worker>            (TTS, follows voice choice)
 * @param {function} deps.resolveVoiceForSettings (settings) => Promise<voice>
 * @param {function} deps.ensureTtsLoaded         (worker) => Promise<{ok, sampleRate}>
 * @param {function} deps.connectionForFeature    (settings, feature) => {provider, apiKey, model}
 * @param {function} [deps.log]
 */
export function attachVoiceCall(deps) {
  const {
    httpServer, rootDir, port,
    readSettings, getListeningWorker, getTtsWorker,
    resolveVoiceForSettings, ensureTtsLoaded, connectionForFeature,
    log = (m) => console.log(`[voice-call] ${m}`),
  } = deps;

  const logsDir = path.join(rootDir, 'logs');

  // Per-call chat history, keyed by callId (one call at a time, so at most one
  // live entry; a new call gets a new id and a fresh history).
  const histories = new Map();
  const HISTORY_MAX = 20;

  // The FULL call transcript, kept separate from `histories` (which is capped for
  // the LLM context). On hang-up it lands as a reviewable session log AND is
  // memorized like any ward-private session — otherwise a whole spoken
  // conversation vanishes, un-reviewable and only extracted-as-facts.
  // callId → { sessionId, messages: [{role, content}], startedAt }.
  const callSessions = new Map();

  // On hang-up: land the call as a reviewable session (logs/) so my human can
  // read it back in the Sessions tab, THEN enqueue it for memorization (the same
  // consent-gated fact extraction web chat + Discord use). Never throws into the
  // teardown; each half is independent (a memorization skip still leaves a log).
  async function memorizeCall(callId) {
    const sess = callSessions.get(callId);
    callSessions.delete(callId);
    if (!sess || sess.messages.length < 2) return;
    const s = readSettings();
    const conn = connectionForFeature(s, 'chat') || connectionForFeature(s, 'pondering');

    // A web call is my human on their own private surface → ward-private.
    if (process.env.PROTO_FAMILIAR_VOICE_SESSION_LOG_DISABLED !== '1') {
      const endedIso = new Date().toISOString();
      const r = await writeSessionLog({
        sessionId:  sess.sessionId,
        startedAt:  new Date(sess.startedAt ?? Date.now()).toISOString(),
        endedAt:    endedIso,
        origin:     'voice-call',
        audienceTag: 'ward-private',
        provider:   conn?.provider ?? null,
        model:      conn?.model ?? null,
        messages:   stampMessages(sess.messages, endedIso),
      }, { logsDir });
      if (!r.ok) log(`session log not written: ${r.reason}`);
    }

    if (!(conn?.apiKey && conn?.provider && conn?.model)) { log('call ended but no connection to memorize it with — transcript not stored'); return; }
    try {
      const r = await enqueueSessionByDay({
        sessionId: sess.sessionId, messages: sess.messages,
        provider: conn.provider, apiKey: conn.apiKey, model: conn.model,
        audienceTag: 'ward-private',
      });
      log(`call ${callId} ended — queued ${sess.messages.length} lines for memory (${r.enqueued} enqueued, ${r.skipped} skipped)`);
    } catch (err) { log(`memorizeCall failed: ${err?.message ?? err}`); }
  }

  // ── onTurn dep: a full chat turn via /api/chat ──────────────────────────
  const runVoiceChatTurn = createVoiceChatTurn({ port, readSettings, connectionForFeature, log });
  async function runTurn(transcript, ctx) {
    const hist = histories.get(ctx.callId) ?? [];
    // The shared /api/chat voice turn (voice-chat-turn.js) — the Discord ward
    // turn runs the exact same request. A web call is my human on their own
    // private surface, so ward-private.
    const reply = await runVoiceChatTurn({ transcript, history: hist, sessionAudience: 'ward-private' });
    if (reply) {
      const messages = [...hist, { role: 'user', content: transcript }];
      const next = [...messages, { role: 'assistant', content: reply }];
      histories.set(ctx.callId, next.slice(-HISTORY_MAX));
      // Accumulate the FULL exchange for the end-of-call memorization (uncapped).
      const sess = callSessions.get(ctx.callId);
      // Stamp at accumulation time — a web call is my human alone, so the user
      // turn is unattributed (speaker omitted), like Discord text's ward turns.
      if (sess) sess.messages.push(...turnMessages(transcript, reply));
    }
    return reply;
  }

  // ── engine dep: a barge cut a reply short (2c `spokenUpTo`) ─────────────
  // Rewrite the last assistant turn to what my human ACTUALLY heard before they
  // talked over it, plus a marker. Both the LLM-context history and the
  // memorization transcript get it, so the next turn knows it was cut off and
  // the stored record reflects the real exchange, not a reply nobody finished.
  function onReplyInterrupted(ctx, { spokenUpTo }) {
    const heard = String(spokenUpTo ?? '').trim();
    const cut = heard ? `${heard} —[my human cut me off here]` : '[my human cut me off before I got a word out]';
    const markLastAssistant = (arr) => {
      if (!Array.isArray(arr)) return;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i]?.role === 'assistant') { arr[i].content = cut; break; }
      }
    };
    markLastAssistant(histories.get(ctx.callId));
    markLastAssistant(callSessions.get(ctx.callId)?.messages);
  }

  // ── onTurn dep: reply text → TTS PCM, streamed as it is generated (2c) ───
  // The shared synthesizer (voice-synthesize.js) — the Discord transport uses
  // the exact same one, so it lives in one place, not copy-pasted per adapter.
  const synthesize = createSynthesizer({ readSettings, getTtsWorker, resolveVoiceForSettings, ensureTtsLoaded, log });

  // ── onTurn dep: D2 — the ward's spoken words can raise the threat tier ───
  async function scoreThreat(transcript) {
    const { level, signals } = scoreMessage(transcript);
    if (level > 0) await recordThreat({ delta: level, source: 'voice', signals });
  }

  // ── The engine ──────────────────────────────────────────────────────────
  const onTurn = createVoiceTurnRunner({
    runTurn,
    synthesize,
    speakable: speakableText,
    scoreThreat,
    threatEnabled: () => voiceThreatEnabled(readSettings()),
    log,
  });

  const engine = createCallEngine({
    worker: {
      request: (...a) => getWorkerThen((w) => w.request(...a)),
      sendPcm: (...a) => getWorkerThen((w) => w.sendPcm(...a)),
      on: (l) => {
        // The listening worker is resolved lazily; subscribe once it exists.
        let off = () => {};
        Promise.resolve(getListeningWorker()).then((w) => { if (w) off = w.on(l); }).catch(() => {});
        return () => off();
      },
    },
    onTurn,
    onReplyInterrupted,
    streamingModelDir: path.join(rootDir, MODELS_SUBDIR, `asr-streaming-${asrLang(readSettings())}`),
    offlineModelDir: ASR_MODEL_DIR,
    offlineFinal: () => voiceOfflineAsrEnabled(readSettings()),
    ensureOffline: () => ensureOfflineAsrModel({ rootDir, log }),
    // Settle only in open-mic mode — push-to-talk's release IS the definitive end,
    // so it replies immediately. Noise filter applies in both modes.
    turnSettleMs: () => (readSettings()?.voiceCallMode === 'open' ? voiceCallSettleMs(readSettings()) : 0),
    transcriptFilter: (t) => !isLikelyNoiseTranscript(t, { language: asrLang(readSettings()) }),
    tomesDir: path.join(rootDir, 'tomes'),
    log,
  });

  async function getWorkerThen(fn) {
    const w = await getListeningWorker();
    if (!w) return { ok: false, reason: 'no-worker' };
    return fn(w);
  }

  // ── Spoken-not-banner (spec §7, ward-signed) ────────────────────────────
  // While a call is live, proactive outbox items — triage check-ins, reminders,
  // event alerts, noticing reach-outs — are SPOKEN into the call instead of
  // bannered over it. A push adapter is the union point: `dispatchOutboxPush`
  // already fans every item out to the configured channels, so this adds one
  // that only exists during a call and speaks the item at the next gap.
  //
  // SAFETY: this changes nothing about escalation or the threat tier. Speaking
  // the item resolves as a confirmed delivery ONLY once it was actually heard
  // (the engine resolves false if the call ends first), and `dispatchOutboxPush`
  // records that under delivery['voice-call'] — which `contactDeadlineFor` reads
  // exactly as it reads a Discord-DM delivery. Ward decision: heard = delivered;
  // the human's own state/response (via the threat tier) still drives escalation.
  registerPushAdapterFactory(() => {
    if (!engine.isCallActive()) return null;   // only a live call speaks; otherwise the normal channels deliver
    return {
      name: 'voice-call',
      deliver: async (item) => {
        try {
          const text = speakableText(formatItemForPush(item))?.text?.trim();
          if (!text) return { ok: false, error: 'nothing speakable in this item' };
          const heard = await engine.speakProactive(() => synthesize(text));
          return heard ? { ok: true } : { ok: false, error: 'call ended before it could be spoken' };
        } catch (err) { return { ok: false, error: String(err?.message ?? err) }; }
      },
    };
  });

  clearStaleCallState(path.join(rootDir, 'tomes')).catch(() => {});

  // ── The WebSocket endpoint ──────────────────────────────────────────────
  const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });
  wss.on('connection', async (ws) => {
    // A live call is push-to-talk: my human clicks Start, the browser asks for
    // mic permission (a hard OS-level gate), and audio only streams while the
    // button is held. That IS the consent — the same rule voice notes already
    // follow ("a press is the consent"), so a call is NOT gated behind the
    // voiceEnabled continuous-listening opt-in. It hid the feature with no way
    // to turn it on. Only the hard env off-switch (callsDisabled) stops a call.
    if (callsDisabled()) {
      try { ws.send(JSON.stringify({ t: 'error', reason: 'voice-disabled' })); } catch { /* */ }
      ws.close(); return;
    }
    if (engine.isCallActive()) {
      try { ws.send(JSON.stringify({ t: 'error', reason: 'busy' })); } catch { /* */ }
      ws.close(); return;
    }

    const send = (data) => { try { ws.send(data); } catch (err) { log(`ws send failed: ${err?.message ?? err}`); } };
    let web = null;
    let activeCallId = null;   // set once the call is live, so close can memorize it
    engine.registerCallAdapter((hooks) => { web = createWebCallAdapter({ hooks, send, log }); return web.adapter; });

    ws.on('message', (data, isBinary) => { try { web?.onMessage(data, isBinary); } catch (err) { log(`onMessage failed: ${err?.message ?? err}`); } });
    ws.on('close', () => {
      try { web?.onClose(); } catch { /* */ }
      engine.endCall().catch(() => {});
      // Memorize the conversation on hang-up (fire-and-forget; never blocks teardown).
      if (activeCallId) memorizeCall(activeCallId).catch(() => {});
    });
    ws.on('error', (err) => log(`ws error: ${err?.message ?? err}`));

    const start = await engine.startCall('web');
    if (!start.ok) {
      log(`call refused: ${start.reason}${start.detail ? ` (${start.detail})` : ''}`);
      send(JSON.stringify({ t: 'error', reason: start.reason, detail: start.detail ?? null }));
      ws.close(); return;
    }
    activeCallId = start.callId;
    callSessions.set(start.callId, { sessionId: sessionSlugId(), messages: [], startedAt: Date.now() });
    send(JSON.stringify({ t: 'ready', callId: start.callId }));
    log(`web call ${start.callId} live`);
  });

  log(`web voice call endpoint listening at ${WS_PATH}`);
  return { engine, wss };
}

/**
 * The ward's chosen streaming-ASR language, defaulting to English.
 *
 * `voiceAsrLanguage` is the one canonical setting — synced from the picker in
 * the voice pane. (An earlier `voiceLanguage` fallback was dropped: nothing
 * ever wrote it, so it only invited a second, drifting source of truth.)
 */
function asrLang(settings) {
  const l = String(settings?.voiceAsrLanguage ?? 'en').toLowerCase().trim();
  return /^[a-z]{2}$/.test(l) ? l : 'en';
}
