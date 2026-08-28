# Video media — build spec (a vision patch)

> **Status: INLINE CORE SHIPPED (0.11.33-alpha). File-API path = the next pass (§4).**
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

## 3. Known gaps (v1)

- **No video-describe.** `describeAsset` is image-only; a stood-in video carries
  no description (just the marker + the don't-invent guard). A frame-extract →
  describe path (needs ffmpeg) is future, and closed shadow DOM / frame reading
  ride the same "needs a media decoder" bucket.
- **No connection-editor `videoCapable` dropdown yet.** The tri-state exists on
  the connection object and is honored; wiring a UI control (mirroring the vision
  one) is a small follow-up. Until then `auto` (the heuristic) + env decide.
- **Discord video ingest** — DONE (0.11.34): `ingestDiscordImages` became
  `ingestDiscordMedia`, which also fetches video attachments RAW (no resizer for
  video) at arrival, size-capped to `VIDEO_MAX_BYTES`, under the same audience
  rule (ward always / villager yes / stranger never) and per-message + hourly
  caps as images. `isDiscordVideoAttachment` detects by mime or extension
  (octet-stream falls back to the ext). Over-cap clips are skipped by declared
  size before the download. Off-switch `PROTO_FAMILIAR_VIDEO_DISABLED=1` gates
  the video half.

## 4. Next pass — the File-API path (ward chose "inline now + File-API next")

Longer video can't ride inline; each provider has its own upload + reference
flow. This is a real, provider-specific build that CANNOT be verified from CI —
it needs the ward's live keys, same posture as the CDP desktop shakeout.

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
