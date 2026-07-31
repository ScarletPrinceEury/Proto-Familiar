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
import { prepareForSpeech, speakableText } from './voice-speech.js';
import { scoreMessage } from './crisis-signals.js';
import { recordThreat } from './threat-tracker.js';
import { MODELS_SUBDIR } from './voice-fetch.js';
import { KIND_PCM } from './audio-frame.js';

const WS_PATH = '/api/voice/call';
// A rolling 16-bit-safe stream id in a high band, kept clear of read-aloud's
// low ids so a read-aloud and a call in the same second don't share one.
let ttsStreamSeq = 40000;
const nextTtsStreamId = () => (ttsStreamSeq = ttsStreamSeq >= 65500 ? 40000 : ttsStreamSeq + 1);

/** The D2 gate: is ward-voice→threat scoring on right now? Ward-signed ON by default. */
function voiceThreatEnabled(settings) {
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

  // Per-call chat history, keyed by callId (one call at a time, so at most one
  // live entry; a new call gets a new id and a fresh history).
  const histories = new Map();
  const HISTORY_MAX = 20;

  // ── onTurn dep: a full chat turn via /api/chat ──────────────────────────
  async function runTurn(transcript, ctx) {
    const s = readSettings();
    const conn = connectionForFeature(s, 'chat') || connectionForFeature(s, 'pondering');
    if (!(conn?.apiKey && conn?.provider && conn?.model)) {
      log('no usable connection for a voice turn — staying silent');
      return null;
    }
    const hist = histories.get(ctx.callId) ?? [];
    const messages = [...hist, { role: 'user', content: transcript }];
    let reply = '';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: conn.provider, apiKey: conn.apiKey, model: conn.model,
          messages, stream: false, runToolLoop: true, enrich: true,
          userMessage: transcript,
          // A live spoken turn is the ward on their own private surface.
          sessionAudience: 'ward-private',
        }),
      });
      const data = await res.json();
      reply = data?.choices?.[0]?.message?.content ?? '';
    } catch (err) {
      log(`voice turn /api/chat failed: ${err?.message ?? err}`);
      return null;
    }
    if (reply) {
      const next = [...messages, { role: 'assistant', content: reply }];
      histories.set(ctx.callId, next.slice(-HISTORY_MAX));
    }
    return reply;
  }

  // ── onTurn dep: reply text → TTS PCM (one clone for the whole reply) ─────
  // PocketTTS clones zero-shot per call, so the WHOLE reply is one ttsStream —
  // splitting per sentence would give a different voice each time (the exact
  // read-aloud lesson). We collect the streamed PCM and hand it back as one
  // chunk; the async-iterable also carries the sample rate so the browser can
  // play it. (Frame-level streaming for lower first-audio latency is a 2c/tuning
  // refinement; buffering the reply is correct and one-voiced.)
  async function synthesize(text) {
    const s = readSettings();
    const parts = prepareForSpeech(text).parts;
    if (parts.length === 0) return emptyStream();

    const ttsWorker = await getTtsWorker();
    if (!ttsWorker) { log('no TTS worker — reply goes unspoken'); return emptyStream(); }
    const voice = await resolveVoiceForSettings(s);
    if (!voice?.ok) { log(`no voice resolved (${voice?.reason}) — reply goes unspoken`); return emptyStream(); }
    const loaded = await ensureTtsLoaded(ttsWorker);
    if (!loaded?.ok) { log(`TTS model not loaded (${loaded?.reason}) — reply goes unspoken`); return emptyStream(); }
    const sampleRate = Number(loaded.sampleRate) || 24000;

    const chunks = [];
    for (const part of parts) {
      const streamId = nextTtsStreamId();
      const unsub = ttsWorker.on((frame) => {
        if (frame.kind === KIND_PCM && frame.streamId === streamId && frame.pcm?.length) {
          chunks.push(Buffer.from(frame.pcm));
        }
      });
      try {
        const r = await ttsWorker.request(
          { op: 'ttsStream', streamId, text: part, referenceWav: voice.path },
          { timeoutMs: 300_000 },
        );
        if (!r?.ok) log(`ttsStream part failed: ${r?.reason ?? '?'}`);
      } catch (err) {
        log(`ttsStream threw: ${err?.message ?? err}`);
      } finally { unsub(); }
    }
    const pcm = Buffer.concat(chunks);
    return {
      sampleRate,
      async *[Symbol.asyncIterator]() { if (pcm.length) yield pcm; },
    };
  }

  function emptyStream() {
    return { sampleRate: 24000, async *[Symbol.asyncIterator]() { /* nothing */ } };
  }

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
    streamingModelDir: path.join(rootDir, MODELS_SUBDIR, `asr-streaming-${asrLang(readSettings())}`),
    tomesDir: path.join(rootDir, 'tomes'),
    log,
  });

  async function getWorkerThen(fn) {
    const w = await getListeningWorker();
    if (!w) return { ok: false, reason: 'no-worker' };
    return fn(w);
  }

  clearStaleCallState(path.join(rootDir, 'tomes')).catch(() => {});

  // ── The WebSocket endpoint ──────────────────────────────────────────────
  const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });
  wss.on('connection', async (ws) => {
    const s = readSettings();
    if (callsDisabled() || s?.voiceEnabled === false) {
      try { ws.send(JSON.stringify({ t: 'error', reason: 'voice-disabled' })); } catch { /* */ }
      ws.close(); return;
    }
    if (engine.isCallActive()) {
      try { ws.send(JSON.stringify({ t: 'error', reason: 'busy' })); } catch { /* */ }
      ws.close(); return;
    }

    const send = (data) => { try { ws.send(data); } catch (err) { log(`ws send failed: ${err?.message ?? err}`); } };
    let web = null;
    engine.registerCallAdapter((hooks) => { web = createWebCallAdapter({ hooks, send, log }); return web.adapter; });

    ws.on('message', (data, isBinary) => { try { web?.onMessage(data, isBinary); } catch (err) { log(`onMessage failed: ${err?.message ?? err}`); } });
    ws.on('close', () => { try { web?.onClose(); } catch { /* */ } engine.endCall().catch(() => {}); });
    ws.on('error', (err) => log(`ws error: ${err?.message ?? err}`));

    const start = await engine.startCall('web');
    if (!start.ok) {
      log(`call refused: ${start.reason}${start.detail ? ` (${start.detail})` : ''}`);
      send(JSON.stringify({ t: 'error', reason: start.reason, detail: start.detail ?? null }));
      ws.close(); return;
    }
    send(JSON.stringify({ t: 'ready', callId: start.callId }));
    log(`web call ${start.callId} live`);
  });

  log(`web voice call endpoint listening at ${WS_PATH}`);
  return { engine, wss };
}

/** The ward's chosen streaming-ASR language, defaulting to English. */
function asrLang(settings) {
  const l = String(settings?.voiceAsrLanguage ?? settings?.voiceLanguage ?? 'en').toLowerCase().trim();
  return /^[a-z]{2}$/.test(l) ? l : 'en';
}
