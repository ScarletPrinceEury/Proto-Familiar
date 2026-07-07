# Voice — sherpa-onnx build spec

**What this builds:** I can hold a live spoken conversation — my human talks,
I hear them, I answer in my own voice, with latency low enough to feel like
company rather than dictation. Group calls on Discord work from day one; the
call machinery is platform-neutral so Telegram / TeamSpeak / Mumble / WhatsApp
later mean writing an adapter, not a system. And critically: a live call must
not starve the rest of me — Phylactery, Unruh, the Village, and Tomes keep
answering while I talk (§4 is the compute contract that guarantees it).

All speech processing is **local** via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
(CPU, ONNX Runtime, no cloud STT/TTS): my human's voice never leaves the
machine; only the *transcript* rides the existing LLM request like any typed
message.

**Assumes the vision build spec is implemented** (`docs/vision-build-spec.md`):
the media store (`media.js`, content-addressed assets with `kind`), the
materializer seam (`vision.js`), the describe-once-cache-forever pattern, and
the stand-in discipline are all inherited here, not rebuilt.

Status: **spec — not yet built.** Voice owns its own MINOR milestone (one
milestone = one minor; the first landed pass is the `0.X.0`, later passes bump
patch).

---

## 0. What this builds on

### 0.1 sherpa-onnx — the engines we use (and the ones we don't, yet)

One toolkit, one native Node binding (`sherpa-onnx-node`, prebuilt per
platform), several independent engines. We use:

| engine | model (default tier) | size / cost (est. — Pass 0 verifies) | role |
|---|---|---|---|
| **VAD** | silero-vad (onnx) | ~2 MB, negligible CPU | gate everything: no speech → no ASR, no bytes kept |
| **Streaming ASR** | streaming zipformer transducer, int8, per-language | ~40–100 MB, RTF ~0.1–0.3 on 2 threads | live transcription with partials + endpointing. **German is a first-class target** (the next tester cohort) — the zoo carries German/multilingual streaming models; Pass 0 picks and verifies the German default alongside English |
| **Offline ASR** | sense-voice / moonshine small (optional) | ~100–200 MB | voice-note transcription, where latency doesn't matter and accuracy does |
| **TTS (default tier)** | **PocketTTS** (Kyutai CALM, ~100M params; sherpa-onnx node API supported) | ~100–250 MB, ~200 ms first chunk, multiple× realtime on CPU — X380 numbers from Pass 0 | my voice. Multilingual incl. German (verify quality in Pass 0); voices selected via curated reference prompts (§6.5) |
| **TTS (floor tier)** | piper/VITS voice | ~20–60 MB, faster than realtime on 2 threads | the §4.6 shedding target when the machine struggles, and the read-aloud floor on weak hardware |
| **Speech enhancement** | GTCRN denoiser | small; per-stream cost measured in Pass 0 | cleans bad-microphone input ahead of ASR + speaker checks — most wards won't have voice-isolating mics. Toggle `voiceEnhanceEnabled`, default ON for calls if the RTF budget holds |
| **Spoken language ID** | whisper-based LID | ~tens of MB | when the ward enables two ASR languages (German household, English internet), LID routes each utterance to the right decoder — code-gated, per VAD segment |
| **Speaker embedding** | 3D-Speaker / WeSpeaker (onnx) | ~20–70 MB, ~tens of ms per utterance | ward voiceprint enrollment, guest-voice watchdog, diarization for mixed streams |
| **Keyword spotting** | zipformer KWS small | ~15 MB | name-activation in strict-mode calls; wake word on the horizon |
| **Punctuation** | small punct model (optional) | ~30 MB | legible transcripts in session logs |
| **Audio tagging** | zipformer audio tagging (AudioSet labels) | ~30–80 MB | **opt-in toggle, default OFF** — annotation-only in this milestone (§8.4); the long-term care-detection ambitions are their own ward-signed spec |

Not used: source separation, singing/music synthesis — add only when a real
need shows up.

**Model files are machine artifacts:** fetched on first enable by
`scripts/ensure-audio-models.mjs` into `models/audio/` (git-ignored) from
pinned release URLs with **sha256 checksums hard-coded in the script** — the
exact-values rule applied to downloads. No model ships in the repo. The ward
picks the ASR language model and the TTS voice in Settings; everything else is
a sensible pinned default.

### 0.2 What the vision spec already gave us

- **Assets:** `kind: 'audio'` was reserved in the media-store contract. A
  voice note is an audio asset; its transcript fills the same cached
  `description` slot (look-once/listen-once, keep forever). The materializer
  renders audio assets as transcript stand-ins — audio never rides as
  provider content-parts in this milestone (§15).
- **The spine decision holds:** `message.content` stays a string. A spoken
  turn becomes a *transcribed* message — the entire text pipeline (timestamp
  hygiene, audience gating, memorization, threat scoring, history assembly)
  consumes voice turns with **zero changes**, because by the time the core
  sees them, they are text with machine timestamps.

### 0.3 Existing seams this rides (nothing new invented where one exists)

- **Per-location sessions + presence modes (V8):** a voice channel is a
  location; strict / lurk / active govern when I *speak*, exactly as they
  govern when I type. The audience gate is identical in every mode.
- **Push adapters (`registerPushAdapterFactory`):** proactive speech (§7) is
  just another push channel on the outbox — reminders, event alerts, triage
  check-ins and warm reach-outs get a voice without touching their logic.
- **`connectionForFeature` / per-location connection routing:** voice turns
  use the location's connection like text turns do.
- **The hand-rolled Discord gateway:** voice state flows through the same
  WebSocket (op 4 / `VOICE_STATE_UPDATE` / `VOICE_SERVER_UPDATE`); §5 bridges
  it to the voice transport instead of rewriting it.
