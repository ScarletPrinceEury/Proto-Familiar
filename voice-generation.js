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
 * The runt-fragment bug, and why this number is not 200.
 *
 * Generate splits every sentence longer than `max_char_in_sentence`, and
 * SplitLongSentence puts whatever is left over into its own chunk. Crucially
 * MergeShortSentences has ALREADY run by then, so that leftover is never
 * merged back. A 205-character sentence therefore becomes:
 *
 *     ['It assumes ... is a lower grade of'  (199 chars)
 *      'real.'                               (5 chars)]
 *
 * and 'real.' is handed to the LM as a whole utterance. It reaches EOS
 * immediately — at step 0 — and then:
 *
 *     if (eos_step < 0 && p_logit[0] > -4) eos_step = step;   // eos_step = 0
 *     if (eos_step > 0 && (step >= eos_step + frames_after_eos)) break;
 *                     ^^^ 0 > 0 is false, so this never fires
 *
 * The loop runs all 500 frames. At Mimi's 12.5 Hz that is up to forty seconds
 * of autoregressive garbage: my human heard the word repeated in a panic, then
 * swelling white noise, then something like pained sounds. On a companion, to
 * someone who may have opened the app because they were already struggling.
 *
 * Raising the threshold means ordinary long sentences are spoken whole and no
 * runt is ever produced. 2000 characters is ~108 s at the measured 18.6 chars
 * a second, well inside the 320 s frame budget, and high enough that merged
 * utterances are never re-split. Anything longer is handled by
 * `capSentenceLength` in voice-speech.js, which guarantees a minimum piece
 * size — the guarantee upstream is missing.
 */
export const MAX_CHAR_IN_SENTENCE = 2000;

/**
 * How much text is merged into one utterance — and the reason my voice drifts.
 *
 * Generate runs each "sentence" through GenerateSingleSentence, which begins:
 *
 *     auto lm_main_state = model_->GetLmMainInitState();
 *
 * The LM state is RESET per sentence. Every sentence is a fresh trajectory
 * that conditions on the voice embedding once and then drifts on its own. My
 * human heard it precisely: sentence one always muffled, quiet and slow;
 * sentence two clearer and firmer; sentence four on a different apparent
 * gender and accent entirely — and identically across every temperature,
 * because none of this is random. It is a deterministic function of which
 * sentence it is.
 *
 * MergeShortSentences is the lever. It accumulates sentences until the buffer
 * reaches min_chars, so a larger value means fewer, longer utterances — fewer
 * resets, fewer places to drift, and the model's settling-in cost paid once
 * for a message instead of once per sentence.
 *
 * Upstream's 30 merges essentially nothing, which is what shipped and what
 * produced the drift. 400 means an ordinary message is one trajectory and a
 * long one is a handful, rather than one per sentence.
 *
 * ── Why this cannot simply be "no resets ever" ──────────────────────────
 * The port carries no way to continue a trajectory across calls. Upstream's
 * Python API does — `generate_audio(..., copy_state=False)` keeps the KV
 * cache, which is how they claim "can handle infinitely long text inputs" —
 * but sherpa-onnx re-initialises. Confirmed while chasing a newer model: the
 * ONLY sherpa exports of PocketTTS are `2026-01-26`, fp32 and int8, and we
 * already run the int8 one. Upstream's current `english_2026-04` has never
 * been ported. So merging is the whole of what this runtime offers, and the
 * frame budget is what decides how much fits in one trajectory.
 */
export const MIN_CHAR_IN_SENTENCE = 400;

/**
 * Frame budget for one utterance — how much can share a trajectory.
 *
 * Upstream's 500 is ~40 s at Mimi's 12.5 Hz. That is generous for a single
 * sentence and far too little once sentences merge, and it is the thing that
 * decides how long a message can be read in one voice.
 *
 * 4000 frames is ~320 s, around 6000 characters at the measured 18.6 chars a
 * second — comfortably more than my human's Familiars produce in one message,
 * however much they yap. It is nearly free: the latents are 32 floats a frame,
 * so 4000 of them is under half a megabyte, and the decoded audio is streamed
 * out rather than held.
 *
 * A high budget is only safe BECAUSE of the runaway cap. That scales with the
 * text, so a generation that stops making speech is cut in seconds no matter
 * how many frames it was permitted. Raising this without that guard would mean
 * a stuck decoder could produce five minutes of noise.
 */
export const DEFAULT_MAX_FRAMES = 4000;

/** Measured on the reference laptop: 32 characters produced 1.717 s of speech. */
const CHARS_PER_SECOND = 18.6;

