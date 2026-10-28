# Fix plans for the open known issues

These plans cover the open entries in `docs/known-issues.md`. Each plan went
through the same loop:

1. Evaluate the problem, with evidence from the code and the logs.
2. Draft a fix.
3. Check what the fix touches and how it changes it. Look for ways it could
   break the architecture, break immersion, or make Familiar harder to use.
4. Adjust the plan for what the check found. Changes to other parts of the
   system get the same check.

Steps 3 and 4 repeat until the plan holds up. Each section shows its passes,
because several findings changed the plan. Sometimes the cause turned out to be
somewhere other than where the issue entry put it.

**Status:** B (the turn record) is built in 0.14.106. Item 7, dropped calls,
stays a watch item: there's still no evidence of it. The rest is not built
yet. Plans marked **ward sign-off** touch a path CLAUDE.md reserves for the
ward.

| # | Cluster | Known-issue entries | Sign-off |
|---|---------|---------------------|----------|
| B | A turn's record survives whatever happens to the turn | web loses the human's message; web retries a turn whose tools ran; tool calls dropped on other finish reasons; the time anchor read as an empty message | no (shared turn machinery) |
| C | Privacy of what leaves a private room | the relayed legal name; web memorization always "my human's own room" | **ward review** (C1); **ward sign-off** (C2) |
| A | The Familiar can check its own work | can't read identity files mid-turn; duplicate headings; quiet "ok" results; recall cut mid-word; no tome edit/delete; rules outlive their cause; confabulation | no |
| D | Intentions fire and get followed through | intentions not reliable; intention architecture too weak | **ward sign-off** (noticing) |

Suggested order: B, C1, A, D1, C2. B comes first because pass 1 found a bug
that affects every Discord turn that uses tools (see B.1).

Two entries need no plan. "Older tome notes count as general:sensitive" is
working as designed. "The Familiar can't start a Claude Code session" is a
planned feature, not a defect.

---

## B. A turn's record survives whatever happens to the turn

### B.1 The problem, as the evidence shows it

The entries describe two web symptoms: a lost human message, and a retry that
re-runs tools. Reading the code and the turn log (`logs/turn-tools.jsonl`)
showed one gap underneath both, and it covers every surface: **a tool round is
recorded only if the turn finishes.**

- **Web** (`public/app.js` `doStreamingRequest`). The human's message, the tool
  rounds and the reply are all pushed into `state.messages` together, at commit.
  A turn that never commits loses all three. On the server, if the browser goes
  away, the stream loop returns right after executing a round's tools
  (`server.js`, `if (clientGone()) return;`). The tools ran, and nothing ever
  records them.
- **Voice** (`src/voice/voice-call-server.js`). The voice server stores only
  `turnMessages(transcript, reply)`. The `_toolRounds` that `/api/chat` returns
  are thrown away, even on a turn that finishes. The turn log has a voice turn
  where the caller left after three `relay_message` calls had gone out. No
  record of those sends survives in the session.
- **Claude Code bridge** (`src/bridge/claude-code-bridge.js`). It does store
  rounds, through its own copy of the message shape (`bridgeTurnMessages`),
  but only after the reply arrives. A failed bridge turn loses them too.
- **Discord** (`src/discord/discord-gateway.js`). `deliverReply` appends only
  the reply. A Discord turn's tool rounds are never stored, finished or not.
  This is the bigger bug:
  - `collapseToolTurns(…, { records: true })` has nothing to build "[App
    record of that turn …]" from.
  - The "[Last turn …]" anchor line never appears on Discord. It's built from
    `session.messages` plus a placeholder for the current message, but the
    current message was already saved into `session.messages` before the
    model call. So it finds no previous turn and returns nothing.
    *(The first draft of this plan said the line reported "no tools used".
    Building the fix showed it is missing entirely.)*

  The 0.14.76 fix for confabulation (plain records of what actually ran) has
  never worked on Discord, and most turns in the log are Discord turns. A
  deadline-abandoned Discord turn after `save_memory` and three
  acknowledgements is in the log too; its tool record is lost the same way.

Retry evidence: since 0.14.74 started logging client attempts, no retry has
happened. The damage the entry describes (an identity section appended to two
files) came from before that. The retry policy is still unsafe, and it fires
whenever the connection drops after tools ran.

Dropped calls: the two rounds logged `dropped: true` are both at round 20 —
the round cap working as designed. No call has been dropped because the finish
reason was something other than `'tool_calls'`.

Time anchor: `replyFromReasoning` hasn't recurred since it started being logged.

### B.2 Plan, first draft

