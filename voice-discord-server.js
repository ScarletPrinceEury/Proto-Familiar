/**
 * voice-discord-server.js — wires the Discord voice adapter (Pass 3) to a call
 * engine and exposes join/leave, the mirror of `attachVoiceCall` for the web.
 *
 * It owns nothing platform-specific of its own: the transport is
 * `voice-discord-adapter.js`, the ASR/TTS workers are the SAME ones the web call
 * path uses (injected), and the spine is `call-engine.js` unchanged. This module
 * is just the glue — register the adapter, start/stop the one call, forward the
 * gateway's roster events, and run the turn.
 *
 * Pass 3b scope (WARD ONLY): the ward's voice runs a real ward-private chat turn
 * (shared with the web call via voice-chat-turn.js), spoken back. Non-ward
 * speakers are transcribed for the log but NOT answered and NOT stored — the
 * villager clearance path (their voice gated to their audience via audience.js)
 * is a ward-sign-off privacy path (spec §5) and the deliberate next step. Threat
 * scoring stays ward-only (the turn-runner gates it). See the runTurn comment.
 *
 * Graceful degradation: the transport deps are loaded lazily at join, so a
 * missing/failed install (or the env off-switch) makes a join return a reason,
 * never crash the gateway or the chat path.
 */

import path from 'node:path';

import { createCallEngine, isCallActiveFromFile } from './call-engine.js';
import { createDiscordCallAdapter, loadDiscordVoiceDeps } from './voice-discord-adapter.js';
import { discordVoiceAdapterCreator, setVoiceRosterListener } from './discord-gateway.js';
import { createSynthesizer } from './voice-synthesize.js';
import { createVoiceChatTurn } from './voice-chat-turn.js';
import { createVoiceTurnRunner } from './voice-call-turn.js';
import { voiceThreatEnabled } from './voice-call-server.js';
import { speakableText, isLikelyNoiseTranscript } from './voice-speech.js';
import { scoreMessage } from './crisis-signals.js';
import { recordThreat } from './threat-tracker.js';
import { enqueueSessionByDay } from './memorization.js';
import { slugifyLabel, sessionSlugId } from './slug-ids.js';
import { MODELS_SUBDIR } from './voice-fetch.js';
import { ASR_MODEL_DIR, voiceOfflineAsrEnabled, ensureOfflineAsrModel, voiceCallSettleMs } from './voice-transcribe.js';

/** Hard off-switch — same pattern as every other loop/feature. */
export function discordVoiceDisabled() {
  return process.env.PROTO_FAMILIAR_DISCORD_VOICE_DISABLED === '1';
}

function asrLang(settings) {
  const l = String(settings?.voiceAsrLanguage ?? 'en').toLowerCase().trim();
  return /^[a-z]{2}$/.test(l) ? l : 'en';
}

/**
 * @param {object}   deps
 * @param {string}   deps.rootDir
 * @param {number}   deps.port                    the local server port (for the /api/chat turn)
 * @param {function} deps.readSettings
 * @param {function} deps.getListeningWorker      () => worker | Promise<worker>  (ASR — shared with web)
 * @param {function} deps.getTtsWorker            () => Promise<worker>           (TTS — shared with web)
 * @param {function} deps.resolveVoiceForSettings (settings) => Promise<voice>
 * @param {function} deps.ensureTtsLoaded         (worker) => Promise<{ok, sampleRate}>
 * @param {function} deps.connectionForFeature    (settings, feature) => {provider, apiKey, model}
 * @param {function} [deps.log]
 * @returns {{ joinVoiceCall, leaveVoiceCall, isCallActive }}
 */