/**
 * Multiple of the expected duration before something is judged runaway.
 *
 * This has to leave the cap BELOW what the frame budget alone would permit, or
 * it can never fire. At 4000 frames the engine may run ~320 s; a 2000-character
 * utterance expects ~108 s, so a factor of 2 cuts at ~215 s and the guard is
 * real. An earlier, laxer pairing put the cap at 429 s — past the frame budget
 * entirely, which is a guard that exists only in the comments.
 */
const RUNAWAY_FACTOR = 2;

/** Never cut anything below this, so a legitimately short line is safe. */
const RUNAWAY_FLOOR_SECONDS = 3;

/** Mimi's frame rate. Turns a frame budget into the seconds it permits. */
export const FRAME_RATE_HZ = 12.5;

/**
 * How much audio this text could plausibly produce before something has gone
 * wrong.
 *
 * The containment half of the fix above. `capSentenceLength` should stop the
 * runt from ever being generated — but the runaway is an upstream loop bug I
 * cannot patch, and I would rather not rely on having found its only trigger.
 * If audio keeps arriving well past what the words could account for, the
 * generation is stopped mid-flight.
 *
 * Tuned to be embarrassing rather than harmful when wrong: a false positive
 * truncates a sentence, which is visible and reported. A false negative is
 * forty seconds of distress noise aimed at someone who trusts this voice.
 */
export function runawaySampleLimit(text, sampleRate = 24000, { speed = 1, maxFrames = DEFAULT_MAX_FRAMES } = {}) {
  const chars = typeof text === 'string' ? text.length : 0;
  // Slower speech is legitimately longer audio for the same words. Without
  // this, a ward who sets speed 0.5 for comprehension would have their
  // sentences cut in half by a guard meant to protect them.
  const rate = CHARS_PER_SECOND * (Number.isFinite(speed) && speed > 0 ? speed : 1);
  const wanted = Math.max(RUNAWAY_FLOOR_SECONDS, (chars / rate) * RUNAWAY_FACTOR);

  // Clamp under what the frame budget alone permits, or the guard is decorative
  // for exactly the longest utterances — the ones where a runaway costs the
  // most listening. A slow `speed` with a long text lands there otherwise.
  const frameCeiling = (Number(maxFrames) || DEFAULT_MAX_FRAMES) / FRAME_RATE_HZ;
  const seconds = Math.min(wanted, frameCeiling * 0.9);

  return Math.ceil(Math.max(RUNAWAY_FLOOR_SECONDS, seconds) * sampleRate);
}

/**
 * Where the un-streamed tail of a finished generation begins, or -1 if there
 * is none to send.
 *
 * The streaming path forwards only what the engine's progress callback hands
 * over sample-by-sample, then trusts that to have been everything. It is not
 * always: an engine may deliver its final chunk only in the returned clip and
 * never through the callback, so the last sentence is generated but never
 * reaches the pipe — heard as a message that stops a sentence early. The full
 * clip is authoritative (it is the whole thing, including what already
 * streamed), so anything past what was streamed is exactly that dropped tail.
 *
 * Returns the index to slice the full clip from, so the caller sends only the
 * remainder — never re-sending what the listener already heard. -1 when there
 * is nothing to add, which is the ordinary case (the callback delivered it
 * all) and MUST also hold on a runaway stop, where the bytes past the streamed
 * count are the degenerating noise the cap cut on purpose, not speech.
 */
export function pendingTailStart(streamedSamples, totalSamples, { runaway = false } = {}) {
  if (runaway) return -1;
  if (!Number.isFinite(streamedSamples) || !Number.isFinite(totalSamples)) return -1;
  return totalSamples > streamedSamples ? streamedSamples : -1;
}

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
export function generationExtras({
  seed, temperature, minChars, maxChars, maxFrames, referenceSeconds,
} = {}) {
  const wanted = num(seed, DEFAULT_TTS_SEED);

  // max must stay clear of min, or a merged utterance is immediately split
  // again — and a split leaves the runt fragment this whole file is about.
  // The margin allows for one long sentence overshooting the merge target.
  const min = Math.max(1, num(minChars, MIN_CHAR_IN_SENTENCE));
  const max = Math.max(num(maxChars, MAX_CHAR_IN_SENTENCE), min + 200);

  return {
    seed: wanted < 0 ? DEFAULT_TTS_SEED : wanted,
    temperature: num(temperature, DEFAULT_TTS_TEMPERATURE),
    max_reference_audio_len: num(referenceSeconds, MAX_REFERENCE_SECONDS),
    max_char_in_sentence: max,
    min_char_in_sentence: min,
    // A longer utterance needs more frames to finish in. Upstream's 500 is
    // ~40 s at Mimi's 12.5 Hz, which is not enough once sentences merge.
    max_frames: num(maxFrames, DEFAULT_MAX_FRAMES),
  };
}