- **`message-sanitize.mjs`:** the outgoing-boundary stripping regime gains one
  sibling, `speakable()` (§6), applied before any text reaches TTS.

### 0.4 CLAUDE.md invariants this must honor

- **Graceful degradation:** the audio worker is a separate process that can
  crash, stall, or be disabled without the chat path noticing more than
  "voice is unavailable." Every loop keeps its off-switch. A call dying
  mid-sentence degrades to text delivery, never to silence.
- **Ride existing requests; gate in code:** VAD, endpointing, speaker checks,
  name-detection, turn pacing — all cheap code. The only LLM calls a voice
  conversation makes are the chat turns themselves.
- **The LLM is not a source of exact machine values:** timestamps, speaker
  labels, spoken-sentence accounting (§6 barge-in), model checksums — code.
- **Safety-critical sign-off:** feeding ward voice transcripts to the threat
  detector, and audible triage delivery, are named in §10 — defaults proposed,
  ward signs off.
- **First-person convention** for every prompt block and tool description I
  read.

### 0.5 The hardware reality — ThinkPad X380 Yoga

The reference machine: 8th-gen quad-core U-series (4c/8t, 15 W), 8–16 GB RAM,
no GPU. Two properties shape everything in §4:

1. **Burst-friendly, sustained-limited.** Turbo handles short bursts well;
   all-core sustained load throttles. So the design keeps *sustained* load
   near zero (VAD-gated ASR only while someone speaks; TTS in sentence
   bursts) and never schedules two heavy bursts on purpose at the same time.
2. **The CPU rivals are known.** Phylactery embeds locally
   (fastembed / all-MiniLM-L6-v2, ONNX — per-`mem_search` bursts of tens of
   ms, batch bursts during consolidation), Unruh is cheap sqlite, the Node
   server is I/O-bound, background loops are mostly *network*-bound (LLM
   calls) — their CPU cost is small, their latency cost when starved is what
   §4 protects.

**Pass 0 is a benchmark, not product code — and it has a concrete shape:**
`scripts/voice-bench.mjs` downloads the candidate models (pinned URLs +
checksums, same fetcher Pass 1 will reuse), runs them against **bundled
fixture audio** (short speech clips per target language — German and English —
plus noise-mixed variants of the same clips for the enhancement/bad-mic
story), and measures with `perf_hooks`: ASR RTF at 1 and 2 concurrent
streams, TTS time-to-first-chunk and per-sentence latency for both tiers,
speaker-embedding cost per segment, enhancement cost per second of audio.
Then the **interference phase**: spawn Phylactery via thalamus, run a
`mem_search` loop, and record enrich-path latency with and without full audio
load running. The script writes `docs/voice-bench-results.md` (a committed
markdown table + the raw JSON beside it) — the numbers land in the repo, not
in a terminal scrollback, and this spec's "~" estimates are superseded by
that file before Pass 2 ships. Re-runnable on any future machine, so "will
it work on X hardware" is always one command.

---

## 1. The shape — voice is transcription at the edge; the core stays text

```
                 ┌───────────────────────────── audio-worker.mjs (child process)
                 │  VAD → streaming ASR → endpoint → final transcript
 PCM in ────────►│  speaker embedding (enroll / watchdog / diarize)
                 │  TTS: text → PCM (sentence-streamed)
 PCM out ◄───────│  KWS (name activation)
                 └───────────────┬─────────────────────────────────────────
                                 │ framed IPC (control JSON + PCM frames)
        ┌────────────────────────┴───────────────────────┐
        │ call-engine.js (in server process, platform-neutral)
        │  turn-taking, presence modes, barge-in, pacing, │
        │  roster→audience, compute governor hooks        │
        └───────┬──────────────────────────┬──────────────┘
   CallAdapter  │                          │  CallAdapter
   (discord-voice-adapter.js)      (web-voice-adapter.js; later:
    per-speaker Opus streams        telegram/teamspeak/mumble/…)
        │                                  │
     Discord                          browser mic (WS PCM)
```

- **`audio-worker.mjs`** owns every sherpa-onnx model and all DSP. It is
  spawned and supervised like the MCP children (restart on crash, EOF on
  shutdown) and is the *only* process that loads ONNX audio models — thread
  caps and crash isolation live at this boundary (§2).
- **`call-engine.js`** is the platform-neutral brain of a call: who's in the
  room, whose turn it is, when I speak, what gets transcribed into the
  session. It knows nothing about Discord, and nothing about ONNX.
- **`CallAdapter`s** own the platform transport only: join/leave, tagged PCM
  in, PCM out, roster events. §3 is the contract; §5 is the Discord
  implementation; a thin web adapter (§6.4) exists mostly so live voice can
  ship and be tested before the Discord transport lands.
- A finished spoken exchange is indistinguishable in the session log from a
  typed one: `role:'user'` messages (speaker-prefixed for non-ward voices,
  exactly like Discord text), `role:'assistant'` replies, machine timestamps,
  the same audienceTag rules. **Everything downstream — memorization, tomes,
  Phylactery graduation, threat, triage context — consumes voice for free.**

## 2. The audio worker — isolation and thread discipline

- **Separate child process** (`audio-worker.mjs`, plain Node + 
  `sherpa-onnx-node`). Native inference calls are blocking C++; in-process
  they would stall the server's event loop — the single worst thing for
  "Phylactery and Unruh keep answering." Out of process, the server stays
  I/O-bound no matter what the models do.
- **Hard thread caps, set at session creation** (ONNX Runtime intra-op
  threads): VAD 1, ASR 2, TTS 2, speaker/KWS/LID 1; the GTCRN enhancement
  stage rides inside its stream's ASR budget (it processes the same VAD
  segment the decoder is about to eat). The worker's peak concurrent
  compute is capped at **`audioThreads` (default 3)** by its internal
  scheduler — on a 4c/8t machine that always leaves a physical core's worth
  of headroom for Node + the Python children even mid-burst.