export function attachDiscordVoice(deps) {
  const {
    rootDir, port, readSettings, getListeningWorker, getTtsWorker,
    resolveVoiceForSettings, ensureTtsLoaded, connectionForFeature,
    log = (m) => console.log(`[discord-voice] ${m}`),
  } = deps;

  const synthesize = createSynthesizer({ readSettings, getTtsWorker, resolveVoiceForSettings, ensureTtsLoaded, log });
  const runVoiceChatTurn = createVoiceChatTurn({ port, readSettings, connectionForFeature, log });

  // Per-call ward chat history (capped, for LLM context) and the full transcript
  // (uncapped, for end-of-call memorization) — keyed by callId, exactly like the
  // web call server. One call at a time, so at most one live entry.
  const histories = new Map();
  const HISTORY_MAX = 20;
  const callSessions = new Map();   // callId → { sessionId, messages:[], startedAt }

  // ── The turn (Pass 3b — WARD ONLY) ──────────────────────────────────────
  // ⚠️ Ward-sign-off privacy path (spec §5). A live Discord voice call is
  // multi-speaker, but who the Familiar ANSWERS and STORES per speaker mirrors
  // the text audience gate and must be reviewed by the ward before it goes live.
  // So this pass answers the WARD only: their voice runs a real ward-private turn
  // (full context + enrich); anyone else is transcribed for the log but NOT
  // answered and NOT stored (fail-closed). Extending to villagers — their voice
  // gated to their clearance through audience.js — is the next, ward-reviewed
  // step. Do NOT loosen this to answer/store non-ward voice without sign-off.
  async function runTurn(transcript, ctx) {
    const heard = String(transcript ?? '').trim();
    if (!heard) return null;
    if (ctx?.speakerRef !== 'ward') {
      // Heard (transcribed, logged) but not answered or stored — the villager
      // clearance path is deferred pending ward sign-off.
      log(`heard from ${ctx?.speakerRef ?? '?'} (not the ward) — not answered this pass (villager voice pending sign-off)`);
      return null;
    }
    const hist = histories.get(ctx.callId) ?? [];
    const reply = await runVoiceChatTurn({ transcript: heard, history: hist, sessionAudience: 'ward-private' });
    if (reply) {
      const next = [...hist, { role: 'user', content: heard }, { role: 'assistant', content: reply }];
      histories.set(ctx.callId, next.slice(-HISTORY_MAX));
      const sess = callSessions.get(ctx.callId);
      if (sess) sess.messages.push({ role: 'user', content: heard }, { role: 'assistant', content: reply });
    }
    return reply;
  }

  // D2 (ward-signed): the ward's spoken words can raise the threat tier. The
  // runner below gates this to speakerRef === 'ward', so a villager's voice never
  // moves my human's tier (spec §5 — threat scoring stays ward-only).
  async function scoreThreat(transcript) {
    const { level, signals } = scoreMessage(transcript);
    if (level > 0) await recordThreat({ delta: level, source: 'voice', signals });
  }

  // Reuse the web's turn-runner wrapper: threat-score (ward-only) → runTurn →
  // speakable → synthesize. Same orchestration + safety gate, one implementation.
  const onTurn = createVoiceTurnRunner({
    runTurn, synthesize,
    speakable: speakableText,
    scoreThreat,
    threatEnabled: () => voiceThreatEnabled(readSettings()),
    log,
  });

  // Enqueue the ward's finished call for memorization on hang-up — the same
  // ward-private path web calls use. Only the ward's turns were stored (villager
  // voice was never accumulated), so nothing here can leak a villager's words.
  async function memorizeCall(callId) {
    const sess = callSessions.get(callId);
    callSessions.delete(callId);
    if (!sess || sess.messages.length < 2) return;
    try {
      const s = readSettings();
      const conn = connectionForFeature(s, 'chat') || connectionForFeature(s, 'pondering');
      if (!(conn?.apiKey && conn?.provider && conn?.model)) { log('call ended but no connection to memorize it with'); return; }
      const r = await enqueueSessionByDay({
        sessionId: sess.sessionId, messages: sess.messages,
        provider: conn.provider, apiKey: conn.apiKey, model: conn.model,
        audienceTag: 'ward-private',
      });
      log(`voice call ${callId} ended — queued ${sess.messages.length} lines for memory (${r.enqueued} enqueued, ${r.skipped} skipped)`);
    } catch (err) { log(`memorizeCall failed: ${err?.message ?? err}`); }
  }

  const engine = createCallEngine({
    worker: {
      request: (...a) => getWorkerThen((w) => w.request(...a)),
      sendPcm: (...a) => getWorkerThen((w) => w.sendPcm(...a)),
      on: (l) => {
        let off = () => {};
        Promise.resolve(getListeningWorker()).then((w) => { if (w) off = w.on(l); }).catch(() => {});
        return () => off();
      },
    },
    onTurn,
    streamingModelDir: path.join(rootDir, MODELS_SUBDIR, `asr-streaming-${asrLang(readSettings())}`),
    offlineModelDir: ASR_MODEL_DIR,
    offlineFinal: () => voiceOfflineAsrEnabled(readSettings()),
    ensureOffline: () => ensureOfflineAsrModel({ rootDir, log }),
    // Coalesce sentences into one turn (don't reply over a longer thought) and
    // drop ambient-noise transcripts (traffic the recogniser heard as Chinese).
    turnSettleMs: () => voiceCallSettleMs(readSettings()),
    transcriptFilter: (t) => !isLikelyNoiseTranscript(t, { language: asrLang(readSettings()) }),
    tomesDir: path.join(rootDir, 'tomes'),
    log,
  });

  async function getWorkerThen(fn) {
    const w = await getListeningWorker();
    if (!w) return { ok: false, reason: 'no-worker' };
    return fn(w);
  }

  let activeAdapter = null;

  /**
   * Join a voice channel and go live. `nameForUser` resolves a user id to a
   * display name (for the speaker slug); `wardUserId` reserves 'ward' for my
   * human so only their voice can move the threat tier (Pass 2 D2).
   */
  async function joinVoiceCall({ guildId, channelId, wardUserId = '', nameForUser } = {}) {
    if (discordVoiceDisabled()) return { ok: false, reason: 'disabled' };
    if (!guildId || !channelId) return { ok: false, reason: 'bad-target' };
    if (engine.isCallActive()) return { ok: false, reason: 'busy', callId: engine.currentCallId() };
    // One voice connection at a time across BOTH transports — don't join a
    // Discord VC while a web call is live (they'd fight over the call-state file
    // and the single ASR/TTS worker). The governor read is fail-safe.
    if (await isCallActiveFromFile(path.join(rootDir, 'tomes'))) return { ok: false, reason: 'busy-other-transport' };

    const voiceDeps = await loadDiscordVoiceDeps({ log }).catch((err) => { log(`voice deps unavailable: ${err?.message ?? err}`); return null; });
    if (!voiceDeps) return { ok: false, reason: 'deps-unavailable' };

    const adapterCreator = discordVoiceAdapterCreator(guildId);
    engine.registerCallAdapter((hooks) => {
      const { adapter } = createDiscordCallAdapter({
        hooks,
        joinSpec: { guildId, channelId, adapterCreator, wardUserId, nameForUser },
        deps: voiceDeps,
        slugId: (name) => slugifyLabel(name) || 'speaker',
        log,
      });
      activeAdapter = adapter;
      return adapter;
    });

    // The gateway forwards every VOICE_STATE_UPDATE here so the adapter learns
    // who is in the channel (feeds the Pass 3b audience set).
    setVoiceRosterListener((d) => {
      try { activeAdapter?.onVoiceStateChange({ userId: d?.user_id, channelId: d?.channel_id }); }
      catch (err) { log(`roster forward failed: ${err?.message ?? err}`); }
    });

    const r = await engine.startCall('discord', { guildId, channelId });
    if (!r.ok) {
      setVoiceRosterListener(null); activeAdapter = null;
      // Surface WHY — startCall carries the adapter's detail; without this the
      // ward only ever sees "join-failed" with no clue where it died.
      log(`join failed: ${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
    } else {
      log(`voice call live in guild ${guildId} channel ${channelId} (${r.callId})`);
      // Open the memorization session for this call (ward turns accumulate into it).
      callSessions.set(r.callId, { sessionId: sessionSlugId(), messages: [], startedAt: Date.now() });
    }
    return r;
  }

  async function leaveVoiceCall() {
    setVoiceRosterListener(null);
    const callId = engine.currentCallId();
    const r = await engine.endCall();
    activeAdapter = null;
    // Memorize the ward's call, then drop its history. Fire-and-forget so a slow
    // extraction never holds up teardown.
    if (callId) { memorizeCall(callId).catch(() => {}); histories.delete(callId); }
    return r;
  }

  return { joinVoiceCall, leaveVoiceCall, isCallActive: engine.isCallActive };
}
