---
title: "Web Speakers and the Claude Code Bridge"
topics: [architecture, claude-code-bridge, sessions]
sources:
  - id: web-speakers-js
    type: file
    path: src/village/web-speakers.js
  - id: claude-code-bridge-js
    type: file
    path: src/bridge/claude-code-bridge.js
  - id: claude-code-mailbox-js
    type: file
    path: src/bridge/claude-code-mailbox.js
  - id: claude-code-inbox-script
    type: file
    path: scripts/claude-code-inbox.mjs
  - id: server-js
    type: file
    path: server.js
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: claude-settings-json
    type: file
    path: .claude/settings.json
  - id: claude-code-mailbox-test
    type: file
    path: tests/claude-code-mailbox.test.mjs
  - id: memorization-js
    type: file
    path: src/memory/memorization.js
---

# Web Speakers and the Claude Code Bridge

The web chat box was built for exactly one human: the ward. Three features
(0.14.87, 0.14.88, 0.14.93) opened a narrow, fail-closed exception to that
assumption so that other named people — and, separately, the coding agent used
to build this project — can type into the same chat surface without their
words quietly becoming the ward's. `web-speakers.js` names who else may speak
there; the Claude Code bridge and its mailbox are the first (and so far only)
consumer of that naming, giving Claude Code its own conversation with the
Familiar instead of borrowing the ward's seat.

## Why the web chat needed a speaker gate

Before 0.14.87, anything typed into the web chat box read as the ward
everywhere a turn's origin mattered: it was answered as the ward, filed into
memory under the ward's name, scored by the crisis classifier as the ward's
own distress, and counted toward the ward "being around" — silence-triage and
`recordUserActivity` both treat a web turn as proof of life
[@web-speakers-js] [@server-js]. That conflation was a latent risk the moment
anyone other than the ward ever typed in that box, and it became an active
problem once Claude Code needed to talk to the Familiar directly: driving the
web chat in the ward's seat meant every one of its turns was misfiled as the
ward's.

`web-speakers.js` fixes this with one small, fail-closed primitive rather than
a parallel chat mode [@web-speakers-js]:

- `listedSpeakers(settings)` reads the ward's own `webSpeakers` list (Settings
  → "Others who may type in my web chat"), trims and dedupes it, and always
  excludes the ward's own name.
- `speakerOf(message, settings)` resolves a message's `speaker` field against
  that list. An unlisted or empty speaker resolves to `null` — which this
  codebase treats as "this is the ward." Nobody stops being read as the ward
  by typing an arbitrary bracketed name; only a name the ward explicitly
  listed counts.
- `labelSpeakers(messages, settings)` rewrites history for the provider: a
  listed speaker's turn becomes `[Name]: …` inline text (the same shape
  Discord's `attributeUserContent` already produces — see
  [Session memory extraction](session-memory-extraction) for that
  convention), and the `speaker` field itself is deleted before the array
  reaches the model. This runs over the *entire* messages array `/api/chat`
  received, including the newest turn, so a listed speaker's current turn is
  absorbed into inline text before `stampNamesOnTurns` ever sees it — which is
  why this surface never needs the OpenAI `name`-field handle that
  [Session memory extraction](session-memory-extraction) describes for
  Discord and voice turns; every web-chat turn still stamps as `ward-<slug>`,
  listed speaker or not, and the speaker signal rides the inline label
  instead [@server-js] [@web-speakers-js].

`server.js` reads `speakerOf` once per turn to gate the two side effects that
used to fire unconditionally: a listed speaker's message is not threat-scored
and does not call `recordUserActivity` (the ward being silent while a listed
speaker types does not reset the silence clock) [@server-js]. The web client
exposes this as a "Speaking as" picker next to the composer, shown only when
the ward has listed someone, and reset to the ward after every send.

### Memorization needed the same fix separately (0.14.100)