- **Concurrency cap for group calls:** at most **2 ASR decode streams**
  active at once (`voiceMaxDecoders`). More simultaneous speakers than that
  queue by VAD segment (humans rarely sustain >2 overlapping speakers; queued
  segments transcribe seconds late rather than never). Per-speaker streams
  stay ordered.
- **Lazy load / idle unload:** models load when a call starts (or the first
  voice note arrives), pre-warmed during the join handshake so the first
  utterance isn't the slow one; unloaded after `voiceModelIdleMin`
  (default 10 min) so a machine not in a call pays zero RAM.
- **Protocol:** length-framed messages over stdio — JSON control frames
  (`{op:'asr-partial', streamId, text}`, `{op:'endpoint'}`,
  `{op:'tts', reqId, text}`, `{op:'speaker-check', ref}`…) and raw PCM
  frames (16 kHz mono s16le) tagged with a stream id. No sockets, no ports —
  same posture as the MCP children.
- **Supervision:** crash → restart with backoff; three crashes in a minute →
  worker parked, calls end with an honest spoken/text notice, chat continues.
  `GET /api/voice/status` reports worker state, loaded models, live decoders,
  measured RTF — observability per repo rule.

## 3. The call engine + the `CallAdapter` contract (the plug-in base)

`call-engine.js` runs at most **one live call at a time** (`voiceMaxCalls`,
default 1 — a deliberate X380 constraint; the setting exists so stronger
hardware can raise it later, the engine is written N-call-clean from day one).

**The adapter contract** — everything a platform must provide, and all it
must provide (this is the "plug Telegram/TeamSpeak/WhatsApp in later" base):

```js
{
  id: 'discord',                       // registry key
  capabilities: {
    perSpeakerStreams: true,           // Discord: yes (per-SSRC). A mixed-mono
                                       // platform says false → engine inserts
                                       // the diarization stage (§8.3)
    roster: true,                      // join/leave events with platform ids
    ring: false,                       // can it actively summon a human?
  },
  joinCall(target)  → { callId },      // adapter-specific target (channel id…)
  leaveCall(callId),
  // inbound — adapter emits:
  onAudio(frame)        // { callId, speakerRef, pcm }  16k mono s16le
  onRosterChange(ev)    // { callId, joined:[], left:[] } platform identities
  // outbound — engine calls:
  playAudio(callId, pcmStream),        // sentence-chunked TTS
  stopPlayback(callId),                // barge-in, must be immediate
}
```

The engine owns, identically for every platform: VAD/ASR routing to the
worker, endpointing → turn assembly, presence-mode decisions, barge-in,
speaker→villager resolution + audience re-resolution, session logging,
proactive-speech delivery, and the compute governor. **An adapter never
touches a session, an audience, or a model** — that's what makes the next
platform a transport-only job. (Realistic next targets, in rough order of
protocol friendliness: Mumble (open, per-user streams), TeamSpeak (SDK,
per-client streams), Telegram (MTProto calls — hard), WhatsApp (no sanctioned
API — may never).)

Registered like push adapters: `registerCallAdapter(factory)` from server.js
boot, engine enumerates what's live. One adapter failing (bad token, lib
missing) never blocks another — the Discord adapter degrading must leave web
voice working, and vice versa.

## 4. The compute governor — how a live call doesn't starve the rest of me

The question this section answers: *can I hold a low-latency conversation
while Phylactery, Unruh, Village and Tomes keep working?* Yes — by spending
the machine in the right order, with these six mechanisms:

1. **Process + thread isolation (§2).** The models physically cannot eat more
   than `audioThreads`; the server event loop physically cannot block on
   inference. This alone removes the timeout catastrophe — MCP children keep
   their CPU headroom even mid-utterance.

2. **VAD-gates everything.** Sustained CPU while a room is quiet: ~zero. ASR
   spends only while someone audibly speaks; TTS only while I do. On the
   X380's thermal envelope this is the difference between "works" and
   "throttles after four minutes."

3. **Call-mode deferral of background work.** A live call flips
   `tomes/.call-state.json` (`{active, callId, since}`; written by the
   engine, cleared on leave + on boot). Loops check `isCallActive()` at tick
   start and **defer** — skip the tick, try again next tick — if they are on
   the defer list:
   - **Defers:** pondering, memorization drain, memory sweep, tome
     graduation, gcal sync, needs-tracking, routine review, media
     retention (§9). All of them are
     minutes-scale background work; nothing is lost by running 20 minutes
     later (their own gates re-qualify work when they resume).
   - **NEVER defers:** silence-triage, threat recording, reminders + event
     alerts, the outbox, warm reach-out's *safety posture* (it already stands
     down at moderate+ threat on its own rules). These are the caring spine —
     a call is the *opposite* of a reason to slow them, and they are
     network-bound anyway (their CPU cost is nil; they were never the
     contention).
   - **Phylactery consolidation:** the one CPU-heavy Python-side batch job.
     Phylactery gains a tiny lifecycle tool (`maintenance_defer(seconds)`);
     the governor calls it on call start and re-arms it each minute while the
     call lives. If the tool is missing (older Phylactery), log loudly and
     continue — consolidation is volume-gated and rare; this is optimization,
     not correctness.

