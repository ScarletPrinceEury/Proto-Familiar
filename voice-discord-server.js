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
 * Pass 3b (ward-signed §5): the ward's voice runs a real ward-private turn; a
 * REGISTERED VILLAGER's voice runs a turn gated to the ROOM's audience (recall
 * scoped, ward-private withheld, the outgoing filter applied — all by /api/chat
 * when sessionAudience is the room input), stored at the room's tag, and given NO
 * ward-private history. A STRANGER (unregistered speaker) is transcribed for the
 * log but never answered or stored (fail-closed). Threat scoring stays ward-only
 * (the turn-runner gates it). Memorization is split per audience tag so nothing
 * is stored above its clearance. The gated turn carries no tools (a villager
 * can't drive tool writes by voice — the safe bound; text keeps its tool gate).
 *
 * Graceful degradation: the transport deps are loaded lazily at join, so a
 * missing/failed install (or the env off-switch) makes a join return a reason,
 * never crash the gateway or the chat path.
 */

import path from 'node:path';

import { createCallEngine, isCallActiveFromFile } from './call-engine.js';
import { createDiscordCallAdapter, loadDiscordVoiceDeps } from './voice-discord-adapter.js';
import { discordVoiceAdapterCreator, setVoiceRosterListener, discordVoiceChannelMembers } from './discord-gateway.js';
import { findVillagerByAlias, getRegistry } from './village.js';
import { audienceTagFor } from './audience.js';
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

  // Per-call state. `wardHistory` is the ward's own capped context (ward-private);
  // it is NEVER handed to a villager turn — that would leak my human's private
  // exchanges into a room-gated reply. `refToUser` maps a speaker slug back to the
  // Discord user id so a villager can be resolved. `callMeta` holds the room. All
  // keyed by callId; one call at a time.
  const HISTORY_MAX = 20;
  const wardHistory = new Map();        // callId → [{role,content}] (ward-private)
  const refToUser = new Map();          // speakerRef → discord user id
  const callMeta = new Map();           // callId → { guildId, channelId, locationKey, wardUserId }
  // Memorization sessions, one PER AUDIENCE TAG (ward-private for the ward's turns,
  // the room's tag for a villager's), so nothing is stored above its clearance.
  const memSessions = new Map();        // callId → Map<audienceTag, { sessionId, messages }>

  function accumulate(callId, audienceTag, userMsg, assistantMsg) {
    let byTag = memSessions.get(callId);
    if (!byTag) { byTag = new Map(); memSessions.set(callId, byTag); }
    let sess = byTag.get(audienceTag);
    if (!sess) { sess = { sessionId: sessionSlugId(), messages: [] }; byTag.set(audienceTag, sess); }
    sess.messages.push({ role: 'user', content: userMsg }, { role: 'assistant', content: assistantMsg });
  }

  // Build the audience input for a room turn: WHO is present in the voice channel
  // (everyone but the ward and me), resolved to villagers/strangers. A complete
  // roster matters — an undercount reads the room as more private than it is.
  async function roomAudienceInput(meta) {
    const members = discordVoiceChannelMembers(meta.guildId, meta.channelId);
    const participants = [];
    for (const uid of members) {
      if (uid === meta.wardUserId) continue;                 // the ward isn't a gating participant
      let villager = null;
      try { villager = await findVillagerByAlias({ platform: 'discord', id: uid }); } catch { /* treat as stranger */ }
      // A stranger (unregistered) tightens the gate to the strangers ceiling.
      participants.push({ id: villager?.id ?? null, name: villager?.name ?? 'someone' });
    }
    return { location: meta.locationKey, participants };
  }

  // ── The turn (Pass 3b, ward-signed §5) ──────────────────────────────────
  // WARD: a real ward-private turn (full context). REGISTERED VILLAGER: a turn
  // gated to the ROOM's audience — recall scoped, ward-private withheld, the
  // outgoing filter applied (all by /api/chat when sessionAudience is the room
  // input), stored at the room's tag, and given NO ward-private history. STRANGER
  // (unregistered speaker): transcribed for the log but never answered or stored
  // (fail-closed). Threat scoring stays ward-only (the runner gates it).
  async function runTurn(transcript, ctx) {
    const heard = String(transcript ?? '').trim();
    if (!heard) return null;
    const meta = callMeta.get(ctx.callId);

    if (ctx?.speakerRef === 'ward') {
      const hist = wardHistory.get(ctx.callId) ?? [];
      const reply = await runVoiceChatTurn({ transcript: heard, history: hist, sessionAudience: 'ward-private' });
      if (reply) {
        wardHistory.set(ctx.callId, [...hist, { role: 'user', content: heard }, { role: 'assistant', content: reply }].slice(-HISTORY_MAX));
        accumulate(ctx.callId, 'ward-private', heard, reply);
      }
      return reply;
    }

    // Non-ward: resolve the speaker to a registered villager.
    const userId = refToUser.get(ctx.speakerRef);
    let villager = null;
    try { villager = userId ? await findVillagerByAlias({ platform: 'discord', id: userId }) : null; } catch { /* */ }
    if (!villager || !meta) {
      log(`heard from ${ctx?.speakerRef ?? '?'} (unregistered) — not answered (stranger, fail-closed)`);
      return null;
    }

    // A registered villager: gate the turn to the ROOM. sessionAudience is the
    // room input (object), so /api/chat scopes recall, withholds ward-private, and
    // runs the outgoing filter. NO cross-turn history — a villager's turn must
    // never carry the ward's private context.
    const audienceInput = await roomAudienceInput(meta);
    let audienceTag = 'shared-room';
    try { audienceTag = audienceTagFor(audienceInput, await getRegistry()) || 'shared-room'; } catch { /* */ }
    const reply = await runVoiceChatTurn({ transcript: heard, history: [], sessionAudience: audienceInput });
    if (reply) accumulate(ctx.callId, audienceTag, heard, reply);
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

  // On hang-up, memorize each audience session at ITS OWN tag — the ward's turns
  // at ward-private, a villager's at the room's tag — so nothing is stored above
  // its clearance (the whole point of keeping them separate while the call ran).
  async function memorizeCall(callId) {
    const byTag = memSessions.get(callId);
    memSessions.delete(callId);
    if (!byTag) return;
    const s = readSettings();
    const conn = connectionForFeature(s, 'chat') || connectionForFeature(s, 'pondering');
    if (!(conn?.apiKey && conn?.provider && conn?.model)) { log('call ended but no connection to memorize it with'); return; }
    for (const [audienceTag, sess] of byTag) {
      if (!sess || sess.messages.length < 2) continue;
      try {
        const r = await enqueueSessionByDay({
          sessionId: sess.sessionId, messages: sess.messages,
          provider: conn.provider, apiKey: conn.apiKey, model: conn.model,
          audienceTag,
        });
        log(`voice call ${callId} ended — queued ${sess.messages.length} lines for memory at ${audienceTag} (${r.enqueued} enqueued, ${r.skipped} skipped)`);
      } catch (err) { log(`memorizeCall (${audienceTag}) failed: ${err?.message ?? err}`); }
    }
  }

  // A barge cut a reply short (2c). Annotate the ward's cross-turn history with
  // what was actually heard, so the ward's next spoken turn knows it was cut off
  // (villager turns carry no cross-turn history, so there's nothing there to fix).
  function onReplyInterrupted(ctx, { spokenUpTo }) {
    if (ctx?.speakerRef !== 'ward') return;
    const hist = wardHistory.get(ctx.callId);
    if (!Array.isArray(hist)) return;
    const heard = String(spokenUpTo ?? '').trim();
    const cut = heard ? `${heard} —[my human cut me off here]` : '[my human cut me off before I got a word out]';
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i]?.role === 'assistant') { hist[i].content = cut; break; }
    }
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
    onReplyInterrupted,
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

    const slugId = (name) => slugifyLabel(name) || 'speaker';
    // Wrap nameForUser so every time the adapter mints a speaker slug we record
    // slug → user id — that's how a villager's spoken turn is resolved back to
    // their registry entry (and thus their clearance).
    const trackedNameForUser = (id) => {
      const name = nameForUser ? nameForUser(id) : `user-${id}`;
      refToUser.set(id === wardUserId ? 'ward' : slugId(name), id);
      return name;
    };

    const adapterCreator = discordVoiceAdapterCreator(guildId);
    engine.registerCallAdapter((hooks) => {
      const { adapter } = createDiscordCallAdapter({
        hooks,
        joinSpec: { guildId, channelId, adapterCreator, wardUserId, nameForUser: trackedNameForUser },
        deps: voiceDeps,
        slugId,
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
      // Remember the room, so a villager turn can build the audience gate + tag.
      callMeta.set(r.callId, { guildId, channelId, locationKey: `discord:guild:${guildId}:channel:${channelId}`, wardUserId });
    }
    return r;
  }

  async function leaveVoiceCall() {
    setVoiceRosterListener(null);
    const callId = engine.currentCallId();
    const r = await engine.endCall();
    activeAdapter = null;
    // Memorize each audience session, then drop all per-call state. Fire-and-forget
    // so a slow extraction never holds up teardown.
    if (callId) {
      memorizeCall(callId).catch(() => {});
      wardHistory.delete(callId); callMeta.delete(callId);
    }
    refToUser.clear();
    return r;
  }

  return { joinVoiceCall, leaveVoiceCall, isCallActive: engine.isCallActive };
}
