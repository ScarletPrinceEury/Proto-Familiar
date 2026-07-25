#!/usr/bin/env node
/**
 * The audio worker (voice spec §2).
 *
 * A plain Node child process that owns the speech models and nothing else. It
 * speaks the framed stdio protocol in `audio-frame.js` and is supervised by
 * `audio-worker-host.js`; it knows nothing about HTTP, my human, or the rest
 * of me.
 *
 * ── It must never take anything down with it ────────────────────────────
 * Native inference is blocking C++ and this process exists to contain that.
 * So: no unhandled rejection escapes, every op answers its `reqId` even when
 * it fails, and a missing engine is reported once at load rather than thrown
 * per request. If this process dies anyway, the supervisor restarts it — and
 * that is the design, not a fallback.
 *
 * ── Thread caps come from the environment ───────────────────────────────
 * The host sets `PF_AUDIO_THREADS*`; the caps live with the supervision, not
 * buried in here. `total` is the ceiling this process holds concurrent work
 * beneath, so on a 4c/8t machine there is always a physical core's worth of
 * headroom left for Node and the Python children even mid-burst.
 *
 * ── Not yet built ───────────────────────────────────────────────────────
 * Pass 1 is the spine: load, unload, report, synthesise. Streaming ASR, VAD
 * gating and barge-in belong to Pass 2 and are absent rather than stubbed —
 * an op that answers `unsupported` is honest; one that pretends is not.
 */

import path from 'node:path';
import { encodeJson, createFrameReader, KIND_JSON } from './audio-frame.js';

const send = (obj) => {
  try { process.stdout.write(encodeJson(obj)); } catch { /* the pipe is gone; the supervisor will notice */ }
};

const threads = {
  total: Number(process.env.PF_AUDIO_THREADS) || 3,
  vad: Number(process.env.PF_AUDIO_THREADS_VAD) || 1,
  asr: Number(process.env.PF_AUDIO_THREADS_ASR) || 2,
  tts: Number(process.env.PF_AUDIO_THREADS_TTS) || 2,
  speaker: Number(process.env.PF_AUDIO_THREADS_SPEAKER) || 1,
};

/**
 * PocketTTS quality/speed lever. Upstream's docs use 2, its node example 5.
 * Starting at 4 as a middle ground; Pass 0's bench on real hardware is what
 * settles it, and §4.6 can shed steps before shedding the voice entirely.
 */
const NUM_STEPS = Number(process.env.PF_TTS_NUM_STEPS) || 4;

/** Upstream caps reference audio at 12 s; named so a longer clip is trimmed knowingly. */
const MAX_REFERENCE_SECONDS = 12;

/**
 * Build the PocketTTS session from an unpacked model directory.
 *
 * The seven file names are upstream's, and the extractor strips the archive's
 * wrapper directory (voice-extract.js), so they sit directly in modelDir.
 * numThreads comes from the host's cap — the whole point of §2's thread
 * discipline is that it is set at session creation, not hoped for.
 */
function buildPocketTts(modelDir) {
  const at = (f) => path.join(modelDir, f);
  return new engine.OfflineTts({
    model: {
      pocket: {
        lmFlow: at('lm_flow.int8.onnx'),
        lmMain: at('lm_main.int8.onnx'),
        encoder: at('encoder.onnx'),
        decoder: at('decoder.int8.onnx'),
        textConditioner: at('text_conditioner.onnx'),
        vocabJson: at('vocab.json'),
        tokenScoresJson: at('token_scores.json'),
        voiceEmbeddingCacheCapacity: 50,
      },
      debug: false,
      numThreads: threads.tts,
      provider: 'cpu',
    },
    maxNumSentences: 1,
  });
}

/** Loaded models, by role. Lazy: nothing loads until something needs it. */
const loaded = new Map();
let engine = null;
let engineError = null;

/**
 * Load the native binding, once.
 *
 * A missing binding is the ordinary case on a platform with no prebuilt, or
 * for a ward who installed with `--omit=optional` (§0.8). It is reported as a
 * reason, not thrown — every op then answers honestly instead of the process
 * dying and being restarted three times into a park.
 */
async function ensureEngine() {
  if (engine) return { ok: true };
  if (engineError) return { ok: false, reason: 'no-engine', detail: engineError };
  try {
    // CommonJS: the namespace object puts module.exports on `.default`.
    const mod = await import('sherpa-onnx-node');
    engine = mod.default ?? mod;
    return { ok: true };
  } catch (err) {
    engineError = `the speech engine is not installed (${String(err?.message ?? err).split('\n')[0]})`;
    return { ok: false, reason: 'no-engine', detail: engineError };
  }
}

function reportState() {
  send({ op: 'state', loadedModels: [...loaded.keys()], liveDecoders: 0, threads });
}