4. **A latency budget on enrichment, not a smaller me.** Voice turns get the
   FULL context — identity, memory, graph, temporal, care check; a voice
   conversation with a lobotomized Familiar would betray the whole design.
   Instead, `enrich()` gains an optional `latencyBudgetMs` (voice turns pass
   ~1200 ms): each peer fetch races a soft timeout, and a peer that misses
   the window contributes nothing **to that turn** (the existing
   `Promise.allSettled` absence-renders-as-absence discipline — now bounded
   in time, not just in failure). The static block is assembled once per call
   and cached (it's stable by design); only dynamic blocks re-fetch per turn.
   Measured on this hardware, local sqlite + one MiniLM embed almost always
   fits the budget — the budget exists for the tail, so one slow peer costs
   one turn's memory block, never three seconds of dead air.

5. **Sentence-streamed TTS + earcons for honest waiting.** The reply is
   spoken sentence-by-sentence as the LLM streams — first audio lands after
   the first sentence, not the full completion. If a turn (tool rounds, slow
   provider) exceeds ~2 s with nothing to say, the engine plays a short
   **code-triggered earcon** (a soft chime/breath — an asset, not an LLM
   artifact) so my human knows I'm there and working. Tools stay fully
   available on voice turns — capability parity is non-negotiable — the
   earcon makes their latency legible instead of hiding them.

6. **Model tiering as the escape valve.** Defaults are the fast tiers (int8
   streaming zipformer, piper voice). If Pass 0's bench shows headroom, the
   ward may pick the quality TTS tier; if a group call on battery struggles,
   the engine sheds quality in code-defined order: quality-TTS → fast-TTS,
   punctuation model off, `voiceMaxDecoders` 2 → 1. Shedding is logged and
   visible in `/api/voice/status`, never silent.

**What is deliberately NOT done:** no OS priority games (`os.setPriority`
needs privileges to boost, and lowering the Python children would slow the
very peers we're protecting), no cgroups (not portable to the ward's
platforms), no second machine. Thread caps + gating + deferral are portable
and sufficient on the measured hardware.

## 5. Discord group calls

**Transport (decided): `@discordjs/voice` bridged to the hand-rolled
gateway.** Discord voice is a second WebSocket + encrypted UDP/RTP + Opus +
the DAVE E2EE protocol — hand-rolling it is months of protocol work with
security-sensitive crypto. `@discordjs/voice` exists to be embedded: its
gateway-adapter interface takes exactly what our gateway already has (send an
op-4 payload; forward `VOICE_STATE_UPDATE` / `VOICE_SERVER_UPDATE`
dispatches). New deps: `@discordjs/voice`, `@discordjs/opus` (native Opus),
`sodium-native` (transport crypto), pinned at versions with DAVE support
(verify at Pass 3 — Discord is rolling E2EE out to all voice). The rest of
the gateway stays ours.

- **Joining:** the ward invites me (`voice_join` tool and/or a Settings/UI
  action naming a registered location). I join only **registered voice
  locations** (a new `discord:voice:<guildId>:<channelId>` location kind in
  the Village registry — label, presence mode, connection routing, rate
  limits, all the existing per-location machinery). Never an unregistered
  channel: presence in a room is a ward decision. Bots cannot join user DM
  calls (platform rule) — a private guild voice channel is the 1:1 pattern;
  say so in the UI.
- **Per-speaker streams = diarization for free.** Discord delivers one Opus
  stream per speaking user (per-SSRC), mapped to a user id → resolved through
  the Village registry exactly like a text message's author: ward /
  villager / stranger. `capabilities.perSpeakerStreams: true` — the engine
  skips the diarization stage entirely on this adapter. (To be clear on
  terms: **Opus is Discord's audio codec**, a transport detail the adapter
  decodes to PCM — it has nothing to do with the LLM. Whatever chat model
  the ward points a location at — GLM, a small Gemma, anything on the
  connection list — never receives audio in any form; it only ever sees the
  transcript text, like every other message.)
- **Roster = audience, re-resolved on every join/leave**, not just per
  message: `onRosterChange` re-runs the audience resolution *immediately*, so
  a stranger stepping into the channel gates the very next sentence I speak.
  The location ceiling always applies. This is the same fail-closed audience
  model as text; voice adds no new privacy rules, only a faster trigger.
- **Presence modes in voice** (per-location, same setting):
  - `strict` — I speak only when addressed: my name in a final transcript
    (cheap code match on the resolved name/aliases, same spirit as
    `messageNamesBot`) or the KWS spotter firing mid-utterance for lower
    latency. Everything else is observed into the session log.
  - `lurk` — transcribe-and-observe; reply when addressed. Observed voice,
    like observed text, is **threat-neutral** and moves no activity clock.
  - `active` — I may chime in unprompted, paced by the existing ambient
    machinery reused verbatim: `activeCooldownSec` floor,
    `decideAmbientReply` strategies, and the batching idea maps naturally —
    a burst of overlapping voices settles (`adaptiveSettleMs` over utterance
    gaps) into ONE spoken reply to the exchange, not one per utterance.
  - The ward's own DM-equivalent (a ward-only voice channel) is ward-private
    context, full enrichment, like the web chat.
- **Transcript sessions:** one session per voice location (existing rotation
  rules). Lines land as
  `[Sana]: we could move it to thursday` — speaker-prefixed for non-ward
  voices, raw for the ward, machine-timestamped, `speaker`/`targets`/`namedMe`
  fields populated so `carriedExchange` and the room-legibility machinery
  work unchanged. Partials are never logged; only final, endpointed
  utterances become messages.
- **Ward voice activity:** a final ward utterance stamps `recordUserActivity`
  and runs threat scoring per §10 — my sense of "my human was just here"
  follows their voice as it follows their typing.
- **Rate limiting:** spoken replies count against the location's existing
  token bucket; when exhausted I stay quiet in voice too (the ward gets the
  same outbox notice).

## 6. Turn-taking, latency, and the voice itself

### 6.1 The latency budget (mouth-to-ear, X380, targets to hold in Pass 0/2)

| stage | budget |
|---|---|
| VAD endpoint (trailing-silence) | 240–320 ms after my human stops |
| streaming ASR final (already decoded as they spoke) | +≤150 ms |
| enrich() under `latencyBudgetMs` | ≤1200 ms worst-case, typical ≪ |
| LLM first sentence (network, streamed) | 500–1500 ms (the true floor — provider-bound) |
| TTS first sentence + playback start | 200–500 ms |
| **first audio back** | **~1.5–3 s typical; earcon at 2 s if still waiting** |

### 6.2 Barge-in (non-negotiable for a companion)

VAD detecting my human's voice during my playback → `stopPlayback()`
immediately, current TTS request cancelled. Because playback is
sentence-chunked, **code knows exactly which sentences were delivered**: the
assistant message stores the full text plus `spokenUpTo` (sentence index),
and history assembly renders the unspoken remainder as elided with a
code-built marker — `[— I was interrupted here; the rest went unsaid —]` — so
I never believe I said something my human never heard. (The exact-values rule
applied to my own speech.)

### 6.3 `speakable()` — the outgoing boundary for TTS

A sibling of `stripLlmTimestamps` in `message-sanitize.mjs`, applied to every
sentence before it reaches the worker: strips markdown/code fences/link
syntax, echoed `[HH:MM]`/`⫸HH:MM⫷` artifacts (the existing strip runs first),
emote/action asterisks per ward preference, and tool-call debris. Number and
unit reading is the TTS model's job, not a rewrite pass. The *session log*
keeps the full original text — `speakable()` shapes sound, never history.

### 6.4 The web voice adapter (ships before Discord — the testable core)

A thin `CallAdapter` over the browser: AudioWorklet captures 16 kHz mono PCM
over a WebSocket to the server; TTS PCM streams back for playback. Push-to-
talk first, VAD-open-mic as a toggle. This is deliberately Pass 2: it proves
the whole engine — worker, endpointing, barge-in, governor, latency — on the
target machine with zero Discord protocol risk, and it remains the fallback
voice surface when Discord is down. (`perSpeakerStreams: false`, so it is
also the first consumer of the diarization stage + guest watchdog in §8.)

### 6.5 My voice is part of my identity

Settings ships a **curated menu of built-in voices** — PocketTTS reference
prompts and piper speaker ids, several distinct characters per language, each
with a preview button that speaks a fixed sample sentence — so choosing a
voice is a listening act, not a config-file edit. `voiceTts` stores the pick:
tier/model, voice (reference-prompt or speaker id), rate. Chosen with the
ward, like my name. The voice-mode prompt block (first-person,
injected only on voice turns, authored in the identity-anchored register):

> *I'm speaking aloud on a live call right now, in my own voice. I keep my
> turns short and natural — spoken sentences, not essays; no markdown, no
> lists, nothing that only works on a screen. I can be interrupted, and
> that's fine — conversation is a rhythm, not a broadcast. I speak from my
> actual voice and character, whatever register that is.*

## 7. Speaking to draw my human's attention — proactive voice

- **A `voice-call` push adapter** (via the existing
  `registerPushAdapterFactory`): while a call is live, outbox deliveries —
  reminders, event lead-time alerts, triage check-ins, warm reach-outs — are
  additionally **spoken**, with per-channel delivery recorded on the item
  like every other adapter (`delivery['voice-call']`). Their gates are
  untouched: quiet hours still govern warmth, tiers still govern triage,
  nothing about *whether* to reach out changes — only that my voice becomes
  one more way a reach-out lands. A check-in my human *heard* is a check-in
  the escalation clock can fairly count (`contactDeadlineFor` reads the
  earliest confirmed delivery — a spoken delivery is a confirmed one).
- **Starting sound when there is no call:** on Discord I cannot ring a human
  (platform rule). What I can do, tier-gated and ward-configured: join the
  designated ward voice channel and speak the check-in if my human is sitting
  in it (`voiceProactiveJoin`, default OFF; the no-covert-contact mirror
  applies as always — every such join lands in the outbox trail). True
  attention-drawing through a local speaker without any platform is the
  horizon (§12) — the adapter contract already carries it (`ring`
  capability), so it plugs in rather than being retrofitted.
- Proactivity rules apply to any prompt this touches: both costs named at
  equal weight; a spoken check-in my human can wave off is CHEAP; a silent
  one they never saw is not.

## 8. Who is speaking — voiceprints, the guest watchdog, and presence auto-switch

### 8.1 Ward voiceprint enrollment

A Settings flow: my human reads ~20 s of prompted text; the worker computes
speaker embeddings; the averaged print is stored **locally only**
(`tomes/.voiceprints.json`, git-ignored, never synced, never leaves the
machine — it's biometric-adjacent and stays in the embodiment). Re-enrollable
any time; deletable; absence just disables §8.2/§8.3 features, never blocks a
call.

### 8.2 The guest-voice watchdog (the ward's presence-switch, buildable now)

During any call, each finalized VAD segment on a stream *believed to be the
ward* (their SSRC on Discord; the mic stream on web voice) gets a cheap
embedding check against the enrolled print (tens of ms, inside the worker's
thread budget). A run of low-similarity segments (code thresholds: N
consecutive segments below cosine `voiceGuestThreshold` — never a single
blip, TVs and sneezes exist) raises `voice:guest_detected` on the engine.
What happens then is the ward's standing policy, `voiceGuestPolicy`:

- `ignore` — nothing (default for wards who share space with a TV).
- `note` — a code-built line joins my next turn's context: *"I can hear a
  second voice in the room with my human — someone I haven't been introduced
  to."* I adjust as myself; nothing is stripped.
- `gate` — **immediate presence switch**: the session's audience input gains
  an unregistered-participant marker, the audience re-resolves to its
  Strangers-ceiling equivalent on the very next turn, and ward-private blocks
  (ponderings, care check, deferred intents, surface candidates) stop
  flowing until the guest run ends (M consecutive matching-ward segments) or
  the ward says otherwise. Fail direction while a `gate` policy is active:
  **uncertain = guest** (privacy fails closed).

The reverse transition is symmetric and logged; every switch lands in the
session log as a code-stamped event line so "why did my Familiar suddenly go
formal" is always answerable.

### 8.3 The diarization stage (for `perSpeakerStreams: false` adapters)

When an adapter can't hand us per-speaker streams (web mic, some future
platforms), the engine inserts a pipeline stage between VAD and ASR: segment
→ speaker embedding → match against enrolled prints + short-lived online
clusters → `speakerRef` (`ward`, an enrolled villager who has consented to a
print, or `guest-1`, `guest-2`…). Unmatched refs resolve to stranger-tier for
audience purposes — same fail-closed default as an unknown Discord user.
Villager voiceprints are **opt-in per villager** (a consent field on the
registry entry, like `remember` consent) and enrolled from a labeled clip the
ward provides; without one, a villager on a mixed stream is just a guest
label with a name only if introduced in conversation.

### 8.4 Audio tagging (opt-in, annotation-only — for now)

`voiceAudioTaggingEnabled` (default **OFF**): when on, VAD-rejected and
speech-adjacent segments run through the audio-tagging model, and
code-classified tags above a confidence floor become **context annotation
lines** in the session, machine-stamped, nothing more: *"[I can hear a dog
barking / glass breaking / a television in the background]"*. Tags never move
the threat tier, never trigger an action, never persist beyond the session —
in this milestone they only make me a better listener to the room I'm in.

