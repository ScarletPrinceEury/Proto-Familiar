# Voice Pass 2 — first live conversation (build spec, architecture-reconciled)

**Status: PLAN, not yet built. Ward review pending — the §"Open ward
decisions" list gates the safety-adjacent pieces.**

This is the detailed build plan for **Pass 2** of the voice milestone, as
scoped by `docs/voice-build-spec.md` §13. It is a *companion* to that spec,
not a replacement: the parent spec still owns the engine contract (§3), the
compute-governor mechanisms (§4), turn-taking/barge-in (§6), proactive voice
(§7), and the safety surfaces (§10). This doc exists because the parent spec
was written at ~0.9.30, **before the noticing loop and the intentions /
deferred-intents system existed**, and Pass 2 is the first pass whose design
actually touches them. Where this doc and the parent disagree, the reconciled
version here is the one to build — and the parent's §4 and §7 get updated in
the same commit that builds each piece (they already invite it: §4.3 says
"reconcile this list against the live `*-loop.js` roster at build time").

The whole voice milestone is **one feature**: every pass bumps **PATCH** only
(ward decision, recorded here so it is not re-litigated). No pass raises the
minor; `0.11` is not earned by voice.

---

## 1. Pass 2 scope (recap from parent §13)

> **Pass 2 — first live conversation.** `call-engine.js` + web voice adapter
> (push-to-talk, then VAD mode); streaming ASR turns; sentence-streamed TTS +
> barge-in + `speakable()`; the compute governor (call-state file, deferral
> lists, `latencyBudgetMs`, earcon); voice-mode prompt block.

Discord voice, voiceprints/guest-watchdog, diarization, and the media-retention
loop are **Pass 3 / Pass 4** and out of scope here. Pass 2 proves the whole
engine on the web adapter with zero Discord-protocol risk (parent §6.4).

## 2. What changed since the parent spec — the reconciliation

Four architectural facts postdate the parent spec. Each forces a specific
adjustment; none changes the engine's shape, only what plugs into it.

### 2.1 The loop roster grew, and the deferral list (§4.3) is stale

The parent's defer list names: pondering, memorization drain, memory sweep,
tome graduation, gcal sync, needs-tracking, content-regate, media retention.
The live roster (almanac `architecture/autonomous-loops.md`, 0.10.x) adds
**noticing** and **content-regate is already listed** but **reachout** and
**noticing** are classified in neither the "defers" nor the "never defers"
list. The build-time reconciliation §4.3 asked for is now due. Reconciled
classification for a live call:

| Loop | During a live call | Why |
|---|---|---|
| pondering | **defer** | minutes-scale, nothing lost by 20 min later (parent §4.3) |
| memorization drain | **defer** | same |
| memory sweep | **defer** | same |
| tome graduation | **defer** | same |
| gcal sync | **defer** | same |
| needs-tracking | **defer** | same; also already stands down at moderate+ threat |
| content-regate | **defer** | same |
| **reachout (warm)** | **defer** | redundant during a live call — the ward is *maximally* present, which is exactly the state warm reach-out exists to break. Its own ward-active gate (`WARD_ACTIVE_THRESHOLD_MS`) already suppresses a knock when the ward spoke recently; **the call-state file must feed that gate** so a live call counts as "ward active." Deferring warmth here is not a safety softening — triage is the separate track, and warmth already stands down at moderate+ threat. |
| **noticing** | **run, speak not banner** (ward-signed, D1) | Noticing keeps ticking — it is ward-signed to *not* stand down, and an aging intention or a widening contact gap is exactly what's useful to surface when things are hard. Because its `reach_out_to_ward` rides the outbox, during a call its output is **spoken in the conversation** rather than raised as a banner over a call already happening. This narrows *nothing* about when noticing acts — wake conditions and threat posture are untouched — it only changes the delivery channel to the one the ward is already in, so it stays inside noticing's existing sign-off. |
| silence-triage | **never defer** | the caring spine; a call is the opposite of a reason to slow it (parent §4.3). It still runs; its check-in is *spoken*, not bannered (parent §7). |
| threat recording | **never defer** | nil CPU; network-bound |
| reminders + event alerts | **never defer** | spoken during the call (parent §7) |
| outbox dispatch | **never defer** | it is the delivery path Pass 2 hooks (see 2.3) |

