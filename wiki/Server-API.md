# Server API

The server is implemented in `server.js` (Express, Node.js 18+, ESM).

## Base behavior

- Serves static frontend from `public/`
- Proxies chat requests to provider endpoints
- Persists session logs to `logs/`
- Validates session IDs with a strict UUID pattern before file access

## Endpoints

### `POST /api/chat`

Proxy request to selected provider.

**Body (main fields):**

- `provider` (`nanogpt | zai | zai-coding`)
- `apiKey`
- `model`
- `messages`
- `stream` (boolean)
- optional: `temperature`, `max_tokens`, `tools`, `tool_choice`

Returns:

- SSE stream when `stream: true`
- JSON response when `stream: false`

### `POST /api/log`

Create/overwrite a session log.

**Body (main fields):**

- `sessionId`
- `startedAt`
- `endedAt` (nullable)
- `provider`
- `model`
- `messages` (array)

### `GET /api/logs`

Returns metadata list for all saved sessions (newest first).

### `GET /api/logs/:id`

Returns full JSON for one saved session.

### `DELETE /api/logs/:id`

Deletes one saved session log.

### `GET /api/health`

Returns `{ "ok": true }`.