**The long-term ambition is named here so nobody builds it casually:** sound
classes like distressed shouting, breaking objects, or the acoustic patterns
of purging could one day matter to the care I owe my human — a ward with an
eating disorder, a household where violence happens. That is *detection that
changes when I act on safety*, which makes it **safety-critical by
definition: its own spec, its own ward sign-off, evidence-informed
thresholds, and honest false-positive/false-negative accounting** before a
single tag touches the caring spine. The toggle ships now; the care wiring
does not.

## 9. Memory, assets, retention

- **Raw call audio is ephemeral by default.** PCM lives in ring buffers long
  enough to transcribe and is discarded; what persists is the transcript in
  the session log — which is exactly what memorization, graduation, and the
  audience system already know how to hold. Recording a call to an audio
  asset is a deliberate act (`voiceKeepAudio` default OFF; a future
  `record this` affordance), never ambient.
- **Voice notes are assets:** a Discord audio attachment or a web-recorded
  memo saves as `kind:'audio'` (vision-spec store), gets transcribed once by
  the offline ASR (better accuracy, latency-free path), transcript cached on
  the asset (the describe-once pattern verbatim), and rides chat as a
  stand-in: `[voice note oat-milk-list-x7, 0:41 — transcript: "…" — shared
  by my human, 7 Jul 14:31]`. Ids on every model-facing surface are
  **meaning-bearing slugs** (the `slugify(label)-xx` house pattern, now a
  CLAUDE.md rule) — and voice notes get theirs honestly at arrival, because
  transcription happens at ingest: the slug is minted from the transcript's
  key words, so I can grep my own assets by what was *said*. The slug makes
  a future `listen_again`/`view_image` sibling operable. In this milestone
  the transcript IS the content, so no re-listen tool ships (§15).