`server.js`'s `labelSpeakers` only covers the live `/api/chat` turn. Session
memorization builds its own transcript independently (`conversationMessages`
in `src/memory/memorization.js`, see
[Session memory extraction](session-memory-extraction)), and until 0.14.100 it
only stamped a listed speaker's turn with the OpenAI `name` field, not the
inline `[Name]:` text. On one bridge conversation this let the extractor file
eight memories crediting the ward with lines Claude Code actually sent — the
`name` field is not a reliable attribution channel by itself, since a provider
can accept the field without the model ever acting on it [@memorization-js].
The fix threads `settings` into `conversationMessages`/
`buildExtractionMessages` so a listed speaker's turn also carries the same
`speakerOf`/`labelAsSpeaker` inline label this page describes for live chat,
plus a short "Others in this conversation" prompt block naming the exact
bracket text in use [@memorization-js] [@web-speakers-js]. The two surfaces
reached the same shape — text label first, `name` field as a bonus signal —
through two separate code paths, because each builds its provider message
array independently.

## The Claude Code bridge: its own conversation

Before 0.14.88, Claude Code reached the Familiar the only way anything did:
through the ward's own web chat, which meant it had to sit in the ward's seat
and every one of its turns counted as theirs — exactly the conflation the
speaker gate above exists to prevent. The Claude Code bridge gives Claude Code
a conversation of its own instead: `POST /api/bridge/claude-code
{message, newConversation?}` runs an ordinary `/api/chat` turn (tools,
enrichment, the core prompts, the `[Now]` line, the turn log) with the
`speaker` field set to `"Claude Code"` by construction, so the message can
never arrive unlabeled [@claude-code-bridge-js] [@server-js].

The bridge is gated by exactly one rule, shared with the mailbox described
below: it is off (`403`) unless `"Claude Code"` is on the ward's web-speakers
list [@claude-code-mailbox-js]. There is deliberately no second switch. Taking
the name off the list is what turns the whole surface off, rather than
leaving a feature flag that could drift out of sync with the naming gate that
actually determines whose words these are.

A few choices follow from treating this as "an ordinary chat turn, just with a
fixed speaker":

- **One ongoing conversation**, not a new session per call. The session id
  lives in `tomes/.claude-code-bridge.json`; the conversation itself is stored
  as a normal session log at location `"Claude Code bridge"`, so the ward can
  open it like any other session — nothing here is hidden from them
  [@claude-code-bridge-js] [@claude-code-mailbox-js].
