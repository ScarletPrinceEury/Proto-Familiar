/**
 * call-engine.js — the platform-neutral heart of a live voice call (voice spec
 * §3, Pass 2).
 *
 * The engine owns everything that is NOT transport: routing a speaker's audio to
 * the streaming recogniser, assembling an endpointed transcript into a turn,
 * running that turn, and handing the reply back to the platform to speak. An
 * adapter (web now; Discord in Pass 3) provides only transport — `joinCall`,
 * `leaveCall`, `playAudio`, `stopPlayback`, and a way to push inbound audio in.
 * That split is the whole point of §3: the next platform is a transport-only
 * job because it never touches a session, an audience, or a model.
 *
 * ── One call at a time ──────────────────────────────────────────────────
 * `voiceMaxCalls` is 1 on the reference hardware. The engine is written
 * N-call-clean (state hangs off the `call` object, not module globals) so the
 * cap is a setting, not an assumption baked into the code.
 *
 * ── Nothing here throws at a caller or an adapter ───────────────────────
 * A call runs alongside the chat path and the autonomous loops; a rejected
 * promise escaping into an adapter's audio callback would surface as a broken
 * call, not a handled one. Every seam that can fail is caught and logged, and
 * the call degrades to an honest end rather than a crash.
 *
 * ── The call-state file is the governor's gate ──────────────────────────
 * `tomes/.call-state.json` (`{active, callId, since}`) is written on start and
 * cleared on end. The compute governor (§4.3) and the deferring loops read it
 * via `isCallActiveFromFile`; a crash mid-call must not leave it stuck `active`,
 * so `clearStaleCallState` runs at server boot.
 *
 * The turn runner (`onTurn`) is injected: the engine does not know how a turn
 * becomes speech, only that a transcript goes in and a speakable reply comes
 * out. server.js wires the real one (enrich → provider → `speakable()` → TTS);
 * a test injects a fake. Same discipline as the push-adapter registry.
 */

import { promises as fsp, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pcm16ToFloat } from './voice-audio-features.js';
import { normalizeTranscriptCase } from './voice-speech.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(__dirname, 'tomes');
const CALL_STATE_FILE = '.call-state.json';

// A speaker embedding needs only a few seconds; cap the per-utterance capture so
// a long press can't grow the buffer without bound. 16 kHz mono PCM16 ⇒ ~15 s.
const MAX_EMBED_BYTES = 16000 * 2 * 15;

const callStatePath = (tomesDir) => path.join(tomesDir, CALL_STATE_FILE);

/** The hard off-switch, checked where a call would START. */
export function callsDisabled() {
  return process.env.PROTO_FAMILIAR_VOICE_CALL_DISABLED === '1'
    || process.env.PROTO_FAMILIAR_VOICE_DISABLED === '1';
}

// Speech runs at roughly this many characters per second — the same order the
// voicebox worker's runaway cap uses (`_CHARS_PER_SECOND`). Used ONLY to
// estimate, in code, how much of a reply was heard before a barge.
const SPEECH_CHARS_PER_SEC = 14;

/**
 * How much of `text` was likely HEARD in `ms` of real-time playback, snapped
 * back to a word boundary so we never report a half-word. Playback runs at
 * wall-clock speed regardless of how far TTS buffered ahead, so elapsed ms maps
 * to spoken characters via the speech rate — code's arithmetic, never the
 * model's (the exact-values rule). An estimate by nature (rate varies), but a
 * conservative, honest one: "roughly this far before you cut me off".
 */
