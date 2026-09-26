/**
 * voice-call-sfx.js — the whimsy "rummaging" sound for a call (voice, Pass 2).
 *
 * When the Familiar uses tools on a call (Pass 1), the go-look-it-up pause used
 * to be dead air. If the ward turns this on, a quiet rummaging sound fills that
 * pause — started by LATENCY itself (the engine only plays it when a reply is
 * genuinely slow), stopped the moment the reply is ready. Default OFF; the ward
 * chose "a generated default AND bring-your-own", so this module owns both: a
 * procedural rustle synthesized in code (no asset, no licensing, no fetch) and a
 * minimal loader for a ward-supplied WAV, falling back to the generated sound on
 * any problem.
 *
 * SAFETY: nothing here may ever delay or break a reply. The engine wraps every
 * call to this module and always plays the reply regardless; this module's own
 * contract is "return a playable looping stream, or null" — it throws to no one
 * (a bad file → generated fallback → null only if even that somehow fails).
 *
 * Audio shape matches a TTS reply exactly (voice-web-adapter.js): the stream is
 * an async-iterable of 16-bit little-endian mono PCM Buffers carrying a
 * `.sampleRate` property, so it plays through the SAME `playAudio` path with no
 * adapter changes. Code owns the sample values (exact-values rule); the model
 * never touches this.
 */

import { readFileSync as fsReadFileSync } from 'node:fs';

export const DEFAULT_SFX_SAMPLE_RATE = 24000;   // a common TTS rate; generated clip uses it
const MAX_STREAM_MS = 20000;                     // hard ceiling so a loop can't run forever

export function thinkingSoundDisabledByEnv() {
  return process.env.PROTO_FAMILIAR_VOICE_CALL_SFX_DISABLED === '1';
}

/**
 * What the ward's settings ask for. Default OFF (opt-in whimsy). A configured
 * `voiceCallSoundEffectPath` selects bring-your-own; otherwise the generated
 * rustle. The env off-switch forces it off regardless.
 */
export function resolveThinkingSound(settings) {
  const enabled = !thinkingSoundDisabledByEnv() && settings?.voiceCallSoundEffects === true;
  const filePath = (typeof settings?.voiceCallSoundEffectPath === 'string' && settings.voiceCallSoundEffectPath.trim())
    ? settings.voiceCallSoundEffectPath.trim() : null;
  return { enabled, source: filePath ? 'file' : 'generated', filePath };
}

/**
 * A gentle procedural "rummaging" clip as 16-bit mono PCM. One-pole-lowpassed
 * noise (a soft rustle, not hiss) under a slow swelling envelope, kept quiet.
 * Deterministic for a given seed so a test can assert it's non-silent and
 * bounded. Returns a Buffer of `sampleRate * ms / 1000` samples.
 */
export function generateRustlePcm({ sampleRate = DEFAULT_SFX_SAMPLE_RATE, ms = 900, seed = 1 } = {}) {
  const n = Math.max(1, Math.floor((sampleRate * ms) / 1000));
  const buf = Buffer.alloc(n * 2);
  let rng = (seed >>> 0) || 1;
  const rand = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return (rng / 0xffffffff) * 2 - 1; };
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // A couple of soft "shuffles" a second: a raised-cosine swell modulated by a
    // slower breathing term, so it reads as rummaging rather than a steady hiss.
    const swell = 0.5 * (1 - Math.cos(2 * Math.PI * t * 2.3));
    const breathe = 0.4 + 0.6 * Math.abs(Math.sin(2 * Math.PI * t * 0.7));
    lp = lp * 0.85 + rand() * 0.15;              // one-pole low-pass → rustle timbre
    const s = lp * swell * breathe * 0.16;       // 0.16 → quiet by design
    const clamped = Math.max(-1, Math.min(1, s));
    buf.writeInt16LE((clamped * 32767) | 0, i * 2);
  }
  return buf;
}

/**
 * Parse a minimal PCM WAV into { pcm: Buffer(int16 mono LE), sampleRate }.
 * Supports 16-bit PCM, mono or stereo (downmixed to mono). Returns null on
 * anything unexpected — the caller falls back to the generated sound, so an odd
 * file is a soft miss, never an error.
 */
