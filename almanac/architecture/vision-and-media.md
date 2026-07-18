---
title: Vision and Media Input
topics: [architecture, vision]
sources:
  - id: media-js
    type: file
    path: media.js
  - id: vision-js
    type: file
    path: vision.js
  - id: slug-ids-js
    type: file
    path: slug-ids.js
  - id: server-js
    type: file
    path: server.js
---

# Vision and Media Input

Proto-Familiar 0.9.0 introduces multimodal image input, letting the ward send images to the Familiar alongside messages. The vision system is built in layers: a content-addressed media store (`media.js`), a materialization seam (`vision.js`) that converts stored attachments into provider-consumable image data at chat time, and graceful degradation when modality is not available.

The load-bearing constraint is that `message.content` stays a plain string forever. Media rides beside it as an optional `attachments` field, so every existing string-assuming consumer keeps working untouched. The reference seam where attachments become LLM-visible content is exactly one code path: `materializeAttachments()` in `vision.js` [@vision-js].

## Media storage

`media.js` maintains a content-addressed store at `media/<sha>.<ext>` on disk, keyed by file hash [@media-js]. Every asset gets a `.json` sidecar recording metadata (MIME type, dimensions if image, timestamp), and the folder maintains a `.slugs.json` index mapping friendly names to hashes for user-facing references [@media-js].

**Deduplication**: `saveAsset()` hashes incoming bytes and stores only once per unique content — two uploads of the identical file produce one asset on disk [@media-js].

**Image dimensions**: The system reads JPEG SOF markers, PNG IHDR chunks, GIF screen descriptors, and WebP VP8/VP8L/VP8X headers in pure JavaScript without native libraries — no external imagemagick or GraphicsMagick dependency [@media-js]. This means dimension lookup is fast and side-effect-free [@media-js].

**Capabilities**: `MEDIA_MAX_BYTES` caps uploads at 6 MB and `IMAGE_MIME_EXT` whitelists recognized formats; both limits are enforced at save time [@media-js]. The module is designed to never throw: validation is early and loud, and callers can rely on the API [@media-js].

**Friendly names**: When an asset arrives with a camera-original name like `IMG_1234.jpg`, `PXL_9876.jpg`, `DSC_5432.jpg`, or `Screenshot_timestamp`, `slug-ids.js` normalizes the label to a generic fallback (`img-xxxxxx`) to avoid cluttering the UI with uninformative names [@slug-ids-js]. `meaningSlugId()` preserves any name that does not match the camera-noise patterns [@slug-ids-js].

## Materialization: attachments to vision data

`materializeAttachments(apiMessages, {connection, settings, visibleAudiences})` converts stored attachments to LLM-visible image data at chat time, handling audience gating and modality fallback [@vision-js].

**Audience gating**: The function checks which audiences have vision access before materializing any attachment. If an attachment is private to an audience not listed in `visibleAudiences`, it contributes nothing to the turn — not even a text stand-in — fail-closed [@vision-js].

**Modality limit**: At most 4 images per turn are materialized into live `image_url` data-URL parts, newest-first. Older attachments in the same turn degrade to text stand-ins (see below) [@vision-js].

**Stand-in text**: When an image cannot be sent (modality off, over the limit, audience gated), `buildStandin()` and `contentWithStandins()` render a human-readable trace like `[image: sunset.jpg]` inline in the string content [@vision-js].

**Capability probe and caching**: The system optimistically assumes 'auto' connections can see images on the first live turn, then caches the actual capability in `tomes/.vision-capability.json` keyed by `provider:model` [@vision-js]. If a turn fails with a modality error (4xx response), it falls back mid-turn: the request is retried with stand-ins in place and the capability is cached as 'no' [@vision-js]. This "real turn is the probe" approach avoids adding an extra LLM call upfront — the acceptance criterion was zero additional LLM calls beyond the turn itself [@vision-js].

**Implementation in chat loops**: Both non-streaming and streaming chat paths in `server.js` wire the mid-turn fallback [@server-js]. The non-streaming loop wraps `runToolCallLoop` with a retry; the streaming loop re-runs the round with `round--` on the pre-header `!upstream.ok` branch when modality errors occur [@server-js].

**Field stripping**: After materialization, the internal `attachments` field is stripped from every outgoing message so strict LLM providers never see the unknown field [@vision-js].

**Modality detection**: `isModalityError()` classifies a 4xx response as a modality rejection so the fallback logic can distinguish it from other errors [@vision-js].

## Messages with attachments

Messages on the wire carry both `content: string` and an optional `attachments: [{id, kind, mime}]` field [@vision-js]. This shape is preserved through session logs and memorization: the string stays a string, and attachment metadata travels beside it.

Every existing consumer of `message.content` — timestamp stamp/strip in `message-sanitize`, the `INPUT_CHAR_CAP` enforcement, memorization filters that check `typeof m.content === 'string'` — keeps working unchanged because they never meet the attachments field [@vision-js].

## Graceful degradation

Vision is designed to degrade gracefully at every point: if the media store is unavailable, if an image cannot be read, if the connection lacks vision capability, or if the feature is disabled [@vision-js].

`PROTO_FAMILIAR_VISION_DISABLED=1` disables the whole subsystem; there is also an in-app setting (defaulting ON, inert until an image is sent) [@vision-js]. Critically, no image path may 500 the chat turn — the system always fails to stand-in text or drops the image silently [@vision-js].

## Planned future work

**Pass 2** (not yet shipped): Image description caching — `describeAsset()` looks at each image once and keeps the description forever, so the Familiar can refer to images by description without re-calling the model. This pass also gates descriptions by audience and adds image→threat scoring to `crisis-signals.js`, wires image inspection into the `view_image` tool, and adds injection guards on stored descriptions [@vision-js].

**Pass 3** (not yet shipped): Discord image ingest — when a villager sends an image via Discord, the system fetches the image from `proxy_url`, resizes it to cap, applies audience/provenance stamping, records an observe-path ref, and materializes it in `callChatRaw()` [@vision-js].

## Related

- [Message format and attachments](../decisions/message-attachments-format) — the design decision to keep `message.content` as a plain string and ride media beside it
- [Graceful degradation](../reference/engineering-conventions) — the repo-wide principle this subsystem follows
- [Crisis signals](../architecture/safety-spine) — how threat scoring will eventually consume image descriptions in Pass 2
