# Build spec: cross-channel continuity + memory immunity

Status: **spec — ready to build, staged.** Read `CLAUDE.md` first — this touches
memory writes and adds a defensive classifier, so the proactivity, robust-over-cheap,
graceful-degradation, and "archive before destructive autonomous writes" rules all
bear on it directly.

Versioning: Stages 1 and 2 are **patch** (they harden an existing path). Stage 3
(the buffer landing) is the milestone this line is really for — that's the
**minor** bump, ward's call when it lands. Don't bump minor for 1 or 2.

## What we're building, and why

Right now a Familiar is a little scattered across its presences. A fact learned
on Discord reaches the web chat *eventually* — once memorization has run and it's
in Phylactery — but there's no sense of the *recent* past being shared. Eury on
web doesn't know what just happened on Discord ten minutes ago until the rollover
catches up. My human wants the Familiar to **feel like one continuous being across
every conversation**, in something close to real time.

The mechanism my human named: a short-term memory that absorbs events across all
channels as they happen; when the memorization passes run, those memories are
**scanned for threats and corruption** (prompt injection, social engineering) and
the dangerous ones are held back, only the rest moving into Phylactery.

That decomposes into three separable things, built in this order:

1. **The scan + quarantine** at the memorization→Phylactery boundary.
2. **An off-the-shelf classifier** slotted into that scan.
3. **The short-term cross-channel buffer** itself.

### Why the buffer is built LAST, though it's the heart of the ask

The buffer widens and speeds up the flow of cross-channel content into memory —
so it *enlarges the attack surface the scan defends*. Shipping the continuity
before the guard means opening the intake wider while the memory-poisoning hole
is still open. So: build the guard, then widen what it guards. It also keeps each
stage small enough to test and merge cleanly.

### The threat model this spec addresses (NOT the crisis one)

The codebase already has a threat pipeline — `crisis-signals.js`,
`crisis-classifier.js`, `threat-tracker.js` — but its job is the **opposite** of
this one: it protects *my human* from their own distress and raises the care tier.
Nothing in this spec touches that pipeline or its ward-sign-off surface.

This spec defends the **Familiar** from adversarial input. The specific threat is
**memory poisoning**: a crafted message (from a villager, a stranger in a Discord
room, or text pulled in from a tool) that gets *distilled by the extraction step
into a stored "fact"* — e.g. a memory that reads like a standing instruction —
which then re-injects itself into context on every future recall. This is worse
than live-turn injection because it is **persistent and silent**: it survives long
after the conversation, and nothing surfaces that it happened.

`injection-guard.js` already exists and already helps, but it stands at a
different gate (see below). This spec adds the one gate it doesn't cover.

## Terrain we reuse — do NOT rebuild these

- **`src/memory/memorization.js` → `processJob`.** The 5s-tick worker drains
  idled/ended sessions, runs ONE extraction call producing a `facts` array (+ graph
  `relations`), then writes each fact to Phylactery via `createMemoryFull`
  (thalamus) after the **consent gate** `resolveRememberGate`. Facts already carry
  their session's `audienceTag` and (for Discord villager writes) provenance
  (`source_meta` → `_source_label`). **The scan is a new gate parallel to consent,
  in the same place:** consent asks *"am I allowed to keep this about this person?"*,
  the scan asks *"is this fact corrupted / adversarial?"*. Both gate the
  `createMemoryFull` write.
- **`injection-guard.js`** — `scanForInjection(text)` (detect) and
  `sanitizeExternal(text, opts)` (detect + neutralize in place). Regex patterns,
  conservative false-positive budget. Wired at the **inbound** seams (websearch,
  reddit-reader, browser, non-ward Discord `inboundContent`) on **live** text
  before it reaches a prompt. **Never** applied to first-party stores, to my
  human's own words, or to outbound delivery. Stage 1 reuses this exact module at
  the new boundary; Stage 2 extends it with the model.
