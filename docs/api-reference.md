# API Reference

All endpoints are served by the Express server at `http://localhost:3000` (or your configured port). The server is a local proxy — it is not intended to be exposed to the public internet without additional authentication.

---

## Chat

### `POST /api/chat`

Proxies a chat completion request to the selected LLM provider. Supports both streaming (SSE) and non-streaming modes.

**Request body:**

```json
{
  "provider":    "nanogpt | zai | zai-coding",
  "apiKey":      "sk-...",
  "model":       "gpt-4o-mini",
  "messages":    [{ "role": "user", "content": "Hello" }],
  "stream":      true,
  "temperature": 0.8,
  "max_tokens":  2048,
  "tools":       [...],
  "tool_choice": "auto"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | string | Yes | One of `"nanogpt"`, `"zai"`, `"zai-coding"` |
| `apiKey` | string | Yes | Your API key for the chosen provider |
| `model` | string | Yes | Model name (e.g. `"gpt-4o-mini"`, `"glm-4.7"`) |
| `messages` | array | Yes | OpenAI-compatible messages array |
| `stream` | boolean | No | `true` for SSE streaming, `false` (default) for full response |
| `temperature` | number | No | Sampling temperature |
| `max_tokens` | number | No | Maximum response tokens |
| `tools` | array | No | OpenAI function-calling tool definitions |
| `tool_choice` | string/object | No | Tool choice directive (e.g. `"auto"`) |

**Enrichment:** Before forwarding, the server calls `thalamus.js:enrich()` to prepend entity-core identity, memory, and knowledge-graph context to the system message. If entity-core is unavailable, the request proceeds without enrichment.

**Streaming response (`stream: true`):**

Returns `Content-Type: text/event-stream`. Events follow the OpenAI SSE format:

```
data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}

data: [DONE]
```

**Non-streaming response (`stream: false`):**

Returns the provider's JSON response verbatim with the provider's original HTTP status code.

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Unknown provider, missing/invalid API key, missing/invalid model, empty messages array |
| `502` | Network error reaching the upstream provider |

---

### `POST /api/debug-prompt`

Returns the full enriched message array that would be sent to the LLM for a given conversation payload — including the entity-core context block — **without** making any upstream API call. Used by the prompt inspector UI.

**Request body:**

```json
{ "messages": [...] }
```

**Response:**

```json
{ "messages": [...] }
```

The same messages array with entity-core enrichment prepended to the system message (or inserted as a new system message if none was present).

**Error responses:**

| Status | Condition |
|---|---|
| `400` | `messages` is missing or not a non-empty array |

---

## Session Logs

### `POST /api/log`

Creates or overwrites the log file for a session. Called automatically by the frontend after every message (fire-and-forget).

**Request body:**

```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "startedAt": "2026-05-11T14:30:00.000Z",
  "endedAt":   "2026-05-11T17:12:00.000Z",
  "provider":  "nanogpt",
  "model":     "gpt-4o-mini",
  "messages":  [
    { "role": "user",      "content": "Hello", "timestamp": "2026-05-11T14:30:05.000Z" },
    { "role": "assistant", "content": "Hi!",   "timestamp": "2026-05-11T14:30:07.000Z" }
  ]
}
```

`endedAt` may be `null` while the session is still active.

**Response:** `{ "ok": true }`

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Invalid session ID (must be a UUID) or `messages` is not an array |
| `500` | File system write failure |

---

### `GET /api/logs`

Returns metadata for all sessions, sorted newest-first. Message bodies are **not** included.

**Response:**

```json
[
  {
    "sessionId":    "550e8400-e29b-41d4-a716-446655440000",
    "startedAt":    "2026-05-11T14:30:00.000Z",
    "endedAt":      "2026-05-11T17:12:00.000Z",
    "updatedAt":    "2026-05-11T17:12:05.000Z",
    "provider":     "nanogpt",
    "model":        "gpt-4o-mini",
    "messageCount": 12
  }
]
```

---

### `GET /api/logs/:id`

Returns the full session JSON for the given UUID, including all messages.

**Response:** The raw session JSON object (see `POST /api/log` body shape above).

---

### `DELETE /api/logs/:id`

Deletes the session log file for the given UUID.

**Response:** `{ "ok": true }`

---

## Tomes

Tomes are stored as individual JSON files in the `tomes/` directory. Each Tome is independently addressable and can be enabled or disabled. The activation engine aggregates entries from all enabled Tomes.

### `GET /api/tomes`

Returns a metadata list of all Tomes (no entry bodies).

**Response:**

```json
[
  {
    "id":          "550e8400-e29b-41d4-a716-446655440000",
    "name":        "World Lore",
    "description": "Geographical and cultural facts.",
    "enabled":     true,
    "entryCount":  14
  }
]
```

---

### `POST /api/tomes`

Creates a new Tome.

**Request body:**

```json
{
  "name":        "Character Notes",
  "description": "Optional description.",
  "enabled":     true
}
```

`name` is required. `description` and `enabled` are optional (defaults: `""`, `true`).

**Response:** The full new Tome object including its generated `id` and empty `entries: {}`.

**Error responses:**

| Status | Condition |
|---|---|
| `400` | `name` is missing or blank |

---

### `GET /api/tomes/:id`

Returns the full Tome including all entries.

**Response:**

```json
{
  "id":      "550e8400-e29b-41d4-a716-446655440000",
  "name":    "World Lore",
  "enabled": true,
  "entries": {
    "<uid>": { ... entry object ... }
  }
}
```

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Invalid Tome ID format |
| `404` | Tome not found |

---

### `PUT /api/tomes/:id`

Replaces the `entries` map of an existing Tome. Optionally updates metadata fields in the same call.

**Request body:**

```json
{
  "entries": { "<uid>": { ... } },
  "name":    "Optional new name",
  "enabled": true
}
```

Only `entries` is required. Any additional top-level fields (`name`, `description`, `enabled`) are merged into the stored Tome metadata.

**Response:** `{ "ok": true }`

---

### `PATCH /api/tomes/:id`

Updates Tome metadata only (does not touch entries).

**Request body:**

```json
{
  "name":        "New name",
  "description": "Updated description.",
  "enabled":     false
}
```

All fields are optional; only provided fields are updated.

**Response:** The updated Tome metadata (without entries).

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Invalid Tome ID format |
| `404` | Tome not found |

---

### `DELETE /api/tomes/:id`

Deletes the Tome file permanently.

**Response:** `{ "ok": true }`

---

### `DELETE /api/tomes/:id/entries/:uid`

Removes a single entry from a Tome by UID and rewrites the Tome file.

**Response:** `{ "ok": true }`

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Invalid Tome ID or entry UID format |
| `404` | Tome or entry not found |

---

## Health

### `GET /api/health`

Returns `{ "ok": true }`. Useful for uptime checks or confirming the server is running.
