/**
 * Listening to a voice note, once (voice spec §9).
 *
 * The exact shape of `describeAsset` in vision.js, in the register of hearing:
 * I listen to a recording one time, and what was said is cached on the asset
 * forever. Everything downstream — the stand-in, memorization, search, the
 * meaning-bearing slug — reads that cached text rather than the audio, which
 * is why a transcript outlives the bytes it came from.
 *
 * ── Why the transcript sits in `description` ────────────────────────────
 * Not a shortcut: it is the same slot for the same reason. `description` is
 * "the words I have for this thing" — everything that consumes it (the
 * stand-in builder, the slug graduation, memorization's fold) already treats
 * it that way and needed no change to hold a transcript. Giving audio its own
 * parallel field would have meant teaching every one of those consumers about
 * a second place to look.
 *
 * ── Pressing the button IS the consent ──────────────────────────────────
 * This used to sit behind a `voiceEnabled` setting, default OFF, on the
 * reasoning that "a microphone is opt-in in a way a pasted photo is not".
 * That reasoning is sound for AMBIENT listening — a mic that is simply on —
 * and wrong for this. A voice note is a deliberate act: my human presses a
 * button, and the browser asks its own permission on top. A setting in front
 * of that is a second gate guarding a door that is already locked, and it
 * hid the button entirely, so the feature was undiscoverable as well.
 *
 * For someone whose executive function is the actual obstacle, "turn on a
 * setting before you may speak" is not a safeguard, it is the reason the
 * thought is lost. So: no setting. The press is the consent.
 *
 * `voiceEnabled` still exists and still means something — it is reserved for
 * CONTINUOUS listening (live calls, Pass 2), which genuinely is different in
 * kind and does need an explicit opt-in. `PROTO_FAMILIAR_VOICE_DISABLED=1`
 * remains the hard switch over all of it.
 *
 * ── It never throws ─────────────────────────────────────────────────────
 * Every caller is a chat path. A missing model, a dead worker, an unreadable
 * file — each becomes a recorded reason and a stand-in that says so. An
 * absent transcript renders as absence; it does not 500 a turn.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAssetMeta, setAssetDescription, assetBytesPath } from './media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where `ensure-audio-models.mjs` unpacks the recogniser. */
export const ASR_MODEL_DIR = path.join(__dirname, 'models', 'audio', 'asr-offline');

/**
 * Loading 226 MB of ONNX off a laptop disk is slow enough that an ordinary
 * request timeout would report a failure for something that was working —
 * the same trap the TTS load hit, so the same generous window.
 */
const LOAD_TIMEOUT_MS = 180_000;

/**
 * Decoding is roughly real-time on the reference machine, so the ceiling
 * scales with the clip and keeps a floor for short ones. A note that somehow
 * runs away is a failed transcription, not a hung turn.
 */
export function transcribeTimeoutMs(durationSec) {
  const d = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 60;
  return Math.min(15 * 60_000, Math.max(60_000, Math.round(d * 4 * 1000)));
}

/** The hard switch. Kills every part of voice, listening and speaking alike. */
export const voiceHardDisabled = () => process.env.PROTO_FAMILIAR_VOICE_DISABLED === '1';

/**
 * May I transcribe a note my human deliberately recorded? Only the hard
 * switch says no — the press was the consent.
 */
export const transcriptionAllowed = () => !voiceHardDisabled();

/**
 * May I listen CONTINUOUSLY (live calls, Pass 2)? That is the one that needs
 * an explicit opt-in, default OFF, and an explicit `false` honoured — `?? true`
 * here would silently leave a microphone open.
 */
export const continuousListeningAllowed = (settings = {}) =>
  settings?.voiceEnabled === true && !voiceHardDisabled();

/**
 * Listen to one voice note and cache what was said.
 *
 * @param {string} idOrSlug
 * @param {object} settings
 * @param {object} deps
 * @param {Function} deps.getWorker  async () => ({ worker }) — injected rather
 *   than imported, because the worker is owned by server.js and importing it
 *   here would be a cycle. It also makes this testable with a fake.
 * @returns {Promise<{ok:boolean, text?:string, reason?:string, cached?:boolean}>}
 */
