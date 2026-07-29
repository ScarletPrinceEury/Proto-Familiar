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
 * Pass 1 is the spine: load, unload, report, synthesise, and transcribe a
 * finished file. Streaming ASR, VAD gating and barge-in belong to Pass 2 and
 * are absent rather than stubbed —
 * an op that answers `unsupported` is honest; one that pretends is not.
 */

import path from 'node:path';
import { encodeJson, encodePcm, createFrameReader, KIND_JSON } from './audio-frame.js';
import { floatToPcm16 } from './voice-audio-features.js';
import {
  generationExtras, runawaySampleLimit,
  DEFAULT_NUM_STEPS, DEFAULT_TTS_SEED, DEFAULT_TTS_TEMPERATURE,
} from './voice-generation.js';

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
 * Generation knobs live in `voice-generation.js` so they are testable — this
 * file is a script with top-level stdio handlers and cannot be imported from
 * a test without hanging it. The seed in particular decides whether I sound
 * like one person across a message, so it does not get to be unverifiable.
 *
 * Env overrides stay here: they are how a ward tunes by ear on their own
 * machine without editing code.
 */
const NUM_STEPS = Number(process.env.PF_TTS_NUM_STEPS) || DEFAULT_NUM_STEPS;
const TTS_SEED = Number(process.env.PF_TTS_SEED) || DEFAULT_TTS_SEED;
const TTS_TEMPERATURE = Number(process.env.PF_TTS_TEMPERATURE) || DEFAULT_TTS_TEMPERATURE;

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
    // PocketTTS IGNORES this — its Generate does its own SplitByPunctuation
    // and never consults maxNumSentences. Left at upstream's own value and
    // documented rather than deleted, so nobody reaches for it again as a
    // consistency lever: it is not one. The seed is.
    maxNumSentences: 1,
  });
}

/**
 * Build the offline recogniser from an unpacked SenseVoice directory.
 *
 * Two file names, both upstream's, both sitting directly in modelDir once the
 * extractor has stripped the archive's wrapper.
 *
 * `useInverseTextNormalization` is what turns "twenty five" into "25" and adds
 * the punctuation — the difference between a transcript my human can read back
 * and a wall of lowercase. It is a number, not a boolean, because the binding
 * passes it straight through to C++.
 *
 * `language` is left empty deliberately: SenseVoice does its own language ID
 * per utterance, and pinning it to one language would break the bilingual
 * household this model was chosen for.
 */
