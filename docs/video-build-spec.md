# Video media — build spec (a vision patch)

> **Status: INLINE CORE (0.11.33) + Gemini File-API path (0.11.35) SHIPPED.**
> The File-API path (§4) is built, ISOLATED (its own module + endpoint, never the
> chat handler), default-OFF, and fully unit-tested against a stubbed Google — the
> LIVE round-trip needs the ward's key + a real Gemini connection (a desktop
> shakeout, same as CDP). Other providers stay inline-only.
> Video rides the exact rails the vision milestone built (`docs/vision-build-spec.md`):
> `message.content` stays a string, video rides beside it as an `attachments`
> sibling, and `materializeAttachments` is the ONE seam that turns a reference
> into a provider content-part. "A video-capable model is a change here, not a
> message-format migration" — the vision spec said so; this is that change.

## 1. What shipped (inline core)

- **Store (`media.js`).** A `video` kind: `VIDEO_MIME_EXT` (mp4/webm/mov/mkv/mpeg/
  3gp), `VIDEO_MAX_BYTES` = 20 MB (the inline ceiling — base64 of a bigger clip
  blows the provider request cap), folded into `MEDIA_KINDS` + `maxBytesForKind`.
  Content-addressed, deduped, audience-tagged, slugged (`vid-…`) like every asset.
  `buildStandin` gains a video voice ("what I saw when I watched" / "I haven't
  watched this one yet" / "I have no way to watch videos right now").
- **Materializer (`vision.js`).** `resolveVideoCapable` (a TIGHT name heuristic —
  Gemini, Qwen-VL, explicit `video` models — plus the ward's `videoCapable`
  tri-state; much narrower than vision because a wrong live attempt ships
  megabytes) + a newest-first `DEFAULT_MAX_LIVE_VIDEOS`=1 budget. A live video
  becomes a `{type:'video_url', video_url:{url:data:…}}` part; otherwise a text
  stand-in, with the same blind-confabulation guard images get and a video
  legibility line. Off-switch `PROTO_FAMILIAR_VIDEO_DISABLED=1`.
- **Ingress.** `POST /api/media` accepts `video/*`; the web composer attaches
  video (raw upload — no canvas downscale — under the 20 MB cap), renders a
  `<video>` thumbnail chip. The materialize seam already runs on every chat turn,
  so a video attachment flows to the model with no per-surface wiring.
- **Graceful degradation is absolute** (the vision inheritance): a provider that
  can't take the `video_url` part triggers the existing modality-reject fallback
  → the clip stands in as text, never a 500. So on a provider that DOESN'T accept
  video, the feature degrades honestly instead of breaking.

## 2. The wire-format reality (why "capable" is tight + fallback-guarded)

Everything goes through the **OpenAI chat-completions shape** (`providers.js` —
even Google, via its `…/openai/chat/completions` compat endpoint). There is no
universal `video_url` content part: some OpenAI-compat providers (Qwen/DashScope)
accept it; Google's compat layer does NOT (native Gemini uses `inline_data` /
`file_data`, a different endpoint). So the inline core is honest but
provider-dependent: it WORKS where `video_url` is accepted, and DEGRADES cleanly
elsewhere. The tight `videoCapable` heuristic + the ward's per-connection
`'yes'`/`'no'` are how a ward pins a provider they've confirmed.