const OPS = {
  /** Liveness plus what this worker can currently do. Cheap, and never loads anything. */
  async ping({ reqId }) {
    const e = await ensureEngine();
    send({
      reqId, ok: true,
      engineAvailable: e.ok,
      engineDetail: e.ok ? null : e.detail,
      loadedModels: [...loaded.keys()],
      threads,
    });
  },

  /**
   * Load a model for a role. Idempotent: loading what is already loaded is a
   * no-op rather than a second copy in RAM.
   */
  async load({ reqId, role, modelDir }) {
    const e = await ensureEngine();
    if (!e.ok) return send({ reqId, ok: false, reason: e.reason, detail: e.detail });
    if (!role || !modelDir) return send({ reqId, ok: false, reason: 'bad-request', detail: 'role and modelDir are required' });
    if (loaded.has(role)) return send({ reqId, ok: true, alreadyLoaded: true, role });

    try {
      if (role === 'tts') loaded.set(role, { session: buildPocketTts(modelDir), modelDir, at: Date.now() });
      else loaded.set(role, { modelDir, at: Date.now() });   // other roles arrive with Pass 2
      reportState();
      send({ reqId, ok: true, role, modelDir });
    } catch (err) {
      send({ reqId, ok: false, reason: 'load-failed', detail: String(err?.message ?? err) });
    }
  },

  /** Drop a role's model. Used by idle unload and by a ward reclaiming RAM. */
  async unload({ reqId, role }) {
    if (role) loaded.delete(role); else loaded.clear();
    reportState();
    send({ reqId, ok: true, unloaded: role ?? 'all' });
  },

  /**
   * Speak. Returns the samples; the caller decides what to do with them.
   *
   * PocketTTS clones zero-shot, so a reference clip is REQUIRED — there is no
   * built-in voice to fall back on. A missing reference is a clear refusal
   * rather than a default nobody chose.
   */
  async tts({ reqId, text, referenceWav, speed = 1.0, numSteps = NUM_STEPS }) {
    const e = await ensureEngine();
    if (!e.ok) return send({ reqId, ok: false, reason: e.reason, detail: e.detail });
    if (!text || typeof text !== 'string') return send({ reqId, ok: false, reason: 'bad-request', detail: 'text is required' });
    if (!referenceWav) return send({ reqId, ok: false, reason: 'no-voice', detail: 'a reference clip is required — PocketTTS has no built-in voice' });

    const held = loaded.get('tts');
    if (!held?.session) return send({ reqId, ok: false, reason: 'not-loaded', detail: 'the speaking model is not loaded' });

    try {
      const ref = engine.readWave(referenceWav);
      const generationConfig = new engine.GenerationConfig({
        speed,
        referenceAudio: ref.samples,
        referenceSampleRate: ref.sampleRate,
        numSteps,
        // Upstream's own cap. Naming it means a longer reference is trimmed
        // deliberately rather than silently — p255_023 is 12.8 s and would
        // otherwise be cut without anyone knowing where.
        extra: { max_reference_audio_len: MAX_REFERENCE_SECONDS },
      });

      const started = Date.now();
      const audio = held.session.generate({ text, generationConfig });
      const elapsedMs = Date.now() - started;
      const durationSec = audio.samples.length / audio.sampleRate;

      send({
        reqId, ok: true,
        sampleRate: audio.sampleRate,
        durationSec: Number(durationSec.toFixed(3)),
        elapsedMs,
        realTimeFactor: durationSec > 0 ? Number((elapsedMs / 1000 / durationSec).toFixed(3)) : null,
        // Float samples as a plain array: the host writes the wav, because the
        // worker's job is inference and nothing else.
        samples: Array.from(audio.samples),
      });
    } catch (err) {
      send({ reqId, ok: false, reason: 'tts-failed', detail: String(err?.message ?? err) });
    }
  },
  /**
   * Not implemented yet.
   *
   * Answering `unsupported` keeps the contract — every request gets a reply —
   * while being plain the capability is absent. Silence, or a plausible-looking
   * empty result, would let a caller believe something happened when it did
   * not: the confabulation failure the 0.9 post-mortem is about.
   */
  async transcribe({ reqId }) { send({ reqId, ok: false, reason: 'unsupported', detail: 'transcription arrives with voice notes' }); },
};

const reader = createFrameReader({
  onFrame: async (frame) => {
    if (frame.kind !== KIND_JSON) return;   // Pass 2 routes PCM at decoders
    const msg = frame.message ?? {};
    const op = OPS[msg.op];
    if (!op) return send({ reqId: msg.reqId, ok: false, reason: 'unknown-op', detail: String(msg.op) });
    try {
      await op(msg);
    } catch (err) {
      // A reqId that never gets an answer is a caller waiting until its
      // timeout for nothing. Answer even the unexpected.
      send({ reqId: msg.reqId, ok: false, reason: 'op-failed', detail: String(err?.message ?? err) });
    }
  },
  onError: (e) => send({ op: 'protocol-error', ...e }),
});

process.stdin.on('data', (chunk) => reader.push(chunk));
process.stdin.on('end', () => process.exit(0));      // EOF from the supervisor: clean exit

process.on('uncaughtException', (err) => {
  send({ op: 'fatal', detail: String(err?.message ?? err) });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  send({ op: 'fatal', detail: String(err?.message ?? err) });
  process.exit(1);
});

reportState();
