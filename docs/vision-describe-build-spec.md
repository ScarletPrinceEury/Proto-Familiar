# Pictures that never got looked at — build spec (0.14.123)

Ward-approved 2026-11-06 (all five parts, `sharp` included).

## What went wrong

A Familiar on the z.ai coding plan sees pictures through z.ai's Vision MCP
(`zai-vision.js`): a turn on a blind connection waits up to 25 s per picture for
a description (`ensureDescribed`), then answers with whatever the picture's
note says. Three things failed in live use:

1. **Big pictures took too long.** Group-chat renders were 1.6–2.9 MB PNGs.
   Their descriptions landed 32–115 s after arrival, so every turn gave up at
   25 s and I said I couldn't see them. A 164 KB JPEG took 18 s and worked.
2. **WebP was never described.** The MCP takes only `.jpg`/`.jpeg`/`.png` up to
   5 MB (read from its installed `file-service.js`) and answers "Unsupported
   image format" to anything else. Nothing tried another describer, and the
   failure was logged to the console only.
3. **Every undescribed picture read the same.** "I haven't looked at this one
   yet" covered a picture still being looked at, one that failed, and one that
   could never be looked at.

A fourth gap showed up while checking: a picture from someone not in the
village is dropped at Discord ingest (correctly: their bytes are never kept),
but nothing tells me a picture was there.

Description also feeds image→threat scoring (§15.1 of the vision spec), so a
picture my human sends that never gets described is never scored.

## The parts

### 1. Each picture's note says what actually happened

`buildStandin` (media.js) gains two forms beside the existing ones:

| State | Note body |
|---|---|
| described | `what I saw when I looked: …` (unchanged) |
| a describe is running right now | `I'm still looking at this one` |
| every describer refused the file itself | `I couldn't get a look at this one — <plain reason>` |
| tried, didn't come through, will try again | `I tried to look at this one and it didn't come through` |
| never tried | `I haven't looked at this one yet` (unchanged) |

The convention and blind-picture lines in `materializeAttachments` name the new
markers. A failure is recorded on the asset (`meta.describeFailure`:
`{reason, permanent, setup, at, tried}`) and cleared when a description lands.
A permanent failure is not retried until the describe setup changes (a
different chain of describers, or the converter becoming available); a
transient one is retried the next time a turn needs it, as before.

Every describe attempt lands in `logs/vision-events.jsonl` (asset id,
connection label — never a key, ms, ok, reason, whether the copy was
converted), readable at `GET /api/vision-events` and in the Loops pane.

### 2. Every describer gets a small JPG/PNG (`describe-input.js`)

One seam, in `describeAsset`, before any describer is called: a JPG/PNG at or
under 1 MB goes as it is; anything else (WebP, GIF, a big PNG) becomes a JPEG at
the same 1568 long edge, quality 85, alpha flattened onto white. The stored
picture is never changed. The converter is `sharp`, loaded lazily; without it
the stored bytes go as they are (the behaviour before this pass) and a z.ai
describer refuses a non-JPG/PNG up front rather than making a doomed call.

### 3. A picture that lands late gets one more turn

When a turn's wait runs out on a picture (`ensureDescribed` returns it as
`pending`), the describe keeps going in the background. If it lands within
10 minutes, the room gets one more turn with the picture's note now carrying
what I saw. Once per picture. I can still stay quiet in that turn.

Surface matrix (RULE C):

| Surface | Late look |
|---|---|
| Discord guild room (registered location) | wired: queued as a revisit (`reason:'late-look'`, no re-defer), which a real turn in the room supersedes; revisits now materialize pictures |
| Discord ward DM / villager DM | not in this pass — revisits only run for registered rooms; the next turn sees the description, and the note says "still looking" meanwhile |
| Web chat | not in this pass — the web turn path has no turn without a human message; same fallback as DMs |
| Voice | N/A (no pictures) |
| Background loops | N/A (they don't wait on describes) |

The DM and web gaps are logged in `docs/known-issues.md` with the design they
need (a self-started turn kind on each path).

### 4. Another describer when one fails

`describeAsset` walks a chain instead of one connection: the resolved vision
connection first, then my human's fallback order (`connectionChain`), then any
other saved connection that can describe. Every failure moves on (a describe
is about one picture, so one provider's 400 says nothing about the next). Off
with `visionDescribeFallbacks: false` (Settings → vision, default on). Two
turns asking about the same picture share one describe (in-flight map).

### 5. A note for a stranger's picture

`ingestDiscordMedia` counts a non-villager's image/video attachments
(`notKept`) without fetching them, and both Discord call sites add
`[a picture from someone I don't know — the app doesn't keep those, so I can't see it]`
(plural forms for several). The bytes are still never fetched or stored.
Privacy-class; ward-approved.

## Tests

- `describe-input`: a real WebP becomes a JPEG; a small PNG goes as it is; no
  converter → as it is; `zaiRefusal`.
- `describeAsset`: a refused first describer falls back to the next and the
  description lands; two concurrent describes make one call; a permanent
  failure is recorded and not retried with the same setup; a success clears it.
- stand-in forms; the late-look watcher (lands → one queue, late → none, once
  per picture); the stranger note.
- Pipeline: a turn's messages through `ensureDescribed` + `materializeAttachments`
  with a stubbed provider fetch, for a WebP asset on a z.ai-first chain.