export function parseWavToMonoPcm(bytes) {
  try {
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
    let off = 12, fmt = null, dataOff = -1, dataLen = 0;
    while (off + 8 <= b.length) {
      const id = b.toString('ascii', off, off + 4);
      const size = b.readUInt32LE(off + 4);
      const body = off + 8;
      if (id === 'fmt ') {
        fmt = {
          audioFormat: b.readUInt16LE(body),
          channels: b.readUInt16LE(body + 2),
          sampleRate: b.readUInt32LE(body + 4),
          bitsPerSample: b.readUInt16LE(body + 14),
        };
      } else if (id === 'data') {
        dataOff = body; dataLen = Math.min(size, b.length - body);
      }
      off = body + size + (size % 2);   // chunks are word-aligned
    }
    if (!fmt || dataOff < 0 || fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) return null;
    const ch = fmt.channels >= 1 ? fmt.channels : 1;
    const frames = Math.floor(dataLen / 2 / ch);
    if (frames <= 0) return null;
    if (ch === 1) return { pcm: b.subarray(dataOff, dataOff + frames * 2), sampleRate: fmt.sampleRate };
    // Downmix to mono (average the channels).
    const mono = Buffer.alloc(frames * 2);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (let c = 0; c < ch; c++) sum += b.readInt16LE(dataOff + (f * ch + c) * 2);
      mono.writeInt16LE((sum / ch) | 0, f * 2);
    }
    return { pcm: mono, sampleRate: fmt.sampleRate };
  } catch { return null; }
}

/**
 * Load the PCM for the resolved sound. A bring-your-own file that can't be read
 * or parsed degrades to the generated rustle (never throws). Returns
 * { pcm, sampleRate }.
 */
export function loadThinkingPcm(cfg, { readFileSync = fsReadFileSync, generate = generateRustlePcm } = {}) {
  if (cfg?.source === 'file' && cfg.filePath) {
    try {
      const parsed = parseWavToMonoPcm(readFileSync(cfg.filePath));
      if (parsed && parsed.pcm?.length) return parsed;
    } catch { /* fall through to generated */ }
  }
  return { pcm: generate({ sampleRate: DEFAULT_SFX_SAMPLE_RATE }), sampleRate: DEFAULT_SFX_SAMPLE_RATE };
}

/**
 * A looping async-iterable of PCM chunks the adapter can play, carrying its
 * `.sampleRate` like a TTS reply. Loops the clip until `shouldStop()` (the
 * engine flips it the moment the reply is ready) or a hard MAX_STREAM_MS ceiling
 * — so even if the stop signal is somehow missed, it ends on its own.
 */
export function makeThinkingSoundStream({
  pcm, sampleRate, shouldStop = () => false, chunkMs = 50,
  now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const chunkBytes = Math.max(2, Math.floor((sampleRate * chunkMs) / 1000) * 2);
  return {
    sampleRate,
    async *[Symbol.asyncIterator]() {
      const start = now();
      while (!shouldStop() && (now() - start) < MAX_STREAM_MS) {
        for (let o = 0; o < pcm.length; o += chunkBytes) {
          if (shouldStop()) return;
          yield pcm.subarray(o, Math.min(o + chunkBytes, pcm.length));
          // Pace to real time: emit ~one chunk per chunkMs rather than flooding
          // the adapter with the whole looped clip at once, and check shouldStop
          // between chunks so playback ends within ~chunkMs of the reply arriving.
          // The await also yields to the event loop (no starvation).
          await sleep(chunkMs);
        }
      }
    },
  };
}

/**
 * The engine-facing factory: given live settings + a `shouldStop` predicate,
 * return a playable looping stream, or null (disabled / nothing to play). This
 * is what server.js wires as the engine's `makeThinkingSound` dep. Never throws.
 */
export function createThinkingSoundMaker({ readSettings, log = () => {}, readFileSync = fsReadFileSync } = {}) {
  return function makeThinkingSound({ shouldStop } = {}) {
    try {
      const cfg = resolveThinkingSound(readSettings() || {});
      if (!cfg.enabled) return null;
      const { pcm, sampleRate } = loadThinkingPcm(cfg, { readFileSync });
      if (!pcm || !pcm.length) return null;
      return makeThinkingSoundStream({ pcm, sampleRate, shouldStop });
    } catch (err) {
      log(`thinking sound unavailable: ${err?.message ?? err}`);
      return null;
    }
  };
}