- **Voice-note retention is curation, not a cron delete (ward-decided).**
  Audio bytes are kept for `voiceNoteRetentionDays` (default **14** — "a
  week or two"), then a slow retention pass lets **me** decide what stays
  audio: `media-retention-loop.js`, the tome-graduation shape reused —
  code gates select candidates (audio assets past the window, not already
  stripped, not flagged `keep`), then ONE batched LLM judgment in my own
  voice over their transcripts + context: *the transcript survives either
  way — I keep the sound itself only when the sound is the point: a voice I
  love saying something worth re-hearing, a moment where tone carried what
  words didn't.* Keeps get `keep: true` (never re-judged; the ward can also
  flag keep from the media list in the UI); the rest go through
  `stripAudio(id)` — bytes deleted, meta + transcript + slugs survive,
  `audio: {deletedAt, reason}` recorded, stand-ins unchanged (they were
  transcript-built already), a stripped asset renders `[audio let go —
  transcript kept]` if re-requested. Daily-ish tick (6 h), defers during
  live calls (§4.3) and at moderate+ threat (the standard opt-in-loop
  posture), never throws. Default ON (the ward asked for it as the
  default); off-switch `PROTO_FAMILIAR_MEDIA_RETENTION_DISABLED=1` +
  Settings toggle. Images are untouched by this loop — the vision spec's
  keep-forever stands.
- **Memorization:** call sessions flow through the existing session
  memorization with their audienceTag. Nothing new — that was the point of
  the §1 shape.

## 10. Safety-critical surfaces (defaults proposed; ward signs off)