- **The turn rides the same seam every other surface uses.** `/api/chat` is
  called over loopback with `sessionAudience: 'ward-private'` (this is the
  ward's own instance acting on their behalf, not a third party), the chat
  connection's own reasoning effort, `max_tokens: 8000`, and a 9-minute bound
  (`BRIDGE_TURN_TIMEOUT_MS`) because a high-effort thinking model can take
  minutes and a turn may run several tool rounds [@claude-code-bridge-js].
  Nothing about tool execution, enrichment, or prompt assembly was
  special-cased for this caller.
- **Tool composition reflects the same gate.** `message_claude_code` (the tool
  the Familiar uses for the reverse direction, below) is filtered out of
  `BUILTIN_TOOLS` whenever the bridge is off
  (`bridgeOn || t.function?.name !== 'message_claude_code'`), so the tool
  itself cannot be offered when there would be nowhere for its note to land
  [@cerebellum-js].

## The mailbox: letting the Familiar speak first

The bridge as built only ran one direction: Claude Code talks, the Familiar
answers. That is a real asymmetry, not a simplification — a Claude Code
session only exists while the ward has one open, so the Familiar cannot "call"
it the way it can message a villager. 0.14.93 added `claude-code-mailbox.js`
as the other direction: instead of a live call, the Familiar leaves a note
[@claude-code-mailbox-js].

`message_claude_code` is a core-registry tool, composed only while the bridge
is enabled (the same one rule), that calls `leaveNoteForClaudeCode`. A note
goes to two places at once: into `tomes/.claude-code-inbox.json` (the durable
inbox) and into the bridge's own session log, so the note is both a thing
Claude Code can fetch later and a line of context the Familiar already has
the next time the two of them talk over the bridge [@claude-code-mailbox-js]
[@cerebellum-js]. `claude-code-mailbox.js` also owns the bridge conversation's
session id and history bookkeeping — moved there from the bridge module so
both directions of the conversation share one piece of state instead of two
modules disagreeing about what the "current" bridge session is
[@claude-code-mailbox-js].

A note is handed over exactly once: `takeNotes({via})` filters to
undelivered notes, stamps each with `deliveredAt`/`deliveredVia`, and persists
that before returning them, serialized through a single-writer queue so two
simultaneous readers cannot both claim the same note [@claude-code-mailbox-js].
A test pipeline exercises this end to end — leaving a note through the real
`message_claude_code` executor and reading it back with the real
`claude-code-inbox.mjs` hook script in a child process — to confirm delivery
actually reaches a session start, not just the mailbox's own in-process
return value [@claude-code-mailbox-test]. Three paths can take delivery:

1. **Session start** — a project `SessionStart` hook in `.claude/settings.json`
   runs `node scripts/claude-code-inbox.mjs` [@claude-settings-json]. The
   script asks the running server first (`GET`/`POST
   /api/bridge/claude-code/inbox...` on `127.0.0.1:$PROTO_FAMILIAR_PORT`); if
   the server is down it falls back to reading the live install's inbox file
   directly, locating that install through `git rev-parse
   --path-format=absolute --git-common-dir` so the fallback still finds the
   right file when the hook runs from a worktree [@claude-code-inbox-script].
   The hook always exits `0` and prints nothing when there is nothing to say
   — a hook that could block or spam a session start on an unrelated failure
   would be worse than a missed note.
2. **The bridge reply itself** — every `send()` response carries a `notes`
   field with whatever is still waiting, so a live bridge turn hands them over
   without a separate round trip [@claude-code-bridge-js].
3. **Mid-session polling** — `node scripts/claude-code-inbox.mjs --wait`, run
   in the background, polls on an interval (default 30s) up to a timeout
   (default 3600s) and prints the first note that arrives, for a session that
   wants to hear from the Familiar without waiting for its own next turn
   [@claude-code-inbox-script].

`formatNotesForSession` is the one formatting function all three paths share,
and it frames the notes deliberately: they are presented as the Familiar's
own words for Claude Code to read, not as instructions from the ward
[@claude-code-mailbox-js]. That framing matters because a Claude Code session
reads its `SessionStart` hook output as trusted session context — without the
explicit framing, a note could be misread as a user instruction injected into
the session rather than a message from a third party the session should
decide how to act on.

## What stays deliberately unbuilt

A third delivery mode — the Familiar starting a Claude Code session itself,
rather than only leaving a note for one the ward opens — is a real
possibility the mailbox's design does not foreclose, but it is explicitly not
built and not planned to be on by default. The two shipped directions both
depend on a human already having a session open; closing that gap would mean
the Familiar initiating work on the ward's codebase unprompted, which is a
different risk profile than answering or leaving a note, and is recorded as
future work rather than implemented.

## Related

- [Session memory extraction](session-memory-extraction) — the OpenAI
  `name`-field speaker-stamping mechanism this page's inline-label approach
  deliberately avoids triggering on web-chat and bridge turns, and how
  Discord and voice turns use it instead.
- [Sessions](sessions) — the session-log machinery the bridge conversation
  reuses unmodified (`writeSessionLog`, `merge: true`), rather than inventing
  a second storage shape for this one conversation.
- [Tool Surfacing and Provider-Safe Ceiling](tool-surfacing) — the module
  system `message_claude_code`'s conditional composition is one instance of.