The defer decision is code (`isCallActive()` at tick start), one line per loop,
each already carrying the reentrancy guard. No new mechanism — the parent's
`tomes/.call-state.json` is the whole apparatus; this only lengthens the list
it governs.

### 2.2 Intentions / deferred-intents are a new outgoing surface the voice-mode prompt must carry

The parent's voice-mode prompt block predates the `[Deferred intents from my
free time]` surface (`recent-ponderings.js` `formatDeferredIntentsBlock`, fed
by `getUnactedIntents({markSurfaced:true})`, injected on live ward-private
turns at `thalamus.js:2042`). Today a pending **tell** (a warm thing the
Familiar wanted to bring up) surfaces as that block on a text turn and is
auto-consumed in code once shown (the 0.9.32 fix — a tell is done when voiced,
no ack needed). **A live voice call is a ward-private turn**, so:

- The voice-mode prompt block **includes the deferred-intents block**, so the
  Familiar can voice a pending tell *naturally in the conversation* instead of
  it waiting to arrive later as a banner over a call that is already happening.
- **The auto-consume-on-surfacing must fire on voice turns too.** `markSurfaced`
  is already the mechanism; the voice turn must run the same "mark shown →
  next live turn marks acted_on in code" path, or a tell voiced aloud will
  re-surface as a banner an hour later (the exact 0.9.32 triple-ask failure,
  re-opened on a new surface). This is a surface-matrix cell (RULE C), not a
  new feature: *does the voice turn run `getUnactedIntents({markSurfaced})` and
  the code-side consume?* — must be marked wired, with a pipeline test.
- **Filing intents (tome/memory/identity) and follow-ups still need the real
  tool call + `acknowledge_deferred_intent`** on a voice turn, exactly as on
  text — they carry a real side-effect, so "the model said it" ≠ "the action
  happened" (CLAUDE.md recorded error #2/#5). Tools stay fully available on
  voice turns (parent §4.5 capability parity), so this already works; the test
  is that a filing intent voiced on a call actually files.

### 2.3 Proactive voice already generalizes — because noticing rides the outbox

Parent §7 builds proactive voice on a `voice-call` push adapter that speaks
**outbox** deliveries (reminders, event alerts, triage check-ins, warm
reach-outs). The reconciliation is a *simplification*: noticing's
`reach_out_to_ward` is "a warm knock via the existing delivery path"
(`cerebellum.js:4071`) — i.e. the same outbox. So the push adapter §7 already
describes **covers noticing's reach-outs for free**; no noticing-specific voice
wiring is needed. The adapter is registered via the existing
`registerPushAdapterFactory` (the pattern `discord-bot-dm` uses,
`server.js:4734`), records `delivery['voice-call']` on the item like every
other channel, and `contactDeadlineFor` counts a spoken delivery as a confirmed
one. This is the single cleanest part of the reconciliation: the outbox is
already the union point, so "everything proactive gets spoken during a call"
is one adapter, not one-per-loop.

### 2.4 The §7 proactivity language is on the retired rule

Parent §7's closing bullet — *"both costs named at equal weight"* — is the
**old** proactivity rule. CLAUDE.md's revised rule 2 explicitly retired
equal-weighting ("the model already over-weights the cost of acting, so 'hold
both at equal weight' reads to it as 'find reasons to wait'"). Any Pass 2
prompt that §7 touches (the voice-mode block, any spoken-check-in framing) uses
the **revised** rule: name what silence costs, lean on the invited-default,
do **not** stage a symmetric balance-sheet. This is a prompt correction folded
into the voice-mode block, not new behavior.

## 3. Build order (sub-passes within Pass 2)

Each sub-pass ships with its off-switch and its `docs/architecture.md` update
in the same commit (parent §13 discipline). PATCH bump each.

1. **2a — the worker pipeline. ✅ LANDED (0.10.20).** `audio-worker.mjs` gained
   an `asr-streaming` role (online zipformer transducer) + a `vad` role
   (Silero), the `asrStream` / `asrStreamStop` ops, and `KIND_PCM` routing into
   `feedDecoder` (accept → decode-while-ready → `getResult`; unsolicited
   `asr-partial` / `asr-final` frames; endpoint→reset). `pcm16ToFloat` is the
   new capture-side inverse of `floatToPcm16`. Endpoint rules named in
   `ASR_ENDPOINT` for hardware tuning. Verified on the real engine (chunked ==
   whole-file decode) with a spawned-child pipeline test guarded by
   `PF_ASR_STREAMING_MODEL_DIR` (skips in CI). Rides `voiceEnabled` +
   `PROTO_FAMILIAR_VOICE_DISABLED=1`; the ops are inert until 2b drives them.
   **Deferred to on-hardware tuning:** VAD-gating of the decode loop (the
   `vad` role loads but the first cut uses the recogniser's own endpointing,
   which is proven correct) and the endpoint-rule values against the §6.1
   latency budget.
2. **2b — `call-engine.js` + the web adapter (push-to-talk).** ✅ **Engine spine
   landed (0.10.21).** `call-engine.js` carries the `CallAdapter` contract +
   registry (`registerCallAdapter`), the one-call lifecycle (`voiceMaxCalls`),
   the `tomes/.call-state.json` file with `clearStaleCallState` (boot) +
   `isCallActiveFromFile` (the §4.3 governor read, fail-safe to inactive),
   speaker→stream routing to the worker, endpoint→turn assembly, and
   `endUtterance` — push-to-talk's explicit turn boundary (the release), which
   finalises via the proven 2a stop→reopen rather than a new "force endpoint"
   op. The turn runner is an injected `onTurn` seam. Verified end-to-end through
   the REAL worker (fake transport-only adapter + a streamed wav → transcript
   turn → playback), plus pure tests for the registry, lifecycle, busy/disabled,
   and the call-state file. Hard off-switch `PROTO_FAMILIAR_VOICE_CALL_DISABLED=1`.
   **Remaining (next slice): the web adapter itself** — the WebSocket transport +
   browser capture/playback UI + the real `onTurn` wiring in server.js
   (enrich → provider → `speakable()` → TTS) + session logging.
3. **2c — sentence-streamed TTS + barge-in + `speakable()`.** First audio after
   the first sentence; barge-in halts in ≤250 ms with `spokenUpTo` matching
   what actually played (parent §6.2 — non-negotiable, exact-values rule: the
   played-sample count is code's, never the model's).
4. **2d — the compute governor.** Call-state deferral (the reconciled 2.1
   list), the two-tier `enrich()` latency budget (soft ~1200 ms / earcon-bridged
   hard ~3000 ms — 39 ms measured baseline gives enormous headroom, so the
   tiers are for the tail only), Phylactery `maintenance_defer`, the earcon
   asset. Off-switch per new deferral behavior.
5. **2e — the voice-mode prompt block + intentions integration (2.2) + the §7
   language fix (2.4).** The block that tells the Familiar it is in a live
   spoken turn, carrying the deferred-intents surface and the corrected
   proactivity framing. First-person throughout (CLAUDE.md non-negotiable).
6. **2f — VAD open-mic toggle.** The open-mic mode on top of the proven
   push-to-talk engine, once endpointing (2a) is tuned against the latency
   budget.

## 4. Safety-critical seams (ward sign-off required)

Per CLAUDE.md, these do not ship on my judgment:

- **Ward voice transcripts → threat tier (D2 — RESOLVED: ON by default, with
  off-switch).** A ward's spoken words feed the same `scoreMessage`/`recordThreat`
  spine as vision (0.9.2) and text; a villager's voice never does; partials
  never do (parent acceptance). The `crisis-signals.js`/`threat-tracker.js`
  internals stay UNCHANGED — orchestration around them only, exactly as vision
  did. Gated by `voiceThreatScoring` (default ON) +
  `PROTO_FAMILIAR_VOICE_THREAT_DISABLED=1`, also standing down under the global
  `PROTO_FAMILIAR_THREAT_DISABLED=1`. Full sign-off still applies to the *wiring*
  (the score source is the transcribed text, never raw model prose — the vision
  discipline) even though the default is settled.
- **Noticing during a call (D1 — RESOLVED: run, speak not banner).** Noticing
  keeps ticking during a call; its outbox-delivered reach-out is spoken
  in-conversation rather than bannered. Delivery-channel only — noticing's wake
  conditions and threat posture are untouched, so it stays inside its existing
  sign-off rather than narrowing when it acts.
- **Triage spoken during a call.** Triage never defers and its check-in is
  spoken; the deliberation path is unchanged (`callProviderChat`, cap 4000,
  the 0.8.82 ward-signed fix). Confirm the spoken delivery does not alter the
  escalation clock beyond "a heard check-in is a confirmed delivery" (parent
  §7, already the intended semantics).

## 5. Surface matrix (RULE C) — the cells Pass 2 must mark

Every turn-machinery capability lands in shared code or the spec carries the
matrix. Pass 2's cells, each to be marked wired-or-N/A in the shipping commit:

| Capability | web push-to-talk | web VAD open-mic | (Discord — Pass 3) |
|---|---|---|---|
| streaming ASR turn | 2b | 2f | N/A here |
| barge-in / `spokenUpTo` | 2c | 2c | N/A here |
| deferred-intents in prompt + auto-consume | 2e | 2e | N/A here |
| proactive outbox spoken (incl. noticing) | 2b | 2b | N/A here |
| ward transcript → threat (if signed on) | 2d/2e | 2d/2e | N/A here |
| call-state deferral of loops | 2d | 2d | N/A here |

## 6. Off-switches (parent §11 discipline — every new loop/behavior)

- `voiceEnabled` + `PROTO_FAMILIAR_VOICE_DISABLED=1` — the whole worker.
- The call-state deferral is inert when no call is active; a
  `PROTO_FAMILIAR_VOICE_CALL_DISABLED=1` disables the live-call path while
  leaving read-aloud/voice-notes (Pass 1) working.
- Ward-transcript threat scoring gets its own gate mirroring the vision one
  (`visionThreatScoring` → a `voiceThreatScoring` sibling +
  `PROTO_FAMILIAR_VOICE_THREAT_DISABLED=1`), also standing down under the
  global `PROTO_FAMILIAR_THREAT_DISABLED=1`.

## Open ward decisions

- **D1 — Noticing during a live call. ✅ RESOLVED: run, speak not banner.**
  Noticing keeps ticking during a call; because its reach-out rides the outbox,
  its output is spoken in-conversation rather than bannered. Delivery-channel
  only — wake conditions and threat posture untouched (see 2.1, §4).
- **D2 — Ward voice transcripts → threat. ✅ RESOLVED: ON by default, with an
  off-switch.** A distressed spoken message can raise the tier, feeding the same
  threat spine as vision/text; gated by `voiceThreatScoring` (default ON) +
  `PROTO_FAMILIAR_VOICE_THREAT_DISABLED=1` (see §4, §6). Wiring still gets the
  full vision-discipline sign-off (score the transcript, never raw prose).
- **D3 — Is Pass 2 the milestone-complete `0.X.0`, or does the milestone
  complete at Pass 4? — OPEN (non-gating).** Affects nothing in the build; only
  which pass drops the suffix / lands the milestone note. Patch-only until then,
  regardless.

## Grounding references

- Parent: `docs/voice-build-spec.md` §3, §4, §6, §7, §10, §11, §13.
- Measured numbers: `docs/voice-bench-results.md` (39 ms enrich baseline;
  default listening/pocket tier 542 MB installed — all inside §0.7 ceilings).
- Current architecture: almanac `architecture/autonomous-loops.md`,
  `architecture/voice.md`, `architecture/safety-spine.md`; `recent-ponderings.js`
  (intentions), `cerebellum.js` (noticing tools), `outbox.js`.