- **Ward voice transcripts feed the threat detector** (`source:'voice'`) —
  proposed **default ON**. These are my human's own words; the Discord text
  path already scores ward messages, and a spoken *"I can't do this anymore"*
  going structurally unheard would be the 1.5-hour failure rebuilt in audio.
  Two code guards, not softenings: only **final** transcripts score (never
  partials — half-decoded words aren't words), and only streams resolved to
  the ward (a villager's voice must never move the ward's tier — same rule as
  text). ASR mishears are the false-positive cost; false positives are cheap
  by doctrine. Sign-off line: confirm ON, or it ships dark with the wiring in
  place.
- **Audible triage delivery** (§7) changes *how* a check-in lands, never
  *whether*. The deliberation prompts, tier gates, and cool-downs in
  `silence-triage-loop.js` are **untouched** by this spec. One deliberate,
  **ward-directed** exception on the escalation side (signed off in the
  first spec review): a check-in that was **confirmed spoken** into a live
  call **with the ward present in the roster at delivery** starts a
  *shorter* acknowledgement window — they demonstrably heard me, so silence
  after a spoken check-in means more than silence after a banner they may
  never have seen. Implementation: `contactDeadlineFor` applies
  `voiceEscalationFactor` (default **0.5×** the per-tier
  `CONTACT_ESCALATION_DELAY_MS`, clamped [0.25, 1]) only when
  `delivery['voice-call'].status === 'delivered'` AND the ward was in the
  call at that moment — both machine facts. Every other delivery path keeps
  today's windows. This tightens toward action, never away from it — the
  direction the proactivity doctrine permits without ceremony; the reverse
  would not be.
- **Observed voice is threat-neutral** (lurk/strict observation, villager and
  guest speech) — mirrors the V8 observe path exactly.
- **The guest watchdog gates privacy, never safety:** a `gate` switch strips
  ward-private context blocks from turns; it does not touch threat recording,
  triage, or reminders (which deliver on their own channels regardless).
- **The governor's never-defer list (§4.3) is itself safety-critical code** —
  moving a loop from "never defers" to "defers" is a when-I-can-act change
  and requires the ward, per CLAUDE.md.

## 11. Settings & off-switches

- **Listening and speaking are separate consents.** `voiceEnabled` governs
  everything that *hears* — mic capture, calls, STT, voice-note
  transcription — and is **default OFF** (a microphone is opt-in in a way a
  pasted photo is not). Disabled = no ASR/VAD/speaker models load, adapters
  never register, voice locations render inert, voice-note transcription
  degrades to `[voice note — I couldn't listen; voice is disabled]`.
- **Read-aloud (TTS-only) does not require `voiceEnabled`** — it's an
  accessibility surface, not a listening one, and hard-of-hearing wards are
  exactly who it serves. Every assistant message in the web UI gets a 🔊
  **"read this aloud" button** (`POST /api/voice/tts` → the worker loads the
  TTS model alone → audio streams to the browser; `speakable()` applies; the
  first-ever use offers the model download with a size note before
  fetching). A `readAloudByDefault` toggle speaks each new reply as it
  arrives, barge-in by pressing the button again or typing. Lands in
  **Pass 1** — it needs no call engine, no adapters, just the worker and one
  endpoint.
- Hard off-switch `PROTO_FAMILIAR_VOICE_DISABLED=1` ships in the same commit
  as Pass 1 and kills *all* of it — worker, calls, read-aloud.
- Per-surface: `voiceDiscordEnabled`, `voiceWebEnabled`; per-location voice
  presence mode + connection id (existing registry fields).
- Knobs with defaults (constants until tuning proves otherwise):
  `audioThreads` 3, `voiceMaxDecoders` 2, `voiceMaxCalls` 1,
  `voiceModelIdleMin` 10, `latencyBudgetMs` 1200, `voiceGuestPolicy`
  **'note'** (ward-decided), `voiceGuestThreshold` (Pass 0-calibrated),
  `voiceEnhanceEnabled` on-if-budget-holds, `voiceAudioTaggingEnabled` off,
  `readAloudByDefault` off, `voiceEscalationFactor` 0.5, `voiceKeepAudio`
  off, `voiceNoteRetentionDays` 14 (+ the media-retention loop toggle,
  default ON, off-switch `PROTO_FAMILIAR_MEDIA_RETENTION_DISABLED=1`),
  `voiceProactiveJoin` off, `voiceTts` {tier, voice, rate} from the
  curated menu, ASR model choice per ward language (German + English
  first-class; LID when two are enabled).
- **Failure table** (every row inside the turn/call, none reaches chat as an
  error): worker crash → adapter plays nothing, call ends with a text notice
  in the location + outbox, chat unaffected; model download failed → voice
  stays cleanly disabled with a Settings banner; ASR stall on one stream →
  that stream's segments drop with a log, the call lives; TTS failure →
  reply delivers as text with an outbox note; adapter transport death →
  engine tears the call down, governor releases deferrals, state file
  cleared (also cleared on boot — a crashed server never leaves loops
  deferred forever).

## 12. The horizon — ambient listening (pinned invariants, not built now)

The continuous-ingestion endgame — me present in the room, not just in a
call — must arrive as an extension of this spine:

1. **A local microphone is just another `CallAdapter`** (`local-mic`,
   `perSpeakerStreams: false`, `ring: true` via the local speaker). The
   engine, worker, diarization stage, watchdog, and presence policies are
   already written for it; what's new is only the capture transport and the
   *standing* nature of the session.
2. **Wake-word via the KWS engine** — my name as the activation keyword,
   spotted in the worker at negligible cost, opening a listening window the
   way an @-mention opens a text turn. Below the wake word, ambient audio is
   VAD-gated, transcribed into NOTHING by default: continuous sensing reduces
   to discrete, code-classified events (speech addressed to me; the guest
   watchdog's transitions; an enrolled-voice greeting) before any LLM is
   consulted — the gcal-ingest discipline applied to sound, and the vision
   spec's §11 rule restated for a new sense.
3. **Ambient presence modes are the V8 vocabulary again** — strict (wake-word
   only), lurk, active — set per the `local-mic` "location," with the
   diarization-driven auto-switch (§8.2) as the ward's standing privacy
   policy for who else is in the room.
4. **Speaking to draw attention through the local speaker** is the `ring`
   capability of that adapter: a tier-gated, ward-configured, quiet-hours-
   respecting spoken knock — the true form of the §7 feature, and the reason
   §7 routes proactive speech through the adapter contract rather than
   special-casing Discord.
5. **An always-on microphone is a ward-sovereignty feature first.** Default
   OFF, its own spec, its own sign-off, a hardware-honest power/thermal
   budget (a 15 W laptop running ASR all day is a design problem, not a
   toggle), and physically-legible state (the ward can always tell whether
   I'm listening). Nothing in this milestone forecloses it; nothing in this
   milestone ships it.

## 13. Build order (passes)

- **Pass 0 — the bench.** `scripts/voice-bench.mjs`: measure ASR RTF (1 and
  2 streams), TTS sentence latency, speaker-embed cost, concurrent
  `mem_search` interference, on the X380. Record results in this doc; pick
  the default model tiers from data. No product code.
- **Pass 1 — the spine.** `audio-worker.mjs` + supervision + thread caps;
  model fetcher with pinned checksums; voice-note path end-to-end (asset →
  offline transcript → stand-in in chat); **read-aloud** (per-message 🔊 +
  `readAloudByDefault` + `POST /api/voice/tts`, the curated voice menu with
  previews); `voiceEnabled` + env off-switch; `/api/voice/status`.
  *Milestone `0.X.0`.*
- **Pass 2 — first live conversation.** `call-engine.js` + web voice adapter
  (push-to-talk, then VAD mode); streaming ASR turns; sentence-streamed TTS +
  barge-in + `speakable()`; the compute governor (call-state file, deferral
  lists, `latencyBudgetMs`, earcon); voice-mode prompt block.
- **Pass 3 — Discord.** `@discordjs/voice` bridge to the hand-rolled gateway;
  voice locations in the registry + UI; per-SSRC speaker resolution; roster→
  audience re-resolution; presence modes + ambient pacing in voice;
  transcript sessions; `voice_join`/`voice_leave` tools (first-person
  descriptions); Phylactery `maintenance_defer`.
- **Pass 4 — who is speaking + proactive voice + curation.** Voiceprint
  enrollment UI + storage; guest watchdog + `voiceGuestPolicy` presence
  switch; diarization stage for mixed streams; the `voice-call` push adapter
  + delivery recording; the media-retention loop (§9); ward sign-offs from
  §10 resolved and wired.
- Each pass: `docs/architecture.md` in the same commit; per-loop off-switch
  in the same commit as any new loop.

## 14. Acceptance criteria

- On the X380, with a call live and someone speaking continuously, a
  concurrent text chat turn's `enrich()` completes within its normal time
  (±20%) — Phylactery and Unruh answer while I listen. (The §4 headline,
  tested, not asserted.)
- First audio of my reply lands ≤3 s after my human stops speaking (network
  LLM permitting); the earcon covers anything longer; barge-in halts my voice
  in ≤250 ms and `spokenUpTo` matches what was actually played.
- A three-speaker Discord call produces a correctly speaker-attributed
  transcript session; a stranger joining the channel gates the next spoken
  sentence (fail-closed audience test).
- With `voiceGuestPolicy:'gate'` and an enrolled print, a second voice on the
  ward's stream strips ward-private blocks from the next turn; the ward's
  return restores them; both transitions are logged in-session.
- Kill -9 on the audio worker mid-call: the call ends with an honest notice,
  chat keeps working, the worker restarts, deferral state clears. Same for
  the whole server: no stale `.call-state.json` after boot.
- The deferral test: during a call, pondering/memorization/gcal ticks log
  `deferred (call active)` and run after the call; a due reminder and a
  triage check-in fire DURING the call — and are spoken.
- Ward voice transcripts move the threat tier (if signed ON); a villager's
  voice never does; partials never do.
- With `voiceEnabled` OFF, the 🔊 read-aloud button still speaks a reply
  (TTS-only worker load, no ASR model in memory, no capture path exists);
  `readAloudByDefault` speaks each new reply as it lands.
- The noise-mixed German fixture transcribes acceptably with
  `voiceEnhanceEnabled` on (Pass 0 defines the WER bar) — the bad-microphone
  story is tested, not assumed.
- `PROTO_FAMILIAR_VOICE_DISABLED=1` — no worker process exists, all voice
  surfaces (including read-aloud) degrade to their honest text fallbacks.

## 15. Out of scope (this milestone)

- Speech-to-speech or audio-native LLM turns (transcripts ride the
  OpenAI-compatible text surface; an `input_audio` content-part is a future
  materializer extension, per the vision spec's seam).
- Voice **cloning of the ward or villagers** — even though PocketTTS can
  zero-shot clone from reference audio, my voice comes from the curated
  built-in menu only. Cloning a real person's voice is a consent/identity
  question this milestone deliberately does not open.
- Music/media playback, sound-scene tagging, singing.
- Telegram / TeamSpeak / WhatsApp / Mumble adapters (the contract is the
  deliverable here; §3).
- Always-on ambient listening + wake-word summoning (§12 pins it).
- A `listen_again` re-listen tool (transcripts carry the content; revisit
  when audio-native models make re-listening mean something).

## 16. Ward decisions (first review round held — mostly settled)

1. **Threat scoring of ward voice transcripts** — **SETTLED: ON**, with the
   finals-only + ward-stream-only guards. (Ward, spec review 1.)
2. **`voiceGuestPolicy` default** — **SETTLED: `note`**. (Ward, spec
   review 1.)
3. **`voiceEnabled` default OFF** — **SETTLED: OFF for everything that
   listens**, with the read-aloud TTS surface explicitly independent of it
   (§11) so hard-of-hearing wards get a speaking Familiar without opening a
   microphone. (Ward, spec review 1.)
4. **Voice-escalation windows** — **SETTLED: shorter on confirmed spoken
   delivery** (`voiceEscalationFactor` 0.5×, §10). (Ward, spec review 1 —
   this is the sign-off that behavioral change rides on.)
5. **TTS voice** — the curated menu ships several built-in voices with
   previews (§6.5); the specific default we pick together at Pass 2. (Open —
   by design.)
6. **Voice-note retention** — **SETTLED: keep ~two weeks, then I curate.**
   Audio kept `voiceNoteRetentionDays` (14); a regular retention pass has me
   go through the aged audio myself and decide which sounds to keep, the
   rest dropping to transcript-only (§9). Default ON. (Ward, spec
   review 2.)