The server journals each turn into the session log as it goes, using
`writeSessionLog(…, { merge: true })`, which already unions messages by id:

1. The human's message is written before the model call.
2. Each tool round is written as soon as its results are back.
3. The reply is written when it lands.
4. If the turn ends after tools ran and no reply was written, an app note is
   written instead.

On the web, the client keeps writing too. A retry after tools ran is refused
by the server.

### B.3 Pass 1: what it touches, and what could break

- **Two writers, one turn.** Web, voice and the bridge all write their own
  session logs. If the server journals the same turn, union-by-id only stays
  clean if both writers use the **same ids**. Today the client gives tool-round
  messages fresh ids (`generateId()` in `attemptStreamingOnce`). That would
  produce two copies of every round.
- **Order.** `mergeMessages` splices extras in by timestamp. Voice stamps the
  user message and the reply with the same end-of-turn time
  (`turnMessages(…, { at })`). Journaled rounds have earlier times, so they
  would land *before* the user message. `lastTurnRecord` would then credit the
  tools to the previous turn.
- **The poller.** `pollSessionDelta` holds off only while the typing
  indicator shows, and the indicator hides as soon as the reply starts
  streaming. Mid-turn, the poller would fetch the server's journaled rounds,
  push them into `state.messages` and re-render. At commit, the client would
  push its own copies. That's a double render, and a double entry, because
  `push` doesn't dedupe.
- **Utility calls.** Not every `/api/chat` call is a turn: the handoff
  summary, guide chat and others aren't. Journaling them would put fake turns
  in the conversation.
- **No session id without tools.** The client sends `sessionInfo` only when
  tools are enabled (`toolLoopPayload`), so a tools-off chat would never
  journal.
- **Privacy of stored rounds.** Discord rooms would now store tool results.
  Records carry up to 60 characters of a result (`resultLabel`). In a shared
  room, a later turn would re-read part of a result the Familiar never said
  aloud, and the room's audience may have changed since. That would be a new
  way content reaches a room.
- **What the app note says.** It's text the Familiar reads, so CLAUDE.md
  recorded error #6 applies: plain facts, the app owns app problems, no
  verdict.

### B.4 Adjustments after pass 1

- **One shared builder.** A new module, `src/sessions/turn-record.js`, mints
  every id and builds every message for a turn:
  - `userTurnMessage`, `toolRoundMessages`, `replyMessage` and `cutOffNote`.
  - Each message carries the turn's `turnId`, so a turn's messages are findable
    in any log, even after a restart.
  - `createTurnRecorder({ write })`. Each surface supplies its own `write`, so
    there is one writer per session per surface, never two writers racing.
- **An explicit turn envelope.** A caller opts in by sending
  `turn: { sessionId, turnId, userMessageId, userTimestamp, replyMessageId }`.
  - The web client generates all of these at send time and always sends the
    envelope, tools or not.
  - The server builds the tool-round messages, ids included, and sends the
    stored objects themselves in `_toolRound.messages`. The client stores them
    verbatim and keeps no builder of its own, so the shape lives only in
    `turn-record.js`.
  - Every party then shares every id, so the union never duplicates. Ordering
    uses the client's real user timestamp.
  - Utility calls send no envelope, so they never journal.
- **The server's record is canonical for `/api/chat` callers.** The
  non-streaming response returns `_turnRecord`, the messages the server wrote.
  Voice and the bridge push exactly those instead of building `turnMessages`.
  That fixes both the voice ordering and the voice "rounds thrown away" bug.
  After a failed turn, voice re-reads the log tail so its in-memory history
  includes what the server recorded.
- **Discord is its own single writer.**
  - `runToolCallLoop` gets an awaited `onToolRound(round)` hook. It runs after
    the results come back and before the next round.
  - Discord's recorder appends to `session.messages` and calls its existing
    merge writer, the same pattern it already uses for persisting the human's
    message first.
  - `deliverReply` appends the reply as today.
  - The deadline, abandoned-turn and error paths after a round call
    `recorder.cutOff()`.
- **The poller.** It skips while an explicit `_turnInFlight` flag is set
  (cleared in `sendMessage`'s `finally`). The commit pushes only ids it doesn't
  already have.
- **Records in shared rooms name the calls only.**
  `collapseToolTurns(messages, { records: true, recordResults })`:
  - `recordResults` is true only for ward-private history.
  - Shared rooms get "I called recall (ok), relay_message (failed)" with no
    returned text.
  - The same applies to web sessions with others present (`sessionAudience`).
    Nothing new reaches a room.
- **The app note, plainly.**
  - Stored as `{ role: 'system', kind: 'app-note', id: 'cutoff:<turnId>' }`.
  - The text: "[App note: that turn ended before my reply reached my human.
    The tools above had already run.]"
  - It's neutral by design: the server can't tell a closed tab from a dropped
    connection, and it doesn't need to.
  - The deterministic id means a note the server and the client both write
    merges into one.

