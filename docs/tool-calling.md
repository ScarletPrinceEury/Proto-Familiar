# Tool Calling

## Overview

Tool calling lets the LLM invoke client-side functions and receive their results before producing a final response. Proto-Familiar implements the OpenAI function-calling protocol and runs the execution loop entirely in the browser.

---

## Enabling / Disabling

The **Enable tool use** checkbox in the sidebar **Tools** section controls whether the `tools` array is included in each API request. When unchecked, no tools are advertised to the model and it behaves as a plain chat completion.

---

## Built-in Tools

Two tools are always available when tool use is enabled:

| Tool | Description | Returns |
|---|---|---|
| `get_datetime` | Current local date, time, and timezone | Human-readable locale string (e.g. `"Tuesday, May 13, 2026 at 02:30:00 PM CEST"`) |
| `get_session_info` | Metadata about the current session | JSON with `startedAt`, `messageCount`, `provider`, `model`, `elapsedMsSinceLastMessage` |

Both tools require no arguments.

---

## Custom Tools

Paste a JSON array of [OpenAI function-calling](https://platform.openai.com/docs/guides/function-calling) tool definitions into the **Custom tools** field in the sidebar:

```json
[
  {
    "type": "function",
    "function": {
      "name": "my_tool",
      "description": "Does something useful.",
      "parameters": {
        "type": "object",
        "properties": {
          "input": { "type": "string", "description": "The input value." }
        },
        "required": ["input"]
      }
    }
  }
]
```

Custom tools are advertised to the LLM like built-in tools. When the model calls one, the execution returns a message explaining the tool has no client-side implementation.

To wire real logic, add entries to `BUILTIN_EXECUTORS` in `public/app.js`:

```js
const BUILTIN_EXECUTORS = {
  // ... existing built-ins ...
  my_tool: ({ input }) => `Result for: ${input}`,
};
```

The executor function receives the parsed arguments object and must return a string (or a value that will be stringified).

---

## The Execution Loop

```
POST /api/chat  (with tools array)
        │
        ▼
Provider responds with finish_reason: "tool_calls"?
   │
   ├── YES
   │     │
   │     ▼
   │   For each tool call in the response:
   │     ├── Execute client-side (BUILTIN_EXECUTORS or "no implementation" message)
   │     └── Render collapsible call/result block in chat
   │     │
   │     ▼
   │   Append assistant message (with tool_calls) + tool result messages
   │     │
   │     ▼
   │   Re-send to provider (round += 1)
   │     │
   │     └── Repeat up to MAX_TOOL_ROUNDS (5) times
   │
   └── NO (normal text response, or 5 rounds exhausted)
         │
         ▼
       Render assistant message → save to history
```

After 5 rounds without a `stop` finish reason, the last assistant reply is used as-is.

---

## Chat Rendering

Tool-call rounds are displayed as compact, collapsible blocks in the chat showing:
- Tool name
- Arguments (formatted JSON)
- Result

These blocks are included in session logs but **stripped from Markdown exports**.

---

## Request Shape

When tool use is enabled, the request to `/api/chat` includes:

```json
{
  "tools": [ ...BUILTIN_TOOLS, ...customTools ],
  "tool_choice": "auto"
}
```

Both fields are forwarded verbatim to the upstream provider.