**This inline path is NOT Gemini-only** — it's the OpenAI-compat `video_url`
part, so any chat-completions provider that accepts it works: **Zhipu GLM-V /
GLM 5.3 Flash**, Qwen-VL, and video models proxied through **NanoGPT** all ride
it (the File-API path in §4 is the Gemini-specific extra, only for clips too big
to inline). The Auto heuristic recognises the families we know by name; for a
NanoGPT model (or any provider whose model name doesn't encode modality) the ward
flips the connection's "Can watch video?" to **Yes** and the inline part is sent.

**GLM video contract — verified against docs (0.11.37).** Checked z.ai's API
reference (`docs.z.ai/api-reference/llm/chat-completion`) AND the MetaGLM cookbook
(`glm-cookbook/vision/glm-v_for_video_understanding.ipynb`): GLM's video part is
`{type:'video_url', video_url:{url:<base64>}}` — the SAME `type`/field the
materializer emits, and base64 IS accepted (z.ai's video size limit is 200 MB,
well above our 20 MB inline cap). **One residual to confirm on a live GLM
shakeout:** the cookbook passes *raw* base64, while the materializer sends a
`data:video/mp4;base64,…` **data-URL** (the form z.ai's docs explicitly accept for
IMAGES on the same OpenAI-compat gateway, so its video parallel almost certainly
normalizes it too — but this is the one untested detail, and the likeliest suspect
if a GLM video turn returns empty). Because GLM allows 200 MB but our inline cap is
20 MB, a 20–200 MB GLM clip is not reachable yet (the "Watch full clip" File-API
path is Gemini-only) — a documented follow-up, not a bug.

## 3. Known gaps (v1)

- **No video-describe.** `describeAsset` is image-only; a stood-in video carries
  no description (just the marker + the don't-invent guard). A frame-extract →
  describe path (needs ffmpeg) is future, and closed shadow DOM / frame reading
  ride the same "needs a media decoder" bucket.
- **Connection-editor `videoCapable` dropdown — DONE (0.11.36).** A "Can watch
  video?" tri-state (Auto/Yes/No) sits under the vision one in the Connections
  editor, stored on the connection (already synced). This is the robust answer to
  "which models take video" — `looksVideoCapable`'s Auto only says yes for the
  families we actually know (Gemini, Qwen-VL, **GLM-V / GLM 5.3 Flash**, explicit
  `-video`), and NanoGPT proxies a model space too large for any heuristic, so the
  ward pins any video-capable connection they've confirmed with `Yes`.
- **Discord video ingest** — DONE (0.11.34): `ingestDiscordImages` became
  `ingestDiscordMedia`, which also fetches video attachments RAW (no resizer for
  video) at arrival, size-capped to `VIDEO_MAX_BYTES`, under the same audience
  rule (ward always / villager yes / stranger never) and per-message + hourly
  caps as images. `isDiscordVideoAttachment` detects by mime or extension
  (octet-stream falls back to the ext). Over-cap clips are skipped by declared
  size before the download. Off-switch `PROTO_FAMILIAR_VIDEO_DISABLED=1` gates
  the video half.

## 4. The File-API path — SHIPPED for Gemini (0.11.35)

Longer video can't ride inline; each provider has its own upload + reference
flow. This CANNOT be verified from CI — it needs the ward's live key, same
posture as the CDP desktop shakeout. What shipped:

- **`gemini-file-api.js`** (new, ISOLATED, every fn takes an injectable `fetchFn`):
  `uploadVideoToGemini` (resumable upload START → upload+finalize → poll
  `files.get` until `ACTIVE`), `toGeminiRequest` (OpenAI-ish history →
  Gemini `contents`, system→`system_instruction`, assistant→`model`, the
  `file_data` part on the final user turn), `generateWithGeminiFile` (native
  `models/<m>:generateContent`), `answerAboutVideo` (the orchestrator). Every
  failure returns `{ok:false}` — the caller falls back, nothing throws.
- **Seam:** a DEDICATED endpoint `POST /api/video-understand {assetId,prompt,
  provider,model,apiKey}` — NOT the `/api/chat` handler (zero blast radius on the
  streaming/tool loop). Default-OFF (`videoFileApiEnabled`), ward-only (web),
  gated by `PROTO_FAMILIAR_VIDEO_DISABLED`. Validates a Gemini connection.
- **Store split:** `VIDEO_MAX_BYTES` (20 MB) is inline-eligibility only;
  `VIDEO_STORE_MAX_BYTES` (300 MB) is what the store accepts, so a long clip can
  be held for upload. The materializer only inlines clips ≤ the inline cap; a
  bigger one stands in and is handled by the File-API endpoint.
- **Client:** the composer accepts up to the store cap when the flag is on; a
  too-big-to-inline pending video shows a **🎬 Watch full clip** button that
  posts to the endpoint (composer text = the prompt) and drops the answer into
  the chat as a turn. A non-Gemini primary is refused with a clear line.

**Still open (next):** Discord long-video (the endpoint is web-only); tool-using
/ streaming answers over a long clip (this path is one non-streaming answer);
other-provider uploaders behind the same seam; a describe/thumbnail for a stood-in
long clip. And the **live shakeout** — I could not exercise the real Google API.

- **The seam:** in `materializeAttachments`, a video over `VIDEO_MAX_BYTES` (or a
  ward "prefer upload" flag) routes to an **uploader** instead of inlining, which
  returns a provider file reference; the content part becomes that reference
  (`file_data`/`fileUri`) rather than a data URL.
- **Google (first target):** the File API lives on the **native** Gemini endpoint
  (`…/upload/v1beta/files` → `files/…` URI, referenced via `file_data`), NOT the
  OpenAI-compat endpoint the repo currently uses. So this pass must add a native
  request path for a Gemini video turn — a deliberate provider-shape divergence,
  designed, not rushed. Upload lifecycle: upload → poll `ACTIVE` → reference →
  (files auto-expire ~48h; cache the URI on the asset meta with its expiry).
- **Other providers:** each gets its own uploader adapter behind the same seam
  (the reader-router "primary + fallback" discipline), or is left inline-only and
  says so.
- **Off-switch + budget carry over.** Uploads are ward-gated (bytes leave the
  machine to the provider — same disclosure class as any outbound media), and a
  failed upload degrades to the inline/stand-in path.

## 5. Out of scope

- Video generation/editing; frame-accurate seeking; streaming/live video.
- Any provider integration shipped unverified — an uploader lands with the ward's
  live confirmation, not blind.
