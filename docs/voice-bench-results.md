# Voice benchmark results

Measurements from real ward hardware, gathered by the Pass 0 bench tool
(`docs/voice-build-spec.md` §0.5). **These supersede the `~` estimates in the
voice build spec.** Where a row still says "not measured", the spec's estimate
is still what we have.

Add a run by pasting the report's figures here — one section per machine.

---

## X380 — the reference machine

The machine §0.5 was written around. Run 2026-07-25, Proto-Familiar
0.9.37-alpha.

| | |
|---|---|
| CPU | Intel Core i5-8350U @ 1.70 GHz (8 logical, 1896 MHz reported) |
| Platform | win32 10.0.26200 (x64) |
| Memory | 15.84 GB total, **3.79 GB free at run start** |
| Node | v24.15.0 |

### Interference — the §4 headline

The one measurement the whole compute-governor design rests on: does a call
starve the rest of me?

| | median | 90th percentile | samples |
|---|---|---|---|
| Memory lookup, quiet machine | **39 ms** | **40 ms** | 12 |
| Under audio load | not measured (no engine yet) | | |

**The quiet baseline is now a fact, and it is a good one.** A real
`mem_search` through the live thalamus — Phylactery, sqlite-vec, fastembed —
completes in 39 ms on this hardware, and the 1 ms spread between median and
p90 says it is *consistent*, not merely fast on average.

Two things follow:

1. **§4.4's soft latency budget (~1200 ms) has enormous headroom** on this
   machine. Enrichment is nowhere near being the bottleneck; the earcon-bridged
   tier exists for the tail, and on this evidence the tail is short.
2. **§14's acceptance bar (±20%) is a ~8 ms window.** That is a tight target
   in absolute terms — audio load would have to be almost free to stay inside
   it. Worth deciding, before Pass 2, whether ±20% of a very fast baseline is
   the right test, or whether an absolute ceiling (say "stays under 100 ms")
   is the honest version of the same promise. A 39 → 60 ms shift would fail
   the percentage test while remaining invisible to my human.

### Disk footprint

| what | size | |
|---|---|---|
| Voice models (VAD + German ASR, blobs + unpacked) | 127 MB | re-fetchable |
| App dependencies (`node_modules`) | 33 MB | installer-managed |
| Memory service runtime (Phylactery venv, incl. embedder) | **173 MB** | installer-managed |
| Schedule service runtime (Unruh venv) | 55 MB | installer-managed |
| Memory, identity, graph | 4.1 MB | mine |
| Schedule and temporal state | 184 KB | mine |
| Tomes and runtime state | 137 KB | mine |
| Session logs and event records | 22 KB | mine |

**Total 393 MB — of which 389 MB is machine and 4.4 MB is mine.**

Two findings worth carrying into §0.7:

- **The Python runtimes are the largest single cost at 228 MB combined**,
  bigger than the entire default voice model plan. The footprint budget was
  written as if voice were the thing that made the install heavy. It is not;
  it roughly doubles an install that was already substantial. If disk is
  genuinely an access barrier, Phylactery's venv is where the next look
  belongs.
- **Everything that is actually *the Familiar* is 4.4 MB — about 1% of the
  install.** The Storage view's machine/self split isn't just a safety rail
  against deleting memories; it is the difference between reclaiming 389 MB
  and reclaiming nothing worth having. Worth saying plainly in that UI.

### Plan sizing (listening / pocket / en)

| | |
|---|---|
| Download | 218 MB |
| On disk once unpacked | ~218 MB (**estimated** — see gap below) |
| Free space needed during install | 434 MB |

Inside the §0.7 ceilings. ✅

**Gap:** the unpacked figure is a fallback, not a measurement. PocketTTS and
the English ASR have no `diskBytes` pin yet, so `planSize()` correctly falls
back to download size and flags the estimate. German measured at 1.24×, so the
real disk figure is likely nearer 270 MB. Close it with:

```
node scripts/pin-audio-models.mjs tts-pocket --measure
node scripts/pin-audio-models.mjs asr-streaming-en --measure
```

### Not yet measured

Everything needing the speech engine: WER (clean / noisy / enhanced), ASR
real-time factor at one and two streams, TTS time-to-first-chunk, speaker
embedding cost, enhancement cost, and the interference delta under load.
Blocked on the `sherpa-onnx-node` adapter and bench fixtures.

### Environment notes

- **3.79 GB free RAM at run start**, on a 15.84 GB machine. Not alarming, but
  it makes §2's lazy-load / idle-unload discipline (`voiceModelIdleMin`) load-
  bearing rather than tidy — a machine already using three quarters of its RAM
  should not hold decoders it is not using.
- Node v24 runs fine; `package.json` requires ≥22.