export async function transcribeAsset(idOrSlug, settings = {}, { getWorker } = {}) {
  const meta = await getAssetMeta(idOrSlug);
  if (!meta) return { ok: false, reason: 'not-found' };
  if (meta.kind !== 'audio') return { ok: false, reason: 'not-audio' };

  // Listen ONCE. A cached transcript — even a recorded refusal — is not
  // re-derived; that is what makes this cheap to call from a chat path.
  if (meta.description !== null && meta.description !== undefined) {
    return { ok: true, cached: true, text: meta.description?.text ?? '' };
  }

  if (!transcriptionAllowed()) {
    // NOT cached — the hard switch can be taken off again, and a refusal that
    // outlives its own cause would leave a note permanently unheard. Same
    // reasoning as `no-worker` and `load-failed`.
    return { ok: false, reason: 'voice-disabled' };
  }

  // Only wav can be read without a decoder we do not ship. The browser
  // records straight to wav for exactly this reason, so this bites only on an
  // audio file that arrived from somewhere else — and then it says so rather
  // than failing obscurely.
  if (meta.ext !== 'wav') {
    await remember(meta.id, { text: '', reason: 'unreadable-format', detail: meta.mime });
    return { ok: false, reason: 'unreadable-format' };
  }

  let worker = null;
  try { ({ worker } = (await getWorker?.()) ?? {}); } catch { worker = null; }
  if (!worker) {
    // Deliberately NOT remembered: a worker that is down right now will be up
    // after a restart, and caching that as the asset's permanent transcript
    // would mean a note I could have heard stays unheard forever.
    return { ok: false, reason: 'no-worker' };
  }

  try {
    const loaded = await worker.request(
      { op: 'load', role: 'asr-offline', modelDir: ASR_MODEL_DIR },
      { timeoutMs: LOAD_TIMEOUT_MS },
    );
    if (!loaded?.ok) {
      // Same reasoning: a model that has not been downloaded yet is a
      // "not yet", not a "never". My human can fetch it and the note is
      // waiting to be heard.
      return { ok: false, reason: loaded?.reason ?? 'load-failed', detail: loaded?.detail ?? null };
    }

    const said = await worker.request(
      { op: 'transcribe', wavPath: assetBytesPath(meta) },
      { timeoutMs: transcribeTimeoutMs(meta.durationSec) },
    );
    if (!said?.ok) {
      return { ok: false, reason: said?.reason ?? 'transcribe-failed', detail: said?.detail ?? null };
    }

    const text = typeof said.text === 'string' ? said.text.trim() : '';
    // A recording with no speech in it is a real outcome, not an error — my
    // human's pocket, a false start, a room with nobody talking. It is cached
    // so the same silence is not decoded twice, and it is said plainly.
    await remember(meta.id, text
      ? { text, lang: said.lang ?? null, at: new Date().toISOString() }
      : { text: '', reason: 'no-speech', at: new Date().toISOString() });

    return { ok: true, text, lang: said.lang ?? null, elapsedMs: said.elapsedMs ?? null };
  } catch (err) {
    return { ok: false, reason: 'transcribe-failed', detail: String(err?.message ?? err) };
  }
}

/** Cache-write that never throws into a chat path. */
async function remember(id, description) {
  try { await setAssetDescription(id, description); } catch { /* the note stays untranscribed; the stand-in says so */ }
}

/**
 * Transcribe every voice note in a turn's messages that has not been heard
 * yet, BEFORE the prompt is assembled.
 *
 * This is `ensureDescribed`'s sibling and exists for the same reason it does:
 * a fire-and-forget transcription lands *after* the prompt was built, so the
 * model answers a message it has not actually heard — and confidently, which
 * is worse. For a voice note there is no live-modality fallback at all; the
 * transcript is the only content there will ever be. So it happens first.
 *
 * Bounded: newest-first, capped, and each one is raced against a timeout so a
 * cold model load falls back to a stand-in that says "not yet" rather than
 * hanging my human's turn.
 */
export async function ensureTranscribed(messages, settings = {}, { getWorker, max = 4, perNoteTimeoutMs = 120_000 } = {}) {
  if (!transcriptionAllowed()) return { transcribed: 0, skipped: 'voice-disabled' };
  const list = Array.isArray(messages) ? messages : [];

  const ids = [];
  for (const m of list) {
    for (const a of Array.isArray(m?.attachments) ? m.attachments : []) {
      if (a?.id) ids.push(a.id);
    }
  }
  if (!ids.length) return { transcribed: 0 };

  let done = 0;
  // Newest-first: if the budget runs out, the note my human just recorded is
  // the one that got heard.
  for (const id of ids.reverse().slice(0, max)) {
    const meta = await getAssetMeta(id);
    if (!meta || meta.kind !== 'audio' || meta.description !== null) continue;
    let timer = null;
    try {
      const raced = await Promise.race([
        transcribeAsset(id, settings, { getWorker }),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), perNoteTimeoutMs); }),
      ]);
      if (raced?.ok) done++;
    } catch { /* one note failing never stops the turn */ }
    // An uncleared race timer keeps the event loop alive — the exact leak that
    // showed up as a 25s hang in the test suite when ensureDescribed shipped.
    finally { if (timer) clearTimeout(timer); }
  }
  return { transcribed: done };
}

/**
 * The one call a turn makes to hear what was spoken to it.
 *
 * Both surfaces call THIS, not `ensureTranscribed` with their own worker
 * wiring — RULE C, stated as code rather than as a matrix someone has to keep
 * up to date. It supplies the worker itself, self-gates on the listening
 * consent, and never throws.
 *
 * Deliberately NOT inside either surface's vision block: hearing is not
 * governed by whether the model can see, and nesting it there would mean
 * switching vision off silently made me deaf as well.
 */
export async function hearVoiceNotes(messages, settings = {}, { rootDir, readSettings, label = 'voice' } = {}) {
  if (!transcriptionAllowed()) return { transcribed: 0 };
  try {
    const { currentAudioWorker } = await import('./audio-worker-current.js');
    const got = await ensureTranscribed(messages, settings, {
      getWorker: () => currentAudioWorker({ rootDir, readSettings }),
    });
    if (got.transcribed) console.log(`[${label}] listened to ${got.transcribed} voice note(s) before the turn`);
    return got;
  } catch (err) {
    console.warn(`[${label}] could not listen to a voice note: ${String(err?.message ?? err)}`);
    return { transcribed: 0 };
  }
}
