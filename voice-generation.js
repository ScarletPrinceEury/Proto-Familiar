/**
 * The knobs that decide what I sound like (voice spec §11).
 *
 * Extracted from the worker so they can be tested. The worker is a script
 * with top-level stdio handlers — importing it from a test would hang the
 * run — and these values are far too load-bearing to be unverifiable because
 * of where they happened to live.
 *
 * ── The seed is the important one ───────────────────────────────────────
 * PocketTTS splits text by punctuation INSIDE one generate call and runs each
 * sentence through its own sampler:
 *
 *     auto sentences = SplitByPunctuation(text);
 *     for (...) GenerateSingleSentence(sentences[i], gen_config, ...)
 *       └─ NormalDataGenerator normal_gen(0, stddev, seed);
 *
 * At upstream's default of -1 that generator is seeded randomly for EVERY
 * sentence. The voice embedding is shared and cached, so it stays roughly the
 * same speaker — but prosody, energy and clarity are re-rolled sentence by
 * sentence. That is the "radically different voices, sometimes muffled,
 * sometimes clear as day" my human heard, and nothing above the engine could
 * fix it, because the randomness is below that line.
 *
 * A fixed seed makes generation deterministic. The value is arbitrary; that
 * it never changes is not.
 *
 * ── These live in `extra`, which is why I missed them twice ─────────────
 * `extra` is an untyped string→value map, so neither the JS typedefs nor the
 * compiled strings list what it accepts. The C++ header does, plainly. When
 * the question is what the engine does, read the engine.
 */

/** Arbitrary, and fixed forever. Changing it changes what I sound like. */
export const DEFAULT_TTS_SEED = 20260726;

/** `stddev = sqrt(temperature)`. Upstream's default; lower is steadier, too low is flat. */
export const DEFAULT_TTS_TEMPERATURE = 0.7;

/** Flow-matching integration steps: quality/speed, not consistency. */
export const DEFAULT_NUM_STEPS = 4;

/** Reference seconds used. Upstream defaults to 10; 12 keeps more of a 12.8 s clip. */
export const MAX_REFERENCE_SECONDS = 12;

/**
 * A number, or the fallback — without JavaScript's helpful coercions.
 *
 * `Number(null)`, `Number('')` and `Number([])` are all 0, so a settings file
 * carrying `seed: null` would quietly become seed 0: a perfectly valid seed
 * that nobody chose, and a voice that changed for no visible reason. Only
 * real numbers and numeric strings get through; 0 itself stays a legitimate
 * value.
 */
const num = (v, fallback) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
};

/**
 * The `extra` map for a generation.
 *
 * Built in exactly one place, because a difference between two generations
 * here is audible as a difference in who is speaking.
 *
 * A seed of -1 is upstream's "randomise", and passing it through would
 * reintroduce the whole bug — so it is treated as absent and the fixed
 * default wins. Someone who genuinely wants randomness can say so by setting
 * a different seed each time, which is a deliberate act rather than a value
 * that happens to mean "surprise me".
 */
export function generationExtras({ seed, temperature } = {}) {
  const wanted = num(seed, DEFAULT_TTS_SEED);
  return {
    seed: wanted < 0 ? DEFAULT_TTS_SEED : wanted,
    temperature: num(temperature, DEFAULT_TTS_TEMPERATURE),
    max_reference_audio_len: MAX_REFERENCE_SECONDS,
  };
}
