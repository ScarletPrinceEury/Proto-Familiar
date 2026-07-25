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
2. **This measurement changed §14's acceptance bar.** The old flat "±20% of
   normal" would have been an ~8 ms window against a 39 ms baseline — a test
   that fails on shifts nobody could perceive, and one that gets *harder the
   faster the machine is*. §14 now uses an interference budget: the more
   generous of "stay under 250 ms" and "baseline + 20%, floor 25 ms". A fast
   machine is judged on staying imperceptible; a slow one on whether audio
   made it worse. Implemented as `interferenceBudgetMs` in `voice-bench.js`,
   with the X380's 39 ms as the worked example in its tests.

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

### Model sizes — download vs. disk (measured)

Every archive expands, and **not by a consistent factor.** This is why the pin
records both numbers instead of assuming a ratio.

| model | download | on disk | expansion |
|---|---|---|---|
| PocketTTS | 94 MB | **194 MB** | **2.07×** |
| English ASR (zipformer en-20M) | 122 MB | 130 MB | 1.07× |
| German ASR (zipformer de-kroko) | 55 MB | 68 MB | 1.24× |
| Silero VAD | 2.2 MB | 2.2 MB | 1.00× (not an archive) |

### Plan sizing — all six combinations, measured

| plan | download | on disk | free space needed while installing |
|---|---|---|---|
| read-aloud / pocket | 94 MB | **194 MB** | 288 MB |
| read-aloud / piper | 40 MB | ~40 MB | 40 MB |
| **listening / pocket** (default) | **218 MB** | **326 MB** | **542 MB** |
| listening / piper | 164 MB | ~172 MB | 294 MB |
| listening-plus / pocket | 268 MB | ~376 MB | 592 MB |
| listening-plus / piper | 214 MB | ~222 MB | 344 MB |

`~` still means an estimate: piper, GTCRN and the speaker model are unpinned.

**Every combination is inside its §0.7 ceilings.** ✅ Voice: 194 / 250 MB.
Capability: 132 / 150 MB — the tightest margin in the table, and it is the
English decoder that fills it.

### What these numbers correct

1. **"PocketTTS is cheaper than the English decoder" was wrong.** That held on
   *download* size (94 vs 122 MB) and reverses on disk (194 vs 130 MB) — the
   expressive voice is the single largest item in the default install after
   all. It is still comfortably inside its ceiling and remains the right
   default, but the argument for it is "it fits and it matters", not "it is
   cheap".

2. **Peak install requirement is 542 MB for the default plan** — two and a
   half times the download. This is the number the pre-flight actually refuses
   on, and it vindicates measuring peak rather than download: a ward with
   600 MB free would have been told 218 MB and then run out mid-install.

3. **A uniform expansion ratio would have been badly wrong.** 1.07× to 2.07×
   across four models. Guessing "about 1.3×" would have understated PocketTTS
   by 100 MB — larger than the entire German decoder.

4. **piper's fallback role is now quantified.** Choosing it saves 154 MB of
   disk and cuts the peak requirement by 248 MB. That is a real escape hatch
   for a genuinely full machine, and the §0.7 offer copy should name a figure
   this concrete rather than a vague "smaller".

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
