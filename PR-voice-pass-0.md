# Voice Pass 0 — supply chain, footprint budget, bench tool

Pass 0 of the voice milestone (`docs/voice-build-spec.md` §13). This is the
**measuring** pass: it ships no speech. It ships the machinery that decides
what a ward's machine can actually run, what it costs them, and a report they
can send back.

Four commits. Nothing here touches the chat path.

- `8510019` — supply chain, footprint budget, bench measuring core
- `bf40184` — the ward-facing surface: endpoint, Diagnostics button, CLI
- `38b90b7` — first real bench results from the X380
- `47920f3` — measured unpacked sizes; all six plans now measured

**It has been run on the reference machine.** The Diagnostics button, the
endpoint, the polling and the interference probe all work on Windows against
a live Phylactery. Results in `docs/voice-bench-results.md`.

---

## Why this pass exists

The voice spec is built on `~` estimates. Pass 0's deliverable is the *report*
that replaces them with measurements from real hardware — and, per §0.7, the
budget those measurements are checked against.

## What's in it

| module | owns |
|---|---|
| `voice-models.js` | Manifest + tier composition + the §0.7 ceilings |
| `voice-footprint.js` | Disk measurement + the free-space pre-flight |
| `voice-fetch.js` | Pre-flight → refuse-unpinned → hash → verify → install |
| `voice-extract.js` | Verify-then-unpack, traversal defences, atomic install |
| `voice-catalogue.js` | Which voice clips may ship, and on what terms |
| `voice-bench.js` | WER, RTF, TTS latency, the §4 interference phase |
| `voice-bench-run.js` | Start/poll/cancel for a run that takes minutes |

Plus `scripts/pin-audio-models.mjs` (writes pins),
`scripts/ensure-audio-models.mjs` (fetcher CLI),
`scripts/voice-bench.mjs` (bench CLI), the
`/api/diagnostics/voice-bench` + `/api/voice/plan` + `/api/voice/footprint`
endpoints, and a **Voice benchmark** button under Diagnostics.

New dependencies: `tar` and `unbzip2-stream` (both small, pure JS) — upstream
ships every model as `.tar.bz2` and Node has no bzip2.

## Spec changes

- **§0.7 — the footprint budget.** Disk named as an accessibility constraint
  rather than housekeeping. Capability tier and voice engine are **independent
  axes**: collapsing them into one ladder would have handed the ward with the
  smallest disk the Familiar that sounds least like themselves. PocketTTS is
  the default at every tier including read-aloud; piper is a *fallback*,
  offered with what it costs named, never silently assigned.
- **§0.8 — how this ships.** Binding from npm (one platform binary per ward),
  models fetched with pins, fixtures vendored so WER is comparable.
- **§6.5 — ward-supplied voices.** Allowed, as personal use.
- **§2 — rewritten.** The old justification for the audio worker's isolation
  argued only about `server.js`'s event loop, which says nothing about the
  fastembed co-location question it appeared to settle. Now three numbered
  reasons that answer different questions, and it says outright that an
  earlier draft got this wrong.

## Measured, replacing estimates

| | spec estimate | download | on disk | expansion |
|---|---|---|---|---|
| PocketTTS | ~200 MB | 94 MB | **194 MB** | **2.07×** |
| English ASR | ~80 MB | 122 MB | 130 MB | 1.07× |
| German ASR | ~80 MB | 55 MB | 68 MB | 1.24× |
| Silero VAD | ~2 MB | 2.2 MB | 2.2 MB | — |

Default plan (listening / pocket / en): **218 MB download, 326 MB on disk,
542 MB of free space needed during install.** All six tier × engine
combinations are inside their §0.7 ceilings; capability is tightest at
132 / 150 MB, filled by the English decoder.

Expansion ranges 1.07× to 2.07×, which is why the pin records both numbers
instead of deriving one from the other — a uniform ratio would have
understated PocketTTS by ~100 MB, more than the entire German decoder.

**Interference baseline (the §4 headline):** a real `mem_search` through the
live thalamus is **39 ms median, 40 ms p90** over 12 samples on the X380.
§4.4's 1200 ms soft budget has enormous headroom. But that makes §14's ±20%
acceptance bar an ~8 ms window — see "Open questions" below.

## Decisions worth reviewing