function buildRecognizer(modelDir) {
  const at = (f) => path.join(modelDir, f);
  return new engine.OfflineRecognizer({
    modelConfig: {
      senseVoice: {
        model: at('model.int8.onnx'),
        language: '',
        useInverseTextNormalization: 1,
      },
      tokens: at('tokens.txt'),
      numThreads: threads.asr,
      provider: 'cpu',
      debug: false,
    },
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
      else if (role === 'asr-offline') loaded.set(role, { session: buildRecognizer(modelDir), modelDir, at: Date.now() });
      else loaded.set(role, { modelDir, at: Date.now() });   // other roles arrive with Pass 2
      reportState();
      // The sample rate rides back on the load, because a streaming caller has
      // to write a wav header BEFORE any audio exists. Asking the engine beats
      // hard-coding 24000 and hoping a future model agrees.
      send({ reqId, ok: true, role, modelDir, sampleRate: loaded.get(role)?.session?.sampleRate ?? null });
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
   * Listen to a file and return what was said.
   *
   * Offline, one shot, nobody waiting — the opposite of the streaming path
   * Pass 2 brings. The caller hands over a wav path rather than samples
   * because `readWave` is the engine's own reader and resamples nothing we
   * would have to reimplement badly.
   *
   * `decodeAsync` rather than `decode`: decoding a several-minute note is
   * blocking C++, and this process still has to answer a ping while it works.
   *
   * SenseVoice returns emotion and audio-event tags alongside the text. They
   * are passed back but NOT used for anything — reading tone into a care
   * decision is the safety-critical territory §8 says gets its own spec and
   * its own sign-off, and it does not get to arrive quietly as a side effect
   * of transcription.
   */
  async transcribe({ reqId, wavPath }) {
    const e = await ensureEngine();
    if (!e.ok) return send({ reqId, ok: false, reason: e.reason, detail: e.detail });
    if (!wavPath || typeof wavPath !== 'string') {
      return send({ reqId, ok: false, reason: 'bad-request', detail: 'wavPath is required' });
    }
    const held = loaded.get('asr-offline');
    if (!held?.session) return send({ reqId, ok: false, reason: 'not-loaded', detail: 'the listening model is not loaded' });

    try {
      const wave = engine.readWave(wavPath);
      const started = Date.now();
      const stream = held.session.createStream();
      stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate });
      const result = await held.session.decodeAsync(stream);
      const elapsedMs = Date.now() - started;
      const durationSec = wave.samples.length / wave.sampleRate;

      send({
        reqId, ok: true,
        text: typeof result?.text === 'string' ? result.text.trim() : '',
        lang: result?.lang ?? null,
        emotion: result?.emotion ?? null,
        event: result?.event ?? null,
        durationSec: Number(durationSec.toFixed(3)),
        elapsedMs,
        realTimeFactor: durationSec > 0 ? Number((elapsedMs / 1000 / durationSec).toFixed(3)) : null,
      });
    } catch (err) {
      send({ reqId, ok: false, reason: 'transcribe-failed', detail: String(err?.message ?? err) });
    }
  },

  /**
   * Speak. Returns the samples; the caller decides what to do with them.
   *
   * PocketTTS clones zero-shot, so a reference clip is REQUIRED — there is no
   * built-in voice to fall back on. A missing reference is a clear refusal
   * rather than a default nobody chose.
   */
  async tts({ reqId, text, referenceWav, speed = 1.0, numSteps = NUM_STEPS, seed = TTS_SEED, temperature = TTS_TEMPERATURE, minChars, maxChars, maxFrames, referenceSeconds }) {
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
        extra: generationExtras({ seed, temperature, minChars, maxChars, maxFrames, referenceSeconds }),
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
   * Speak a whole message as ONE generation, streaming the audio out as it
   * arrives.
   *
   * This exists because the obvious alternative is wrong. Splitting a message
   * into sentences and calling `tts` per sentence gives low latency, but
   * PocketTTS clones ZERO-SHOT PER CALL and exposes no seed — so every call
   * re-derives the voice and samples the flow-matching decoder afresh. Three
   * sentences came out sounding like three different speakers at three
   * different levels, which is what my human heard. The clone has to happen
   * once, and the audio has to stream out of that one clone.
   *
   * `maxNumSentences` is raised for exactly this reason: the session must be
   * free to carry the whole text through a single generation rather than
   * being forced to stop at one sentence.
   *
   * Each `onProgress` callback becomes a PCM frame on the same pipe the
   * protocol was built for. The final JSON frame closes the request and
   * carries the totals — a caller must be able to tell "finished" from
   * "the pipe went quiet".
   */
  async ttsStream({ reqId, streamId, text, referenceWav, speed = 1.0, numSteps = NUM_STEPS, seed = TTS_SEED, temperature = TTS_TEMPERATURE, minChars, maxChars, maxFrames, referenceSeconds }) {
    const e = await ensureEngine();
    if (!e.ok) return send({ reqId, ok: false, reason: e.reason, detail: e.detail });
    if (!text || typeof text !== 'string') return send({ reqId, ok: false, reason: 'bad-request', detail: 'text is required' });
    if (!referenceWav) return send({ reqId, ok: false, reason: 'no-voice', detail: 'a reference clip is required — PocketTTS has no built-in voice' });
    if (!Number.isFinite(streamId)) return send({ reqId, ok: false, reason: 'bad-request', detail: 'streamId is required' });

    const held = loaded.get('tts');
    if (!held?.session) return send({ reqId, ok: false, reason: 'not-loaded', detail: 'the speaking model is not loaded' });

    try {
      const ref = engine.readWave(referenceWav);
      const generationConfig = new engine.GenerationConfig({
        speed,
        referenceAudio: ref.samples,
        referenceSampleRate: ref.sampleRate,
        numSteps,
        extra: generationExtras({ seed, temperature, minChars, maxChars, maxFrames, referenceSeconds }),
      });

      const started = Date.now();
      let sampleCount = 0;
      let firstChunkMs = null;
      let runaway = false;

      // Containment for a bug I cannot patch. If the LM reaches EOS on its
      // first step, upstream's `if (eos_step > 0 …)` never fires and the loop
      // runs its full 500-frame budget — up to forty seconds of degenerating
      // noise. `capSentenceLength` should stop the fragment that triggers it
      // from ever being generated, but I would rather not stake my human's
      // ears on having found the only trigger.
      const sampleCeiling = runawaySampleLimit(text, held.session.sampleRate ?? 24000, { speed, maxFrames });

      const audio = await held.session.generateAsync({
        text,
        generationConfig,
        onProgress: ({ samples }) => {
          if (!samples?.length) return 1;
          if (firstChunkMs === null) firstChunkMs = Date.now() - started;

          if (sampleCount + samples.length > sampleCeiling) {
            // Stop BEFORE forwarding this chunk. Whatever is being produced
            // past this point is not speech, and it is aimed at someone who
            // may have opened this because they were already struggling.
            runaway = true;
            return 0;
          }

          sampleCount += samples.length;
          try {
            process.stdout.write(encodePcm(streamId, floatToPcm16(samples)));
          } catch {
            // The pipe is gone. Returning 0 asks the engine to stop rather
            // than finish generating audio with nowhere to go.
            return 0;
          }
          return 1;
        },
      });

      const elapsedMs = Date.now() - started;
      const sampleRate = audio?.sampleRate ?? held.session.sampleRate;
      // Trust what was actually streamed. `audio.samples` is the whole clip
      // again, and reporting its length as the streamed count would overstate
      // what the caller received if the engine stopped early.
      const durationSec = sampleCount / sampleRate;

      send({
        reqId, ok: true, streamId, sampleRate,
        sampleCount,
        durationSec: Number(durationSec.toFixed(3)),
        elapsedMs,
        firstChunkMs,
        // Never silent about it: a truncated sentence is something my human
        // may notice, and they should be able to find out why rather than
        // wonder whether they misheard.
        runaway,
        realTimeFactor: durationSec > 0 ? Number((elapsedMs / 1000 / durationSec).toFixed(3)) : null,
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