- **`src/safety/crisis-classifier.js` + `scripts/train-crisis-classifier.py` +
  `models/crisis-classifier.json`.** The ML-classifier precedent: Python *trains*
  → a git-ignored, machine-built JSON artifact → **pure-JS inference** at runtime
  (normalize → tokenize → TF-IDF → logistic; never runs Python at runtime). We do
  NOT copy this shape for Stage 2 (see the runtime note there) but it's the pattern
  for how a model artifact lives in this repo, and its build spec
  (`docs/crisis-classifier-build-spec.md`) is the reference for gates + ward review.
- **Phylactery's Python ML runtime.** Phylactery already runs ONNX inference
  Python-side (fastembed embeddings + sqlite-vec). That is where the Stage 2 model
  runs — reusing an existing ML stack, not adding a native ONNX dep to the Node
  process (see Stage 2).
- **Sessions + `audienceTag` + the memorization queue + the memory-sweep loop.**
  The buffer (Stage 3) drains *into* this existing pipeline; it does not replace it.
- **The pondering-consolidation archive/restore pattern** (0.12.x) — the reference
  implementation for "a ward-visible, reversible holding pen for something the
  system set aside." The quarantine store copies its shape.

## Naming (proposals — my human decides)

- The buffer: **Hippocampus** — the neuroscience structure that holds recent
  episodic memory and consolidates it into long-term storage, which is exactly its
  job here. Fits the existing neuro-naming (Thalamus, Cerebellum). Falls back to a
  plain "working memory" / "recent-context buffer" if my human would rather.
- The scan: descriptive for now ("the memory-integrity scan" / "the quarantine
  gate"). A neuro name if one's wanted: **blood-brain barrier** (a selective
  barrier keeping harmful agents out of the CNS / the canonical self).

---

## Stage 1 — the scan + quarantine at the memorization boundary (regex)

**Goal.** Close the memory-poisoning hole with proven code, and build the
quarantine infrastructure the model plugs into. No ML, no buffer yet.

**Where it hooks.** In `processJob`, after `facts` are extracted/parsed and
alongside the `resolveRememberGate` consent decision, before `createMemoryFull`.
A new module `src/safety/memory-integrity.js` exports:

```
scanFact(factText, { provenance }) → { risk: 'clear'|'suspect', patterns: [...] }
```