1. **Licensing is enforced in code, not remembered.** `shippableSources()`
   gates on the licence field, so a non-commercial source (Expresso, EARS)
   cannot reach the shipped set of a GPL distribution. Rejected sources stay
   listed *with their reasons*, so nobody rediscovers them in six months and
   re-litigates. The NOTICE text is generated from the catalogue.

2. **Ward-supplied clips: two orthogonal questions.** `mayLeaveTheMachine()`
   fails closed — a clip you supplied never rides out in a diagnostic, bench
   report or shared surface. `belongsInIdentityBackup()` is true for *every*
   voice, because a restored Familiar that comes back sounding like a stranger
   is a continuity break. Backup includes precisely what sharing excludes;
   there's a test asserting they diverge.

3. **Three language states, not two.** Not-in-table (unsupported, reported),
   in-table-unpinned (curated, not offered), in-table-pinned (offered).
   `availableAsrLangs()` returns only the third, so a menu cannot offer a
   language that can't be fetched. English is the default; nothing else is
   fetched unless asked for.

4. **Download, disk, and peak are three different numbers.** Ceilings check
   **disk**; the pre-flight checks **peak** — during install an archive and
   its unpacked copy both exist. Measured: **542 MB peak against a 218 MB
   download**, two and a half times. A ward with 600 MB free would have been
   quoted 218 MB and then run out mid-install, on precisely the machines the
   budget exists to protect. The report names all three.

5. **Cancelling a benchmark writes nothing.** A half-measured report that
   looks whole is worse than no report. Conversely the report is saved to
   `logs/` *before* the run flips to done, so closing the window never loses a
   run someone waited minutes for.

6. **Stage labels are plain language.** A test fails if `RTF`, `ASR`, `TTS` or
   `onnx` appear in them — a ward reads these while waiting.

## Two bugs found by running it, not by testing it

- **Archive kind was read from the blob path.** Blobs are content-addressed,
  so `blobs/9e/9e27b78…` has no extension — every archive looked like a plain
  file. No pure-function test could have caught this; the naming only diverges
  once the content-addressed store is involved.
- **The pre-flight sized the download, not the peak.** It would have started
  fetches that couldn't finish, on precisely the nearly-full machines the
  budget exists to protect.

Both are the argument for the pipeline-test discipline in CLAUDE.md's 0.9
post-mortem, paid again.

## Testing

125 tests across seven files. Real `.tar.bz2` fixtures built at test time (not
mocks), a live local HTTP origin for the fetcher's streaming and hashing path,
a path-traversal attack asserted to write nothing outside the destination, and
pipeline tests through the real run manager.

Exercised end-to-end against real upstream artifacts: the German model
downloads, verifies, unpacks to `encoder/decoder/joiner/tokens`, and inspects
as installed. The CLI produces a complete report.

## Not in this PR

- The `sherpa-onnx-node` engine adapter (needs a machine with an audio stack)
- Bench fixtures (en + de) and their licensing
- Almanac gardening — the harness was unauthenticated in the build
  environment; a local session should fold this in

Until the adapter and fixtures exist, audio measurements report themselves
`skipped` with a reason. Machine facts, disk footprint and the quiet-machine
interference baseline all work today.

## Open questions for review

- **§14's ±20% interference bar may be the wrong test.** Against a 39 ms
  baseline it is an ~8 ms window; a 39 → 60 ms shift would fail while being
  invisible to my human. An absolute ceiling ("stays under 100 ms") is
  probably the honest version of the same promise. Worth settling before
  Pass 2 builds against it.
- **The Python runtimes are the biggest thing on disk** — 173 MB Phylactery +
  55 MB Unruh, larger than the whole default voice plan. §0.7 was written as
  though voice were what makes an install heavy. It isn't. If disk is
  genuinely an access barrier, that is where the next look belongs.
- **Everything that is actually the Familiar is 4.4 MB**, ~1% of a 393 MB
  install. Worth saying plainly in the Storage view when it is built.
- **piper's fallback now has a number**: saves 154 MB of disk, cuts peak by
  248 MB. §0.7 says the offer must name what it costs — it should quote that
  rather than say "smaller".

## Known gaps

- **PocketTTS may be English-only.** Upstream ships and documents it as
  English; `lang` is `'en'` rather than `'multi'` until measured otherwise. If
  it is English-only, "expressive voice at every tier" quietly stops being
  true for a German-speaking ward — worth resolving before Pass 1 wires the
  voice menu.
- French, Korean and Chinese are curated but unpinned, and correctly not
  offered.