### B.5 Pass 2: checking the adjustments

- **A retry when no tools ran** (empty reply, failure before any round) stays
  safe and keeps working as today. The server knows whether tools ran; the
  client only knows what reached it. So the retry check lives on the server:
  - A request whose `turnId` already has journaled rounds is answered with
    `_turnAlreadyRan: { messages }` instead of running again.
  - A fallback connection gets the same answer.
  - The client then reconciles and shows the app note and the "Go on" offer.
- **The human sends a second message mid-turn.** `sendMessage` aborts the
  in-flight request. Today that drops the first message entirely; now it
  stays. The aborted turn's rounds are journaled, but the new turn's history,
  built from `state.messages`, doesn't have them yet. So the server unions in
  journaled turn messages from the session log's tail when they're missing from
  the incoming history.
  - Only messages carrying a `turnId` are unioned, and only from the last 50
    messages.
  - A plain message the human deleted in the UI can never come back this way.
- **A partial reply** the human already read is recorded as an assistant
  message with `cutOff: true`, followed by the note. The Familiar's history
  then shows what it actually said, cut where it stopped.
- **The web UI.**
  - The human's message appears and stays, even if the turn fails.
  - An app note renders as a muted one-line divider. It has no copy or speak
    buttons, and memorize and export skip it the way they skip tool plumbing.
  - The "Go on" offer reuses the round-cap pattern (`offerContinueRounds`). It
    sends a visible, honest user message as a fresh turn.
  - An unanswered message with no tools behind it gets a "Try again" button.
    It re-sends with the **same** envelope, so the server dedupes the message
    and refuses if tools ran after all.
  - Automatic retry after tools ran is gone, which costs one click in a rare
    case. That's the right trade: the old behaviour repeated memory writes and
    identity edits.
- **Reload.** `loadPersisted` reads localStorage, which now has the human's
  message from the moment it was sent. If the last message is unanswered, one
  fetch of the log tail picks up whatever the server recorded. The poller
  converges anyway, because it dedupes by id.
- **The ward's unified session.** Discord DM turns now carry tool rounds, so
  the web view shows tool blocks for things the Familiar did on Discord. That's
  a visible change, and it's in line with "no hidden conversations".
- **Memorization.** Memorization and the deliberation readers already skip
  `role: 'tool'` and carriers. They also need to skip `kind: 'app-note'`. That
  is a one-line filter, and it gets a test.
- **Session size.** Discord logs will grow by their tool results, as web logs
  already do. Record it as a watch item rather than capping now: a cap would
  have to be applied identically on the web, which keeps the full results.
- **Threat scoring and the safety paths** are untouched: scoring order doesn't
  change, and the human's message now persists earlier, which only helps the
  readers.

### B.6 Final plan

1. **`src/sessions/turn-record.js`** (new), with the pieces from B.4 and pure
   tests.
2. **`/api/chat`**, in both the stream and non-stream loops:
   - accept the envelope;
   - persist the user message before the model call;
   - journal each round **before** the `clientGone()` check;
   - write the reply on success;
   - `try/finally`: write the cut-off record and note if the turn began, tools
     ran and no reply was written;
   - answer a repeat request whose turn already ran tools with `_turnAlreadyRan`;
   - union journaled turn messages from the log tail into the incoming history;
   - send the stored messages in `_toolRound.messages` and `_turnRecord`.
3. **The web client**, as in B.4 and B.5:
   - persist-first;
   - the envelope;
   - store the server's round messages verbatim;
   - no retry or fallback after tools ran;
   - the in-flight flag for the poller;
   - reconcile on failure and on load;
   - the app-note renderer;
   - "Go on" and "Try again".
