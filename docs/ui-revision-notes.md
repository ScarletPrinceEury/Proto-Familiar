# UI revision notes

Confusing UI choices noticed while using the web UI, kept for a later
revision pass. Each note says what's confusing and, where obvious, a direction.
Measure fixes against `docs/ui-ux-guidelines.md`.

---

### Starting a new session is hidden behind "✕ Clear history"

The only way to start a fresh chat session is the **✕ Clear history** button.
Its label and confirm text ("Clear all chat history? The current session log
will be kept.") say "delete" and "kept" in the same breath. What it actually
does is the opposite of clearing: it saves the session, memorizes it, writes a
handoff, and opens a new session. Someone who just wants a fresh conversation
won't look for "clear", and someone afraid of losing history won't press it.
Direction: a plain **New session** action that says what happens ("This
conversation is saved and remembered; you can reopen it from Saved sessions").

It's also buried: it sits in Settings → **Chat**, next to notification
sounds and voice options. Session handling is split across two places, the
Chat settings ("Saved sessions…", "Clear history") and the Knowledge editor's
**Sessions** tab (export, memorize-now), so there's no single place for "my
conversations".

### "what's this?" links float away from their controls

In Settings → Chat, the "• what's this?" toggles sit on their own line between
controls, and some lines carry two of them side by side ("what's this? •
what's this?"). Reading down the pane, it isn't clear which control each one
explains. Direction: put the ⓘ toggle on the same row as the label it belongs
to (the `enhanceHints` pattern), one per control.

### The mood grid takes over the chat when it's left open (low priority)

Normally the mood check-in is a small button. In one browser it came up already
expanded, as a full grid filling about a third of the chat at desktop width and
nearly all of it in a small window (around 800×450). Worth checking whether the
expanded state is remembered across reloads. Direction: cap its height, or
collapse it to a single row of chips when space is short.

### A long turn shows nothing but typing dots

When a turn runs several tool rounds, or a provider call is slow, the chat
shows the same typing dots for minutes, with no sign of whether the Familiar is
working, waiting on the provider, or stuck. In one case it was seven minutes.
Direction: show what's happening and for how long ("checking memories… 2:10",
"waiting on the model… 1:45"), and a Stop button once it passes a minute or so.

### Escape doesn't close the Connections dialog

Pressing Escape leaves "Connections & models" open; only the × closes it.
Keyboard users expect Escape to close a dialog (and the WCAG line in
CLAUDE.md is ours to hold). Worth checking every modal for the same.

### Reasoning effort sits on each saved connection, not where you'd look first

To change how hard the primary connection thinks, you open Connections &
models, scroll past the active-connection fields (which have no reasoning
setting) to the saved-connection cards, and find the "Reasoning effort" select
on the card marked PRIMARY. Direction: show it in the active-connection block,
since that's what people read as "the current setup".

### "Topics" look like separate conversations, but they aren't sessions

The **Topic** control above the composer reads like a way to open a new
thread. It isn't a session boundary, so starting a topic doesn't give a clean
conversation. Direction: say what a topic is where it's offered, and keep
"new conversation" separate (see above).

### The identity budget lives in the Temporal editor

**Identity budget (tokens)** sits in Temporal editor → Automation tab, under
"Memory summary timeout". Nothing about identity size is temporal, so there's
no path to find it. Direction: put it near identity/knowledge settings (or the
Knowledge editor's identity view), with the current per-message identity size
shown next to it so the number means something.
