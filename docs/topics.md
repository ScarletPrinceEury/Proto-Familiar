# Topics

## Overview

Topics let you tag a named slice of a conversation and track it with a coloured bar in the message gutter. When a topic ends, an LLM-generated summary can be saved directly to the Lorebook as a new entry with auto-suggested keywords.

Topics are stored per-session in `localStorage` under the key `pf_topics_<sessionId>`.

---

## Starting a Topic

Click the **+ Topic** button in the input bar. A dialog prompts for an optional name (leave blank to auto-generate one). From that point forward, all new messages are grouped under the topic.

Multiple topics can run in parallel. Each active topic shows a pulsing dot at the bottom of its gutter bar to indicate it is still open.

### Retroactive Start

Click the **▷** start button on any past message to begin a topic from that point in history rather than the present. This is useful for labelling a conversation slice after the fact.

---

## Ending a Topic

Hover over any message and click the **⬛** end button. If more than one open topic includes that message, a picker appears so you can choose which topic to close.

---

## Topic Auto-Summary

When a topic ends, an LLM call is made to summarize the messages within that topic's bounds. A review dialog opens with:

- **Title** — editable; defaults to the topic name or a generated title
- **Body** — the generated summary; fully editable before saving
- **Keywords** — 3–8 suggested trigger words; editable

Clicking **Save to Lorebook** creates a new [Lorebook](lorebook.md) entry with:
- The title as the entry comment
- The summary body as the entry content
- The chosen keywords as primary keys
- Injection position `before_char` (default)

The summary dialog can be dismissed without saving if the summary is not useful.

---

## Parallel Topics

Multiple topics can be open simultaneously. Their coloured bars appear side-by-side in the message gutter. Each topic tracks its own start message and end message independently.

---

## Topic Data Structure

Each topic object stored in `localStorage`:

```json
{
  "id":       "uuid",
  "name":     "My Topic",
  "color":    "#a8d8a8",
  "startIdx": 3,
  "endIdx":   12
}
```

| Field | Description |
|---|---|
| `id` | UUID |
| `name` | Display name |
| `color` | Hex colour for the gutter bar |
| `startIdx` | Index of the first message in `state.messages` |
| `endIdx` | Index of the last message, or `null` if the topic is still open |