4. **Voice and the bridge** send the envelope, adopt `_turnRecord`, and re-read
   the tail after a failure. `bridgeTurnMessages` goes away. The web client,
   the bridge and the new module each built the same message shape; after
   this, only `turn-record.js` does (CLAUDE.md, "no copy-paste of substantial
   logic").
5. **Discord**:
   - the `onToolRound` hook in `runToolCallLoop`;
   - a recorder in `handleTurn`;
   - `cutOff` on the deadline, abandoned-turn and error paths.

   This fixes the false "no tools used" line.
6. **`collapseToolTurns`** gets the `recordResults` option, set per room at
   every live boundary.
7. **Dropped calls.** No change to the `'tool_calls'` gate, because there's no
   evidence and running partial arguments is a real risk. *(Built as: no
   change. The draft also stored such calls as not-run, so the next turn would
   say "my reply asked for X but it didn't run". Building it showed a stored
   round counts as "tools ran", which would block a safe retry of a turn where
   nothing ran. It stays a watch item with the evidence in known-issues.md.)*
8. **Known issues.** Close the time-anchor entry, since it didn't recur after
   logging began.
9. **Tests**, each one watched failing first:
   - A pipeline test per surface: web stream, web non-stream (voice/bridge
     shape) and Discord. Each runs a two-round turn through the real loop with
     a stubbed provider, kills it after round 1, and asserts that the human's
     message, round 1 and the note are in the log.
   - The next Discord turn's anchor says round 1's tool ran.
   - A retry of the same `turnId` gets `_turnAlreadyRan` and never calls a tool.
   - The poller doesn't double a round.
   - A shared-room record carries no result text.
10. **Docs.** `docs/architecture.md` (the turn record, the data flow), the
    Manual tome (what the human sees on a cut-off turn), and moving the
    known-issue entries out.

**Surface matrix (RULE C):**

| Surface | Status |
|---------|--------|
| Web live turn | wired |
| Web tool rounds | wired |
| Voice (web call and Discord voice) | wired, via the envelope |
| Claude Code bridge | wired, via the envelope |
| Discord ward | wired |
| Discord villager / ambient | wired, records name calls only |
| Background loops | N/A: no session log; noticing keeps `toolsCalled` in its event log |

**Confidence:** high. The design leans on two things that already exist and
are tested: union-by-id merges, and the Discord persist-first pattern. The
risky parts (two writers, ordering, the poller) each have a specific test.

---

## C. Privacy of what leaves a private room

### C1. The relayed legal name

#### C1.1 The problem

A referral code that was the ward's full legal name in handle form went to a
group channel through `relay_message`. The issue entry's causes are confirmed
in the code:

- `relay_message` checks only `searchRestricted`, which looks for stored
  restricted memories in the draft. The name was stored nowhere, so nothing
  could match it.
- The `message` parameter's description asks for "Concrete and complete".

Pass 1 also found that **the relay skips the semantic outgoing filter**
(`filterOutgoingReply`) that every non-ward Discord reply goes through. It
wouldn't have caught this name either, since it checks the draft against
stored content, but the gap is real.

#### C1.2 Plan, first draft

1. Prompt wording.
2. A heuristic tripwire for name-shaped and code-shaped tokens on every
   message going out to others.
3. A ward list of protected strings.

#### C1.3 Pass 1

- **The heuristic in live room replies would misfire.** People share game
  handles, room codes and booking numbers on purpose. Holding a live reply on
  a heuristic hit leaves a room unanswered, which reads as the Familiar
  ignoring people. Redacting mid-reply ("[held back]") breaks the flow too.
- **Overriding.** If the ward explicitly asks for a detail to be passed on,
  the heuristic needs a way through that the Familiar can reach. The protected
  list must not have one: it's the ward's hard line.
- **Where the list lives.** It holds things like the legal name, so it must
  never be injected into a prompt. The model doesn't need it to avoid sharing
  in the common case, and putting it in context is itself exposure. It lives
  in `settings.json`, which is git-ignored, and only code reads it.
- **Name variants.** "First Last" leaks as `First_Last01`, `First.Last`,
  `FirstLast` or `first-last`, so the matcher must expand those shapes.
- **The example in `relay_message`'s `to` parameter** uses a real-looking
  personal name. It should be a neutral placeholder.

#### C1.4 Adjustments, and pass 2

- **Two strengths of check.**
  - The protected strings, with their variants, are checked on **every** path
    going out to others: `relay_message`, Discord `deliverReply` for non-ward
    rooms, warm reach-outs to villagers, and voice replies in shared rooms.
    They're exact and listed by the ward, so false positives are near zero.
  - On a hit, a relay is held. A live reply gets the string replaced with
    "[a private detail I keep between us]", and the next turn's record says
    so. The ward's own room is never checked.
  - The **heuristic** (name-weld shapes matched against the ward's and the
    villagers' known names, long letter-digit codes, referral and invite URLs)
    runs **only on `relay_message`**. Relaying is the deliberate act of
    carrying the ward's material to someone, and there a confirm step is cheap.
- **On a heuristic hit,** the relay is held and the Familiar gets a plain
  result: "Held: the message has `X`, which looks like a name built into a
  handle. I can send it without that, send it to my human's DM instead, or
  send it as written if my human asked for that exact detail
  (`confirm_detail: true`)."
  - The ward gets a mirror of every hold.
  - The Familiar can obtain `confirm_detail`, because it's an argument on the
    same tool, so this meets the reachability rule.
  - Protected strings can't be confirmed past: "My human listed that as never
    leaving our private conversations — they can send it themselves."
- **The relay also runs `filterOutgoingReply`.** That's one extra LLM call on
  a rare action, and it gives parity with every other non-ward message.
- **Prompt wording** for `relay_message`'s `message` description and
  `buildVillagePresenceBlock`, positive first, per the research notes in
  CLAUDE.md: "A message to others carries what they need in order to answer,
  in my own voice. Codes, ids, links, contact details, and anything shaped
  like a person's full name stay out unless my human asked me to pass on that
  exact detail." "Concrete and complete" stays, scoped to the ask itself.
- **UI.** A "Never leaves our private conversations" list in the Knowledge
  editor. It's ward-only, shows the variants it will match, and follows the
  ⓘ-hint pattern. It needs no console twin: no console command exists for it.
- **Pass 2 check.** The tripwire only tightens, so no villager sees more than
  before. Immersion holds: a live reply in a room still goes out with one
  phrase swapped, and the Familiar is told plainly. A relay hold costs one
  extra round only when there was a hit. The graceful-degradation rule holds
  too: the tripwire never throws into the turn, and if it fails, a relay
  fails closed (held) while a live reply passes through. A failed check
  holding a live reply would silence a room, which is the worse failure.

#### C1.5 Final plan

1. **`src/village/outgoing-tripwire.js`** (new, pure):
   - `protectedHits(text, list)` with variant expansion;
   - `relayShapeHits(text, { knownNames })`.

   Tests cover the variants, plus true negatives such as ordinary handles and
   times.
2. **Wiring:** `relay_message` (heuristic, protected, `filterOutgoingReply`,
   `confirm_detail`), `deliverReply`, the reach-out relay and the voice
   shared-room reply (protected only).
3. **The `privateIdentifiers` setting** (server-side, never synced into any
   prompt) and its Knowledge-editor UI.
4. **Prompt wording** for `relay_message`, plus a neutral example name for
   `to`.
5. **The Manual tome:** what a hold looks like, and where the ward's list is.

**Ward review:** the prompt wording and what the live-reply swap says. This
isn't one of CLAUDE.md's ward sign-off paths, but it governs what reaches
other people.

#### C1.6 What the ward changed, and what was built (0.14.110)

- **No `confirm_detail`.** The ward pointed out that an override the
  Familiar can reach is one a prompt injection can reach too. A held relay
  now waits for the ward alone: the chat notice's **Send it as written**
  button, or `!send <id>` / `!held` in their Discord DM (console↔UI parity).
  The Familiar can only send a new version without the flagged bit. No
  decision model is needed: code finds the shapes, the ward decides.
- **"[private]"** is the live-reply stand-in, chosen over holding the reply
  (a silent room) or dropping the match unmarked (a broken sentence).
- **The "extra filter call" on relays was already there.** Pass 1 said the
  relay skipped `filterOutgoingReply`; on a closer read it runs the same
  restricted search at the same threshold, and lacks only the rewrite loop,
  which for a relay is worse than holding and telling. So no extra call.
- **Two gaps found while wiring:** the raw non-stream `/api/chat` path had no
  outgoing filter, and warm reach-outs to villagers had no outgoing check.
  Both go through the gates now (`gateRoomReply`, and the restricted search +
  list swap in `deliverVillagerReach`). The filter's rewrite caller moved to
  `callProviderChat` (RULE A).
- **Wording** (ward-approved, casual): the `message` parameter, the hold
  result the Familiar gets, and the ward's notice.
- **Not done:** the presence block's "what stays out" line, and the web chat
  with others present (it streams, so neither gate runs there).

### C2. Web memorization tags every web session as "my human's own room"

#### C2.1 The problem

`buildMemorizePayload` always sends `audienceTag: 'ward-private'`. Confirmed:
the web session log stores no room at all, and `/api/logs` treats a missing
tag as ward-private. So a fact about the ward from a shared web chat is tagged
`ward-content-gated`, which every room whose grants cover its topic can see.
The entry's alternative was "within that room's circle".

#### C2.2 Plan, and pass 1

The first draft: the server derives the tag with `audienceTagFor(sessionAudience)`.

Pass 1 found that the room can change mid-session, as people join and leave.
One tag per session would either loosen facts said while the ward was alone
(tagging them for the circle) or keep today's behaviour.

#### C2.3 Adjustment

- The B journal stamps each user message with `audienceTag`, the room at the
  time it was sent. It derives this on the server with `audienceTagFor`, the
  same way `/api/chat` does.
- The memorize enqueue splits a session slice into runs of the same tag, and
  each run is extracted with its own tag. This is a pure split function with
  tests.
- Legacy messages with no tag stay ward-private, which is today's behaviour.

Pass 2: this depends on B (the per-message stamp), so it comes after B. The
memory sweep reads the same logs, so it gets the same split.

**Ward sign-off:** this decides which circles can see what the ward said in a
shared web chat. It's the same class as content gating (CLAUDE.md), so it
needs the ward's decision: the room's circle, or keep content-gated.

---

## A. The Familiar can check its own work

### A1. Identity: reading a file, and edits that can't duplicate

#### A1.1 The problem

There's no tool that reads an identity file. Within a turn, the Familiar sees
only the identity loaded when the turn started. `rewrite_identity_section`
duplicated a section when the new body included the section after it. And
`delete_identity_section` removes every section with a matching heading.

The code confirms all of it (`phylactery/src/phylactery/identity.py`):

- `_rewrite_section` and `_delete_section` both use `subn`, so they act on
  **every** heading that matches.
- A section ends at the next line starting with `#`, of any level, whether or
  not a space follows.

#### A1.2 Plan, first draft

- Treat sections by heading level, so a section includes its subsections.
- Refuse duplicates.
- Add a read tool.

#### A1.3 Pass 1, checked against the real files

Counting heading levels in the live identity store (read-only, no content
read): every file has **one level-1 title** and level-2 sections, and none has
level-3 subsections.

Level-aware sections would make the `#` title a section that *contains the
whole file*. Rewriting "My Identity" would then replace everything. The first
draft would have caused exactly the data loss it was meant to prevent, and it
helps nothing here, because no subsections exist.

**Adjustment:** keep "a section runs to the next heading", and tighten the
stop to real headings only (`^#{1,6}\s`).

#### A1.4 Plan after pass 1, and pass 2

- **`read_identity_file(category, filename)`**, a new Phylactery tool
  (`identity.read_file`). It returns:
  - the current content;
  - its size against the file's budget share (reusing `identityBudgetNote`);
  - an outline of its headings, numbering any duplicates, e.g. "Tone (1 of 2)".

  It goes in the core set beside the edit tools, which have been core since
  0.14.75. It runs only in ward-private conversations, like `list_care_facts`:
  ward files are private, and on a shared turn it refuses plainly.
- **Rewrite** refuses when:
  - the new body contains a heading the file already has outside the section
    being replaced ("…it already has '## B' below. I can rewrite B on its own,
    or leave it out of this one."); or
  - the heading appears more than once and no `occurrence` was given.
- **Delete** refuses on duplicates without `occurrence` and names the count.
- **The Familiar can supply `occurrence`**, because the read tool's outline
  numbers duplicates. The argument is reachable.
- **Results say what happened** instead of a quiet "ok".
  - Rewrite: "Rewrote 'Tone' in self/my_persona.md (now 8.4k chars, 92% of
    its share)."
  - `update_identity`: "Added 312 chars at the end of self/my_wants.md, under
    '## Things I'm curious about'." This is where a misplaced append shows.
  - Every edit result ends: "read_identity_file shows it now."
- **`remove_from_identity`'s not-found message** becomes: "That passage isn't
  in self/X as quoted. It may already be gone (read_identity_file shows the
  file now), or the quote differs from the file." Plain facts, per CLAUDE.md
  #6.

**Pass 2:**

- The tools are core, so this adds about one tool schema per turn, which is
  acceptable.
- Python owns the heading parser, so rewrite, delete and the outline can't
  drift.
- The auto-snapshot stays before every edit.
- On immersion: the read tool lets the Familiar check its own work, which
  ends the "re-cut it four times with different quotes" loop the issue
  describes.

#### A1.5 Final plan

- Phylactery:
  - `identity.read_file`;
  - an `occurrence` argument on rewrite and delete;
  - the duplicate and included-heading refusals;
  - the tightened heading stop;
  - pytest coverage, including the H1 file shape that pass 1 found.
- Thalamus wrapper, then the executor and tool definition in first person.
- Result texts as above.
- The Manual tome entry, and the "self-made rules" known issue updated.

**Built (0.14.111).** Also found on the way: `appendIdentity` called the MCP
tool raw and ignored its answer, so a failed append (Phylactery returned a
"Failed: …" string) came back as ok. `identity_append` now returns a dict,
and the wrapper reads it. The read tool is refused in any room that isn't
the ward's own (`ctx.wardPrivate === false`, so the web chat with others
present too, not only Discord rooms). Edit results report the file's size;
the category-against-budget line lives in the read, where it's useful,
rather than on every edit.

### A2. Write results say what happened

#### A2.1 The problem

`quietOk` collapses every write's success text to "ok". Its comment gives the
reason: the text "recurs every turn the transcript survives". That stopped
being true in 0.12.4, when `collapseToolTurns` began dropping tool results
from history. Only the current turn's rounds see a result now, and later
turns see a 60-character record. So the reason no longer holds — a harness
version of "rules outlive their cause".

#### A2.2 Plan, and pass 1

- **Plan:** render a quiet result as `ok: <full text>`, plus the id when there
  is one.
- **Pass 1:**
  - The record line built from it still says "ok", because `resultLabel`
    matches `^ok`. The next turn's record stays short while this turn sees the
    fact. That's the right split.
  - Cost: about 20–40 tokens per write, within one turn only.
  - Tests that assert a bare "ok" need updating. Failures stay loud, so the
    contract that quietOk is used for success only holds.

#### A2.3 Final plan

- Change `renderToolResult` and update its doc comment.
- Retire the `PROTO_FAMILIAR_QUIET_TOOLS_DISABLED` escape hatch, since the
  full text is now always there.
- Tests.

### A3. Recall results cut mid-word

#### A3.1 The problem, and pass 1

The issue names the `recall` tool. Pass 1 found **five consumers** of the same
`excerpt: content[:300]`:

- the `recall` tool (two sites);
- the **always-injected memory block** in `thalamus.js`;
- pondering's grounding;
- server endpoints;
- tome-graduation dedup.

So the automatic memory block on every turn shows cut-off facts too. Fixing
it at the recall tool would leave the most-read surface broken. That is the
root-cause class CLAUDE.md warns about: a fix applied to one surface.

#### A3.2 Plan

- Build the excerpt **at the source**. A Python `excerpt()` in Phylactery
  mirrors `src/util/excerpt.js`: start and end, cut at word boundaries, with
  the same marker.
- One shared fixture file of input/output pairs is run by both the Node and
  the Python tests, so the two can't drift. This is the same pattern as
  `content_gate.py`.
- Results gain `truncated: true` and `chars`.
- The `recall` tool appends "(read_memory_by_id <id> shows all of it)" to a
  cut result.

**Pass 2:** the marker already reads as "cut for length", not as an
unfinished fact. Consumers that slice again (tome-graduation's `.slice(0,160)`)
switch to `excerpt()`.

### A4. Tome entries can be edited and deleted

#### A4.1 Plan

`edit_tome_entry({ tome, entry, content?, title?, keywords? })` and
`delete_tome_entry({ tome, entry })`. `entry` accepts whatever `read_tome`
shows (alias, uid or title), resolved by the same lookup that `read_tome`
uses. That covers reachability.

#### A4.2 Pass 1

- **Deleting is permanent.** Tomes have no snapshot the way identity and
  memory do.
- **The ward's own material sits in tomes too.** That includes the condition
  tomes and their shipped entries. They're the install's live copies, which
  the app already writes at runtime (`tome-migrations.js`), so a runtime edit
  doesn't touch git.
- **Share tags.** An edited note could newly name a person.
- **Loops.** The tome-tagging and graduation loops mark entries reviewed. An
  edited entry has new content.

#### A4.3 Adjustments, and the final plan

- **Every edit and delete first appends the old entry** to
  `tomes/.tome-edits.jsonl`.
- **The Tomes modal shows "Recently changed by my Familiar"** with Restore.
  Nothing changes covertly, and the ward can undo. This isn't a permanent
  delete, so it doesn't fall into the prohibited class.
- **`protected` tomes (the Manual) refuse:** "That's the app's own manual — it
  rewrites itself; I can't edit it."
- **Ward-private turns only**, like `read_tome`.
- **Edited content re-runs `tomeShareForSave`,** so a note that names a person
  is held at sensitive by code, whoever tagged it.
- **An auto-sorted tag is cleared** for re-sorting, and the graduation
  reviewed-mark is cleared.
- **Updates:** the Manual tome, `list_tomes` / `read_tome` texts that name the
  new tools, and tests (including a restore round-trip).

### A5. Rules outlive their cause, and confabulation

- **Confabulation.** Most of what's left is covered by B (true records on
  Discord, cut-off turns recorded) and A1–A2 (results that say what happened,
  edits that can be checked).
  - **Don't build** a prose detector for "claims done": three over-broad
    sweeps last milestone were all noise (verification lesson #8).
  - Instead, after B ships, compare zero-call turns whose next-turn record
    disagrees with the reply, using the turn log.
- **Rules outlive their cause.** `src/self/retired-limits.js` would be a short
  app-maintained list of limits the app has fixed. Each entry carries:
  - an id;
  - the version it was fixed in;
  - one plain sentence ("The app now marks calendar-synced items with 📅 and
    won't delete them").

  Each entry is shown once in the next ward-private live turn as an app note.
  That rides an existing request: no new call.

  The Familiar decides whether a rule of its own is still needed; the app
  never edits its rules. This is the groundwork the "rules I keep" surface
  was waiting for. Low priority: it goes after A1–A4, which retire the rules
  themselves.

---

## D. Intentions fire and get followed through

### D1.1 The problem, as the noticing log shows it

The entry asks for concrete misses first. The noticing event log
(`logs/noticing-events.jsonl`) for the last two weeks has them:

- **About one in five noticing deliberations failed:** 55 of 260.
- **About a third of due-intention looks failed:** 22 of 72.
- The failures, by kind:
  - a provider call gave no answer within 180 s: 39;
  - the provider's weekly limit was reached: 12;
  - the deliberation passed its deadline: 7;
  - the fetch failed: 4.
- The failures cluster on bad days (16 of 26 on one day, 14 of 25 on another),
  which fits provider trouble, not the prompt.

And the loop has a bug that turns a failed look into a long miss
(`src/safety/noticing-loop.js`):

- After a tick, every due intention in the tick's conditions is added to
  `_seenDue`, **including when the deliberation failed**.
- A failed tick sets no new cool-down.
- So a due intention that woke the loop during a cool-down, and whose look
  failed, now counts as seen. The next chance to act on it comes when the
  cool-down ends, which can be up to six hours away. This is the same shape as
  the 0.14.99 miss, through a different door.

### D1.2 Plan, first draft

- A failed look doesn't count as a look.
- Retry with backoff.

### D1.3 Pass 1

- **A retry against the same failing provider** (weekly limit, an overloaded
  model) just fails again.
- **Retries cost tokens** from a fixed weekly budget, and the weekly-limit
  failures are that budget running out.
- **An intention that can't get a look at all** still needs a way to reach
  the Familiar.

### D1.4 Adjustments, and the final plan (ward sign-off)

1. **`_seenDue` only takes ids from a look that ran.** Any `deliberation_failed`
   or `tick_released` leaves them unseen. The fix is one line, with a test that
   fails first on today's code.
2. **Backoff for a failed look with a due intention:** 5, then 15, then 30
   minutes, three tries at most. It applies to the due intention only, not the
   loop's general cadence. A weekly-limit error skips straight to step 3,
   since retrying the same connection can't work.
3. **Fallback connections** for the noticing deliberation:
   - It uses the ward's existing fallback list, the same one the web chat uses.
   - Only on quota, server or timeout errors, and logged with the connection
     used.
   - It's a ward toggle: the ward decides whether a different model may act
     in noticing.
4. **If it still can't get a look,** the due intention reaches the Familiar in
   the next live ward turn as a plain fact: "[Came due while I couldn't think
   it through: <intention> (due 14:00).]" That rides a request that already
   happens.
5. **Instrumentation:** per-call latency in the noticing log, to decide later
   whether 180 s is too tight for thinking models or whether those calls
   should stream. That decision is deferred until the data exists.

**Pass 2:**

- Every step only makes acting more reliable, and none softens it. This is
  still the noticing loop, so it needs the ward's sign-off (CLAUDE.md).
- Token cost is bounded at three retries per due intention, and quota errors
  skip them.
- The live-turn line uses the `[Deferred intents]` voice that's already
  there. Immersion holds: the Familiar learns of the intention plainly, as an
  app fact.

### D2. Presence: the Familiar's own interests and plans

The entry asks for a design pass, not a fix, and D1 is part of the answer: a
third of due-intention looks failing reads, from the outside, exactly like "a
Familiar that doesn't follow through". The plan:

1. Ship D1 and measure again.
2. Then use the week-long test's logs to answer the entry's four questions:
   - Do pondering interests ever become intentions?
   - How much of the identity block is about the Familiar itself?
   - How do the intention tools get offered?
   - How much depends on the model family?
3. Bring the findings and options to the ward before designing anything.

A design written before step 2 would be a guess.