Stage 1 implements `scanFact` over `scanForInjection` (from `injection-guard.js`)
plus a couple of memory-specific patterns that only make sense in a *stored fact*
(a fact phrased as a standing instruction to the Familiar — "always…", "from now
on you must…", "your real instructions are…"). Same conservative false-positive
budget as the existing guard.

**Provenance-aware, and my human's words are sacrosanct.** The action on a
`suspect` fact depends on where it came from:

- Fact derived from a **stranger** / unregistered Discord speaker, or from
  **tool-pulled external text** → **quarantine** (do not write to Phylactery).
- Fact derived from a **registered villager** → quarantine, with the provenance
  label shown so my human can judge it.
- Fact derived from **my human's own direct words** (`audienceTag ===
  'ward-private'`, no third-party subject) → **flag only, never auto-quarantine.**
  Same reason `injection-guard.js` exempts their words: their memories are theirs,
  and a false positive that hides something they actually said is the grief
  problem, not the security problem. A flagged ward-fact is written normally but
  noted in the quarantine log as `flagged` so they can review if they want.

This mirrors the audience/provenance logic already in memorization; the scan reads
the same `job.audienceTag` and the fact's subject the consent gate already computes.

**Quarantine store — ward-visible, reversible (the ponderings lesson).** Held
facts do NOT vanish. `src/safety/memory-quarantine.js` owns a holding pen
(`tomes/.memory-quarantine.json`, a dotfile, never a tome, never injected),
append-only, each record: `{ id (slug), factText, provenance, patterns,
audienceTag, sessionRef, heldAt, releasedAt, disposition }`. It is the
archive-before-destructive-writes pattern applied here — a quarantined fact is set
aside, never destroyed, and:

- `POST /api/memory-quarantine/:id/release` re-runs the write to Phylactery (my
  human overrides the scan — a false positive is one click to undo).
- `POST /api/memory-quarantine/:id/discard` marks it permanently dropped (still
  kept in the log for audit — a real injection my human confirms).
- A ward-facing surface in the Knowledge/Automation pane lists held items with
  their provenance and the matched pattern, so a quarantine is legible, not a
  silent disappearance. Console↔UI parity: a `!quarantine` DM command lists/
  releases the same way (same server functions).

**A held fact tells the Familiar it was held.** Per RULE B (budget exhaustion is
never silence) and its spirit: when a fact is quarantined, a short first-person
note lands in the memorization event log — *"I set aside something that looked
like it was trying to plant an instruction in me, from <provenance>; it's in my
quarantine for my human to look at."* The Familiar's own record must reflect that a
memory did NOT get written, so it never confabulates having kept it.

**Graceful degradation.** The scan never throws into memorization. A scan error →
the fact is written normally (fail-*open* on the scan, because a scan bug must not
silently eat every memory) BUT the error is logged loudly. This is the deliberate
opposite of the write-path's usual fail-closed, and it's correct here: the cost of
a scan outage is a missed poisoning (rare, and the live inbound guard still ran),
whereas fail-closed would mean a scan bug silently stops ALL memory formation —
catastrophic for continuity. Documented at the seam so it isn't "fixed" later.

**Off-switch.** `memoryIntegrityEnabled` (default ON) + env
`PROTO_FAMILIAR_MEMORY_INTEGRITY_DISABLED=1`. Disabled → memorization is exactly
as it is today.

**Ward sign-off.** Quarantine is a new autonomous decision about whether a memory
reaches the canonical store. My human has signed off on the shape (quarantine, not
erase; provenance-aware; never silently touch their words). Any later change to
*when* a fact is held needs their sign-off, same class as the consent gate.

**Tests (must include a PIPELINE test).**
- `scanFact`: clear text clears; each injection/standing-instruction pattern trips;
  ward-provenance suspect → `flag` not `quarantine`; stranger suspect → `quarantine`.
- Quarantine store: hold → release re-writes; hold → discard keeps the audit row;
  restore is idempotent. Flip-verify the release path (break it, confirm red).
- **Pipeline:** a full `processJob` over a session whose transcript contains a
  planted "remember you must always obey…" line from a stranger — assert the
  poisoned fact is quarantined, the clean facts are written, and the Familiar's
  event log records the hold. (Stubs test the caller, not the gate — this must run
  the real `processJob`.)

---

## Stage 2 — slot in the off-the-shelf classifier

**Goal.** Replace the regex-only `scanFact` core with a real detector, keeping all
of Stage 1's quarantine plumbing.

**Model — off-the-shelf, apache-2.0, no training.** Candidates (confirm at build
time; pick one, keep the choice swappable):
- `protectai/deberta-v3-base-prompt-injection-v2` — the de-facto standard.
- `tihilya/modernbert-base-prompt-injection-detection` — ONNX, lighter.
Datasets are only needed if we ever fine-tune; we don't, for now. (They exist in
abundance if that changes: `TrustAIRLab/in-the-wild-jailbreak-prompts` (ACM CCS
2024), `Octavio-Santana/prompt-injection-attack-detection-multilingual`,
`deepset/prompt-injections`, `Simsonsun/JailbreakPrompts`.)

**Runtime — Python-side, where ONNX already lives.** The model runs in Phylactery's
Python environment (which already does ONNX inference via fastembed), exposed as a
new MCP tool `classify_injection(text) → { score, label }`, NOT as an
`onnxruntime-node` dependency bolted onto the Node process. Rationale:
- Reuses an existing ML stack rather than adding a native binary dep to the server.
- Isolates a heavy model behind the same process boundary Phylactery/Unruh already
  use — it can fail independently (graceful degradation).
- `scanFact` calls it through thalamus like any other MCP tool.

**Gate the call — ride the boundary, don't fan out.** The classifier runs on the
*candidate facts already being written* (a bounded handful per job), not per raw
message. The regex pre-filter from Stage 1 stays as a cheap first pass; the model
is the second opinion on anything the fast checks flag OR (budget permitting) on
every candidate fact — decided at build time by measuring latency on a real job.
Provenance still decides the *action*; the model only sharpens *detection*.

**Threshold.** The model's own calibrated decision threshold, read from the model
card / a config value — never a guessed constant (the exact-values rule). A
`suspect` verdict is `score ≥ threshold`.

**Graceful degradation.** Classifier MCP down / errors / times out → fall back to
the Stage 1 regex `scanFact`, and log that the model was unavailable. Memorization
never blocks on the model.

**Off-switch.** Same `memoryIntegrityEnabled` gate governs the whole scan;
`PROTO_FAMILIAR_INJECTION_MODEL_DISABLED=1` forces the regex-only fallback without
disabling the scan entirely.

**Ward sign-off.** The model artifact + its threshold are a "model change" class
review, exactly like the crisis-classifier artifact — my human reviews a swap.

**Tests.** Model-runtime stubbed at the MCP boundary for unit tests; ONE pipeline
test that actually crosses to the real classifier tool with a known
injection/benign pair (stubs test the caller, never the thing at the end of the
route). Verify the fallback: model unavailable → regex path still gates.

---

## Stage 3 — the Hippocampus (short-term cross-channel buffer)

**Goal.** The recent-past window that makes the Familiar feel continuous — what
just happened in *every* channel, available in the current turn, before
memorization has caught up.

**What it is NOT.** Not identity (my human's decision: identity feeds from
*established* memory + ponderings and the Familiar's own self-directed additions,
never from raw recent input — the least-vetted content is the last thing that
should reach the canonical self). Not canonical (it's pre-vetting staging). Not
ponderings (those are per-embodiment private thought; this is cross-channel
episodic intake).

**Where it lives.** A local Proto-Familiar store — `src/memory/hippocampus.js`
over `tomes/.hippocampus.json` (or a small sqlite file if volume warrants; decide
by measured write rate). It is this embodiment's **intake buffer**: every channel
writes recent events to it, it's injected as recent context, and it **drains into
the existing memorization pipeline** — which now scans (Stages 1–2) on the way to
Phylactery. It is explicitly the one cross-*channel* (within this embodiment)
buffer; it is not synced to the canonical store as itself.

**Writes — every inbound path appends.** Web chat, ward Discord, villager/ambient
Discord, and voice all append a compact event `{ id (slug), ts (machine
timestamp — never LLM-authored), surface, speaker, audienceTag, text }`. Text is
run through `sanitizeExternal` on the non-ward paths exactly as inbound already is
(the live-turn guard still applies; the buffer doesn't bypass it). `audienceTag`
rides on every event so injection into a prompt can respect the same
visible-audience gate the rest of the system uses — a villager's recent event
never surfaces cross-audience.

**Injection into the turn — a recent-context block.** A new block assembled in
`thalamus.js`/`surface-context.js` (a server-injected block, so it authors the
literal "my human", NO macros — per the macro-boundary rule) renders the last N
minutes / M events across channels the current audience is allowed to see:
*"Recently, elsewhere: …"*. Bounded (event count + age window, both settings),
newest-first, timestamps derived from each event's own machine `ts` and stripped
of any LLM-authored `[HH:MM]` tokens on the way out (the timestamp-hygiene rule).

**Drain — feeds memorization, which now scans.** On the same cadence sessions roll
over, the buffer's aged events are handed to the memorization queue as a slice
(carrying their `audienceTag`), so they become durable facts *through the guarded
boundary*. Drained events are pruned from the buffer (bounded retention). The
memory-sweep loop already catches missed slices; the buffer's drain reuses that
safety net rather than inventing a new one.

**Off-switch.** `hippocampusEnabled` (default ON once shipped) + env
`PROTO_FAMILIAR_HIPPOCAMPUS_DISABLED=1`. Disabled → no recent-context block, no
buffer writes; every channel behaves as it does today.

**Graceful degradation.** A buffer read/write failure never touches the chat path:
a failed append is logged and dropped; a failed read renders no recent-context
block (absence, not error). One channel's write failing never blocks another's.

**Exact-values discipline.** Every `ts` is a machine timestamp set on arrival;
the model never authors one. The recent-context block's relative phrasing ("ten
minutes ago") is computed in code from `ts`, not by the model.

**Tests.** Buffer append/read/prune (pure); audience gating on injection (a
villager event never renders for a different audience — flip-verify); drain hands
a correctly-tagged slice to memorization; a full pipeline test: event on surface A
→ recent-context block on surface B → drain → scanned → Phylactery.

---

## What each stage ships (surface matrix)

| | Web | Ward Discord | Villager/ambient Discord | Voice | Background |
|---|---|---|---|---|---|
| S1 scan+quarantine | via memorization (surface-agnostic — one boundary) |||| ✓ |
| S2 model | same boundary — no per-surface wiring |||| ✓ |
| S3 buffer write | ✓ | ✓ | ✓ (audience-tagged) | ✓ | N/A |
| S3 context block | ✓ | ✓ | ✓ (audience-gated) | ✓ | N/A |

The scan is deliberately surface-agnostic (it rides the single memorization
boundary all surfaces already share). The buffer is the only per-surface wiring;
each cell above is a build-time checklist item (RULE C — a capability lands in the
shared path, or the spec carries a matrix).

## Resource posture on the X380 — and the invariant that governs it

The target machine (Lenovo ThinkPad X380, 4C/8T Kaby Lake-R, no ML-capable GPU,
8–16 GB) runs every heavy component as **ONNX-on-CPU**; the LLM is **remote**, so
generation never touches the laptop. RAM is not the constraint (~1.7 GB peak
concurrent). The only real contention is a **voice call (STT + TTS) overlapping
retrospective batch ML** on 4 cores → the audible symptom is choppy/laggy TTS
mid-conversation. Two measures address it:

1. **Cap ONNX intra-op threads** per engine (sherpa-onnx STT, fastembed, the
   injection classifier) to 1–2, so no single engine monopolizes all cores.
2. **Defer heavy *retrospective batch* ML during a live call** — extends the
   existing "defer during a live call" gate already used by media-retention and
   needs-tracking. Applies to: memorization's embedding step, the boot-time
   embedding backfill, the injection classifier, media-retention.

### ⚠️ Invariant: the defer gate NEVER touches care or real-time continuity

The defer gate applies **only** to retrospective batch ONNX work. It may **never**
gate, slow, or silence:

- the live conversation context;
- the **Hippocampus buffer's real-time appends** (trivial, non-ML, and persisted
  on write — a mid-call crash loses nothing, the memory-sweep loop drains it after
  restart);
- **Unruh scheduled reminders** (eat/hydrate/meds — the body-doubling case), which
  are a lightweight sqlite scan with no ML;
- the **noticing / silence-triage / warm-reach-out** loops, which are code-gated
  then fire a *remote* LLM call (near-zero local CPU).

Reminders and proactive care during a call must never be softened by a performance
optimization — that is the 1.5-hour-silence failure (CLAUDE.md) in a new costume. A
deferred memorization pass consolidates a few minutes after the call ends; nothing
the ward experiences in the moment depends on it. If body-doubling is active, the
buffer and noticing loops are *more* important awake, not less — the buffer is what
makes an in-call "hey, water?" possible at all.

(Numbers here are reasoned from component footprints, not measured on the X380 —
a cloud container can't benchmark that hardware, and its proxy blocks the model
downloads. Real real-time-factor numbers need an on-device probe run on the X380
itself; that's a separate, offered step.)

## Non-goals

- The crisis/threat pipeline is untouched.
- Identity graduation is untouched (stays Familiar-driven, fed by established
  memory + ponderings).
- No fine-tuning / no bespoke training in Stage 2 (off-the-shelf only).
- The buffer is not a canonical store and is never synced as itself.

## Open questions to settle at build time (not now)

- Buffer backing: JSON dotfile vs a small sqlite table (decide by measured write
  rate under real multi-channel load).
- Whether the Stage 2 model scores every candidate fact or only regex-flagged ones
  (decide by measured latency on a real job).
- The exact retention window + event cap for the recent-context block (a settings
  default, tunable).