export function spokenTextForMs(text, ms) {
  const full = String(text ?? '');
  const chars = Math.max(0, Math.round(((Number(ms) || 0) / 1000) * SPEECH_CHARS_PER_SEC));
  if (chars >= full.length) return full;
  const cut = full.slice(0, chars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

export function createCallEngine({
  worker,                 // listeningWorker(): { request, sendPcm, on }
  onTurn,                 // async (transcript, ctx) => reply | null   (injected)
  onReplyInterrupted = null, // (ctx, { fullText, spokenUpTo, playedMs }) => void — a barge cut a reply short (2c)
  streamingModelDir = '', // asr-streaming model dir; loaded once on call start
  offlineModelDir = '',   // asr-offline (SenseVoice) dir; loaded when offlineFinal is on
  offlineFinal = () => false, // hybrid ASR: re-transcribe each utterance with the offline model
  ensureOffline = null,   // async () => fetch the offline model if missing (no-op if present)
  turnSettleMs = () => 0, // coalesce utterances within this gap into one turn (0 = reply per utterance)
  transcriptFilter = () => true, // (text) => keep? — drop ambient-noise transcripts (false = drop)
  embedSegment = null,    // async (float32Samples, sampleRate) => number[]|null — the guest watchdog's voiceprint of a finalized utterance (spec §8.2). Null = off (no speaker ID this call).
  tomesDir = DEFAULT_TOMES_DIR,
  maxCalls = 1,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const adapters = new Map();
  let call = null;   // { callId, adapter, startedAt, streams: Map<speakerRef,{streamId}> }
  let nextStreamId = 1;
  let unsub = null;

  // ── Proactive speech (spec §7 — "spoken not banner") ────────────────────
  // Outbox items (triage check-ins, reminders, noticing) are SPOKEN into a live
  // call rather than bannered over it. Queued and delivered only at a natural
  // GAP — never over my human or a reply (ward decision: always wait for a gap).
  // `speakProactive` resolves true only once the item was ACTUALLY spoken (or
  // false if the call ended first), so the caller records delivery on a real
  // "heard" — which is exactly what the escalation clock keys on. No escalation
  // or threat logic lives here; this only adds a delivery channel.
  const proactiveQueue = [];   // { makeReply, resolve }
  let speaking = false;        // a turn reply OR a proactive item is playing right now
  let lastUserAudioAt = 0;     // last inbound audio frame — tells us my human is mid-utterance
  let proactiveTimer = null;
  const PROACTIVE_QUIET_MS = 1500;   // this much quiet from my human before it counts as a gap

  function speakProactive(makeReply) {
    return new Promise((resolve) => {
      proactiveQueue.push({ makeReply, resolve });
      drainProactive();
    });
  }

  function drainProactive() {
    if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }
    if (speaking || !call || proactiveQueue.length === 0) return;
    // Wait for the gap: not while a reply is playing, not while my human is still
    // talking. Re-check after a quiet interval rather than dropping the item.
    const quietFor = now() - lastUserAudioAt;
    if (call.adapter?.isSpeaking?.() || quietFor < PROACTIVE_QUIET_MS) {
      proactiveTimer = setTimeout(() => { proactiveTimer = null; drainProactive(); }, PROACTIVE_QUIET_MS);
      proactiveTimer.unref?.();
      return;
    }
    const c = call;
    const { makeReply, resolve } = proactiveQueue.shift();
    speaking = true;
    (async () => {
      let spoken = false;
      try {
        const reply = await makeReply();
        if (reply && call === c) { await c.adapter.playAudio(c.callId, reply); spoken = true; }
      } catch (err) { log(`proactive speech failed: ${err?.message ?? err}`); }
      finally {
        speaking = false;
        resolve(spoken && call === c);
        drainProactive();
      }
    })();
  }

  async function writeCallState(active) {
    try {
      mkdirSync(tomesDir, { recursive: true });
      const body = active
        ? JSON.stringify({ active: true, callId: call?.callId ?? null, since: call?.startedAt ?? now() })
        : JSON.stringify({ active: false });
      const tmp = callStatePath(tomesDir) + '.tmp';
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, callStatePath(tomesDir));
    } catch (err) { log(`call-state write failed: ${err?.message ?? err}`); }
  }

  /**
   * Register a transport. The factory receives the hooks it pushes inbound
   * events through and returns the adapter object. A factory that throws or
   * yields no id is dropped with a log — one bad adapter never blocks another.
   */
  function registerCallAdapter(factory) {
    const hooks = {
      pushAudio: (frame) => { handleAudio(frame).catch((e) => log(`audio route failed: ${e?.message ?? e}`)); },
      // Push-to-talk's turn boundary: the RELEASE. A continuous/VAD adapter never
      // calls this — the recogniser's own endpointing finds the boundary and
      // fires `asr-final` mid-stream. An explicit-boundary adapter (push-to-talk)
      // calls it on release to finalise the current utterance now.
      endUtterance: (frame) => { finalizeUtterance(frame).catch((e) => log(`finalize failed: ${e?.message ?? e}`)); },
      rosterChanged: (_ev) => { /* Pass 3 (Discord roster→audience) consumes this; the contract carries it now */ },
    };
    let adapter;
    try { adapter = factory(hooks); } catch (err) { log(`call adapter factory failed: ${err?.message ?? err}`); return null; }
    if (!adapter?.id) { log('call adapter has no id — ignored'); return null; }
    adapters.set(adapter.id, adapter);
    return adapter.id;
  }

  function speakerForStream(streamId) {
    if (!call) return null;
    for (const [ref, s] of call.streams) if (s.streamId === streamId) return ref;
    return null;
  }

  function onWorkerFrame(frame) {
    const msg = frame?.message;
    if (!msg || !call) return;
    if (msg.op === 'asr-final') {
      // Un-shout the streaming zipformer's ALL-CAPS output before it drives a
      // turn — a wall of capitals confuses the LLM (reads as shouting/acronyms).
      // A no-op on already-cased text (SenseVoice ITN, the hybrid final).
      const text = normalizeTranscriptCase(String(msg.text ?? '').trim());
      // The peak + duration make an empty result diagnosable: a low peak means
      // silence (a dead/muted mic or the wrong input device); a healthy peak with
      // no words means real sound the model did not recognise (format, accent,
      // too quiet, too short). Speech is roughly peak > 0.05.
      // asrEngine + any offline note make "is the accurate model actually being
      // used?" answerable from one line, instead of guessing from text quality.
      const eng = msg.asrEngine ? ` ${msg.asrEngine}${msg.asrOfflineNote ? ` (${msg.asrOfflineNote})` : ''}` : '';
      // A transcript the noise filter rejects (ambient noise the recogniser
      // guessed as words — traffic heard as Chinese) is treated like silence: no
      // turn, no memory. Named in the log so a real drop is diagnosable.
      const noise = Boolean(text) && !transcriptFilter(text);
      const meta = `peak=${msg.peak ?? '?'} ${msg.seconds ?? '?'}s${eng}${noise ? ' DROPPED-noise' : ''}`;
      log(`asr-final on stream ${msg.streamId}: ${text ? `"${text}"` : '(empty — no words recognised)'} [${meta}]`);
      if (text && !noise) {
        queueUtterance(speakerForStream(msg.streamId), text);   // settle → serialised dispatcher
      } else if (call?.adapter && !settlePending()) {
        // Nothing to act on (silence or dropped noise) AND nothing is settling —
        // release my human from "Thinking…" so the call is usable again.
        try { call.adapter.playAudio(call.callId, null); } catch (e) { log(`reset after empty asr failed: ${e?.message ?? e}`); }
      }
    }
    // asr-partial is reserved for live captions + barge-in (Pass 2c / web adapter).
  }

  async function handleAudio({ callId, speakerRef, pcm } = {}) {
    if (!call || call.callId !== callId) return;   // stray audio for no call / an old one
    lastUserAudioAt = now();   // my human is speaking — proactive speech waits for the gap after

    let s = call.streams.get(speakerRef);
    if (!s) {
      const streamId = nextStreamId++;
      const r = await worker.request({ op: 'asrStream', streamId, offlineFinal: call.offlineFinal === true });
      if (!r?.ok) { log(`asrStream open failed for ${speakerRef}: ${r?.reason ?? '?'}`); return; }
      s = { streamId, frames: 0, bytes: 0 };
      call.streams.set(speakerRef, s);
      // The first audio frame of a press — proof the capture path works end to
      // end. If this never appears in the log, my human's mic audio is not
      // reaching the server (a client capture / socket problem), not an ASR one.
      log(`${speakerRef} started speaking — ASR stream ${streamId} open`);
    }
    s.frames += 1;
    s.bytes += pcm?.length ?? 0;
    // Keep a bounded copy of this utterance's audio for the guest-watchdog
    // embedding (spec §8.2) — only when speaker ID is on. Sending PCM to ASR is
    // unaffected; this is a parallel tap, capped so a long press can't grow it.
    if (embedSegment && pcm?.length) {
      s.embChunks ||= []; s.embBytes ||= 0;
      if (s.embBytes < MAX_EMBED_BYTES) { s.embChunks.push(pcm); s.embBytes += pcm.length; }
    }
    await worker.sendPcm(s.streamId, pcm);
  }

  /**
   * Finalise the current utterance for one speaker without ending the call.
   * Stopping the stream flushes the recogniser's tail and emits its `asr-final`
   * (which drives the turn); a fresh stream is reopened on the SAME streamId so
   * the next press starts clean. Reuses the proven Pass 2a ops rather than a new
   * "force endpoint" the engine would be the only caller of.
   */
  async function finalizeUtterance({ callId, speakerRef } = {}) {
    if (!call || call.callId !== callId) return;
    const s = call.streams.get(speakerRef);
    if (!s) {
      // A release with no open stream means NO audio arrived during the press —
      // the recogniser has nothing to finalise, so there will be no asr-final
      // and no turn. This is the signature of a client that isn't sending audio.
      log(`${speakerRef} released, but no audio was captured this press — nothing to transcribe`);
      return;
    }
    log(`${speakerRef} released after ${s.frames} audio frame(s) (${s.bytes} bytes) — finalising`);
    // Speaker embedding BEFORE we stop the stream, so `s.lastEmbedding` is ready
    // by the time the asr-final drives the turn (which reads it). Best-effort:
    // a failed/short embed leaves it null and the guard treats that as no signal.
    if (embedSegment && s.embChunks?.length) {
      try {
        const samples = pcm16ToFloat(Buffer.concat(s.embChunks));
        s.lastEmbedding = await embedSegment(samples, 16000);
      } catch (err) { log(`embed of ${speakerRef}'s utterance failed: ${err?.message ?? err}`); s.lastEmbedding = null; }
    }
    s.embChunks = []; s.embBytes = 0;
    await worker.request({ op: 'asrStreamStop', streamId: s.streamId });   // emits asr-final → handleTurn
    if (call && call.streams.get(speakerRef) === s) {
      s.frames = 0; s.bytes = 0;
      await worker.request({ op: 'asrStream', streamId: s.streamId, offlineFinal: call.offlineFinal === true });     // reopen for the next press
    }
  }

  // SETTLE: a pause between sentences shouldn't make the Familiar answer over my
  // human. When `turnSettleMs` > 0, an utterance's text isn't fired straight into
  // a turn — it's buffered, and a timer waits for the gap to persist. More speech
  // within the gap appends and resets the timer, so several sentences separated by
  // breaths become ONE turn, and the reply only comes once my human has actually
  // stopped. (0 = the old behaviour: reply per utterance — right for push-to-talk,
  // where the release IS the end.)
  const SETTLE_MIN_QUIET_MS = 350;   // don't fire until the mic has actually gone quiet this long
  let settleBuf = [];
  let settleRef = null;
  let settleTimer = null;
  function settlePending() { return settleBuf.length > 0; }
  function armSettle(ms) { if (settleTimer) clearTimeout(settleTimer); settleTimer = setTimeout(flushSettle, ms); settleTimer.unref?.(); }
  function flushSettle() {
    if (!settleBuf.length) { if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; } return; }
    // Still hearing audio? My human is mid-sentence (a long clause after the last
    // recognised one) — wait for a real gap instead of answering over them.
    if (now() - lastUserAudioAt < SETTLE_MIN_QUIET_MS) { armSettle(SETTLE_MIN_QUIET_MS); return; }
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    const transcript = settleBuf.join(' ').replace(/\s+/g, ' ').trim();
    const ref = settleRef;
    settleBuf = []; settleRef = null;
    if (transcript) handleTurn(ref, transcript);
  }
  function queueUtterance(speakerRef, text) {
    const ms = Math.max(0, Number(turnSettleMs()) || 0);
    if (ms <= 0) { handleTurn(speakerRef, text); return; }
    if (settleRef && settleRef !== speakerRef) flushSettle();   // a different speaker → don't merge voices
    settleRef = speakerRef;
    settleBuf.push(text);
    armSettle(ms);
  }

  // Turns are SERIALISED. Open mic fires an asr-final per utterance, so a burst
  // of them ("Eury?" … "Hey?" … "can you hear me?") would otherwise launch
  // overlapping heavy turns that thrash and none replies in time. One turn runs
  // at a time; anything said DURING it coalesces to the LATEST, so the freshest
  // thing my human said gets answered rather than a stale backlog.
  let turnBusy = false;
  let pendingTurn = null;

  function handleTurn(speakerRef, transcript) {
    if (turnBusy) { pendingTurn = { speakerRef, transcript }; return; }
    turnBusy = true;
    runOneTurn(speakerRef, transcript).finally(() => {
      turnBusy = false;
      const next = pendingTurn;
      pendingTurn = null;
      if (next && call) handleTurn(next.speakerRef, next.transcript);
    });
  }

  async function runOneTurn(speakerRef, transcript) {
    const c = call;
    if (!c) return;
    let reply = null;
    // The speaker's voiceprint for THIS utterance (spec §8.2), when speaker ID is
    // on — the voice server feeds it to the guest watchdog. Null when off, too
    // short to embed, or a mixed-stream speaker with no per-utterance capture.
    const embedding = c.streams.get(speakerRef)?.lastEmbedding ?? null;
    try { reply = await onTurn(transcript, { callId: c.callId, speakerRef, embedding }); }
    catch (err) { log(`onTurn threw: ${err?.message ?? err}`); }
    if (call !== c) return;   // the call ended mid-turn — nothing to deliver to
    // Always hand the turn's outcome to the adapter, even when there is nothing
    // to say. playAudio(null) signals the browser to leave "Thinking…" and wait
    // for the next press — otherwise a silent turn (no connection, empty reply,
    // timeout) hangs the UI forever, which is the "thinks and never answers" bug.
    let res = null;
    const t0 = now();
    try { speaking = true; res = await c.adapter.playAudio(c.callId, reply); }
    catch (err) { log(`playAudio failed: ${err?.message ?? err}`); }
    finally { speaking = false; }
    // A barge cut the reply short: record how far it got (2c). Real-time
    // playback means elapsed ms ≈ what my human actually heard, so the next
    // turn can know it was interrupted and roughly where.
    if (res?.barged && reply?.text && onReplyInterrupted) {
      const spokenUpTo = spokenTextForMs(reply.text, now() - t0);
      try { onReplyInterrupted({ callId: c.callId, speakerRef }, { fullText: reply.text, spokenUpTo, playedMs: now() - t0 }); }
      catch (err) { log(`onReplyInterrupted failed: ${err?.message ?? err}`); }
    }
    drainProactive();   // a turn just ended — a good moment to speak anything queued
  }

  async function startCall(adapterId, target) {
    if (callsDisabled()) return { ok: false, reason: 'disabled' };
    if (call) return { ok: false, reason: 'busy', callId: call.callId };
    if (adapters.size >= maxCalls && call) return { ok: false, reason: 'busy' };
    const adapter = adapterId ? adapters.get(adapterId) : [...adapters.values()][0];
    if (!adapter) return { ok: false, reason: 'no-adapter' };

    // The model must be resident before the first PCM frame, or the opening of
    // the utterance is decoded against nothing.
    if (streamingModelDir) {
      const load = await worker.request({ op: 'load', role: 'asr-streaming', modelDir: streamingModelDir }, { timeoutMs: 60000 });
      if (!load?.ok) return { ok: false, reason: load?.reason ?? 'load-failed', detail: load?.detail };
    }

    // Hybrid ASR (ward-configurable): the streaming model finds the utterance
    // boundary; the accurate offline model (SenseVoice) transcribes it. Load the
    // offline model too, best-effort — if it can't load we fall back to
    // streaming-only rather than failing the call (graceful degradation).
    const useOffline = Boolean(offlineFinal()) && Boolean(offlineModelDir);
    let offlineReady = false;
    if (useOffline) {
      // Make sure the model is on disk — fetch it in the background if not (no-op
      // when present). The download is minutes long, so THIS call can't wait on
      // it; it falls back to streaming and the next call picks up the offline
      // model. This is what makes the hybrid setting a real capability instead of
      // a switch with no model behind it.
      if (ensureOffline) ensureOffline().catch(() => {});
      const off = await worker.request({ op: 'load', role: 'asr-offline', modelDir: offlineModelDir }, { timeoutMs: 60000 }).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
      offlineReady = Boolean(off?.ok);
      if (offlineReady) log(`hybrid ASR on — the accurate offline model is loaded${off?.alreadyLoaded ? ' (already resident)' : ''}`);
      else log(`accurate transcription model not ready (${off?.reason ?? 'unknown'}) — this call uses streaming transcripts (the model may be downloading; the next call will use it)`);
    }

    let joined;
    try { joined = await adapter.joinCall(target); }
    catch (err) { return { ok: false, reason: 'join-failed', detail: String(err?.message ?? err) }; }

    call = { callId: joined?.callId ?? `call-${now()}`, adapter, startedAt: now(), streams: new Map(), offlineFinal: offlineReady };
    unsub = worker.on(onWorkerFrame);
    await writeCallState(true);
    log(`call ${call.callId} started on ${adapter.id}`);
    return { ok: true, callId: call.callId, adapterId: adapter.id };
  }

  async function endCall() {
    if (!call) return { ok: true, wasActive: false };
    const c = call;
    call = null;   // flip first — isCallActive() must read false the instant teardown begins
    // Anything queued to be spoken never got heard — resolve it as NOT delivered
    // so the caller doesn't record a "heard" the escalation clock would trust.
    if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    settleBuf = []; settleRef = null;
    while (proactiveQueue.length) { try { proactiveQueue.shift().resolve(false); } catch { /* */ } }
    try { if (unsub) unsub(); } catch { /* already gone */ }
    unsub = null;
    for (const s of c.streams.values()) {
      try { await worker.request({ op: 'asrStreamStop', streamId: s.streamId }); } catch { /* best effort */ }
    }
    try { await c.adapter.leaveCall(c.callId); } catch (err) { log(`leaveCall failed: ${err?.message ?? err}`); }
    await writeCallState(false);
    log(`call ${c.callId} ended`);
    return { ok: true, wasActive: true, callId: c.callId };
  }

  return {
    registerCallAdapter,
    startCall,
    endCall,
    speakProactive,   // spoken-not-banner: queue text to speak at the next gap; resolves true once heard
    isCallActive: () => Boolean(call),
    currentCallId: () => call?.callId ?? null,
    adapterIds: () => [...adapters.keys()],
  };
}

/**
 * Clear a stale call-state file at boot. A crash mid-call would otherwise leave
 * it `active:true` forever, and every deferring loop would sit out indefinitely
 * — the caring spine included is fail-safe against that, but the background work
 * that legitimately defers must not be stuck off after a restart.
 */
export async function clearStaleCallState(tomesDir = DEFAULT_TOMES_DIR) {
  try {
    mkdirSync(tomesDir, { recursive: true });
    await fsp.writeFile(callStatePath(tomesDir), JSON.stringify({ active: false }));
  } catch { /* if we cannot write it, isCallActiveFromFile still fails safe to inactive */ }
}

/**
 * The governor's read side (§4.3): is a call active right now? Fail-safe — an
 * absent or unparseable file reads as NOT active, so a broken state file can
 * never wedge the background loops off.
 */
export async function isCallActiveFromFile(tomesDir = DEFAULT_TOMES_DIR) {
  try {
    const raw = await fsp.readFile(callStatePath(tomesDir), 'utf8');
    return Boolean(JSON.parse(raw)?.active);
  } catch { return false; }
}
