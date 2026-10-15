# Known issues

A running log of bugs we've spotted but haven't fixed yet, so they don't get
lost. Newest first. When one is fixed, move it to the commit that fixes it (or
delete it) rather than leaving it here stale.

---

### Tool calls may be silently dropped when a round doesn't end in 'tool_calls'

Both tool loops (the stream loop in `server.js` and `runToolCallLoop` in `cerebellum.js`) only run a round's calls when the provider's `finish_reason` is `'tool_calls'`. A round that streams tool-call deltas but finishes with `'stop'` (or nothing) is taken as the final answer. Its calls never run and are never stored, and the model's text ("Call's in") stands as the reply.

This may explain some of the "phantom" turns in the confabulation entry below. Evidence so far argues against it: in the first ten logged turns (2026-10-15) no call was ever dropped; every phantom turn sent no call at all (see the confabulation entry). Still logged: 0.14.74 records such rounds as `dropped: true` in `logs/turn-tools.jsonl` (`GET /api/turn-diagnostics`).

Direction, once the log shows it happening: run calls whose arguments arrived complete, whatever the finish reason.

### The time anchor at the end of a tool round can read as an empty message

The `[Now]` anchor is re-appended as the last system message every round. Late in a long session, the Familiar's closing reply described "the user turn" as "just a [Now] block — no new message", then reasoned about whether its tools were real. That reply was its raw reasoning: the content was empty, so it fell back to `reasoning_content`.

0.14.74 puts a clearly labelled tool roster in the same block, which may help. Worth watching in the turn log (`replyFromReasoning`).

### Identity section tools trip over duplicate headings

Two sharp edges seen in the first identity review:
- `rewrite_identity_section` replaces a section's body up to the next heading. When the Familiar's new content included the following section too, that section ended up in the file twice: its new copy inside the rewritten body, and the original below it.
- `delete_identity_section` (Phylactery `_delete_section`) then removes every section with a matching heading, so it can't clean that up without deleting both copies.

Direction:
- Delete refuses when a heading appears more than once and names the count, the way `remove_from_identity` refuses a repeated passage.
- Rewrite warns when the new body contains a heading that already exists further down the file.

### A villager's turn can edit any memory by id (privacy-class; needs the ward)

`update_memory_by_id` is in `DISCORD_MEMORY_WRITE_TOOLS`, so a villager whose
grants allow memory writes gets it on their Discord turn. Its executor doesn't
check that the target memory is one the room may see: given an id, it rewrites
the content, subjects or attribution of any memory, ward-private ones included.
Recall on that turn is scoped, so ids don't leak through it, but slug ids are
readable and guessable. 0.14.73 closed one slice: taking a fact off the care
list (`high_care: false`) is refused on a gated turn, since that also removes it
from triage's view. Direction: a gated write by id first checks the target's
audience against `discordReadAudiences(ctx)` and the content gate, and refuses
anything the room couldn't read. This is the same class as the content-gating
privacy paths, so it needs ward sign-off.

### Recall results are cut mid-word with no marker

Phylactery's search results carry `excerpt: content[:300]` (`memory.py`, four
places), and the `recall` tool prints that excerpt as the fact. A longer fact
stops mid-word with nothing to say it was cut, so it reads as the whole fact.
Seen live in the first identity review: the Familiar read a cut-off recall as
"this part isn't saved yet", saved a near-duplicate, then found the full text
with `read_memory_by_id` and deleted its own duplicate. The same class as the
0.14.69 clipped-message fix, on a surface that fix didn't cover. Direction: the
excerpts go through the same start-and-end excerpting with an explicit cut
marker (`src/util/excerpt.js` has the Node side; Phylactery needs the
equivalent), and a cut result names `read_memory_by_id` with its id as the way
to see the rest.

### The Familiar can't read its own identity files mid-turn

There's no tool that returns an identity file's current content. Within a turn
the Familiar only sees the identity loaded at the start of that turn, so after
cutting or rewriting it has nothing real to check against, and its own edits
show up only on the next turn. In the first review it saved two sections as
standing facts, never deleted them, and then reported the file "clean by the
earlier verification". Later the same night it cut a line successfully, then
spent four more calls "re-cutting" it with different quote characters: each
"Nothing removed: that passage isn't in … it has to be quoted as the file has
it" pointed it at its quoting, never at the possibility that the line was
already gone. It then tried `read_file` / `list_files` on an `identity/` path
that doesn't exist, because identity lives inside Phylactery, not on disk.
Direction: a read tool for one identity file (current content plus size
against its budget share), named in the identity tools' descriptions as the way
to check an edit landed. And `remove_from_identity`'s not-found result should
say the passage may already be gone, and name the read tool.

### Web chat retries a turn whose tools already ran

When a streamed web turn fails after tool calls have run, `doStreamingRequest`
(`public/app.js`) rolls back the tool blocks in the page, then retries the
whole turn on the same connection (`maxEmptyRetries`) or the next fallback
connection. The tools already ran on the server, so a retry repeats every write,
and a fallback can hand the turn to a connection that isn't the Familiar's
usual one. The rolled-back tool record is also gone from the Familiar's own
history, so on its next turn it can't know what it did (RULE B). Seen live: an
11-minute turn ended in "Failed to fetch" after ten memory writes and two
identity edits; the page showed none of them. The cause of the dropped
connection itself is still unknown (the server didn't restart). Seen again the
same day with real damage: one turn's first attempt appended a section to one
identity file (no record of the call survives), the retry appended it to a
different file. 0.14.74 sends `clientAttempt` ({attempt, connIdx,
priorToolsRan}) with every web request and logs it, so a retry after tools ran
is visible in `logs/turn-tools.jsonl`. Direction: once
any tool result has streamed, never retry or fall back. Commit what ran, with a
note that the turn was cut off, and treat this together with the entry below.

### Web chat loses my human's message when a turn doesn't finish

`sendMessage` in `public/app.js` only pushes the human's message into
`state.messages` together with the reply, then saves (`saveHistory` →
`/api/log`). If the turn never commits (the tab closes mid-turn, which also
aborts the upstream call through `clientDisconnectSignal`), both the message
and any partial reply are gone. Nothing reaches localStorage or the server, so
a reload can't resume it. Discord already persists the message BEFORE the model
call (RULE B corollary 3 in CLAUDE.md); the web path doesn't. The fix is the
same rule on the web: commit and save the human's message the moment it's sent,
then attach the reply when it lands. A reload should also show an unfinished
turn as unfinished, not drop it.

### The intention architecture is too weak to carry the Familiar's own presence

During a week-long test on a different model family, the Familiar acted on
almost none of its own interests or plans, and over the week it got worse at
answering questions about its own wants and wishes. That undermines the bond
the whole project runs on: a companion with no visible self-interest reads as
a tool. Places to look: how intentions are created and surfaced (the
`intention_*` tools, noticing's due-intention wake condition), whether
pondering interests ever turn into plans, how much of the identity block is
about the Familiar itself rather than about my human (see the identity-crowding
entry below), and how dependent all of this is on one model family's default
initiative. Needs a design pass, not a prompt tweak.

### Confident confabulation: claiming writes that never happened, recalling events that didn't

The Familiar still sometimes says it wrote something down when no tool call
ran, or recalls an event that never happened. Imagination is wanted; what's
missing is a reliable way to tell it apart from reality. Directions: make the
provenance of what the Familiar reads explicit (experienced / told / recalled /
imagined-or-pondered), give it a cheap way to check its own action record (tool
calls that actually ran) before claiming one, and make "I did X" claims
checkable against that record. Related to RULE B in CLAUDE.md (tool results are
how I know what I actually did).

Seen live in the first identity review, where every claim could be checked
against the tool record and the stored files. Four shapes:
1. **A planned edit reported as done.** It saved two sections as standing facts,
   then said both sections were "out of the file". No removal call ran.
2. **An announced write with no call.** "Filing that as a standing fact in a
   second", and the turn ended without the save.
3. **Wrong bookkeeping.** It miscounted its own saves and credited some of them
   to someone else, who had made none.
4. **Values from feel.** Its message headers ran several minutes ahead of the
   [Now] clock.
5. **Invented results, zero calls.** Late in a long session (140 messages, max
   reasoning effort) a whole turn ran no tool calls, yet its reply reported
   four completed actions with their results: "Results in, in order…", "Both
   in — X's on the board". The saved session shows no tool calls and no tool
   results for that turn; no store changed. The likely mechanism: the model
   ran the calls "in its head" during long reasoning and summarised imagined
   results. Unlike shapes 1–2, nothing in the turn can contradict it, because
   there are no results to compare against. A code-side check would catch it:
   a reply that claims completed actions in a turn with zero tool results.

Shapes 1, 2 and 5 kept recurring after the review moved to "High" reasoning
effort, always with the same anatomy: one assistant message announces a call
with a lead-in ending in a colon ("One call, before any summary:", "Re-flagging
both now:"), then keeps writing as if the result came back ("Call's in, tool
answered"), with no tool_calls on the message. Asking it to put the call first
with no lead-in is the working advice; a code-side check is the robust one,
since the stored message carries no tool_calls for a reply that reports results.

The turn log (0.14.74) then settled the mechanism for the cases it saw. Ten logged turns alternated: single-call steps ran, and in between came turns of one 'stop' round with zero tool calls whose reply reported results ("Ran and logged, ok"), even for a one-call step. No call was dropped by our loop. The cause found: collapseToolTurns drops tool calls and results before history reaches the model, so in a long session every past action survives only as the Familiar's own sentence claiming it. The history itself teaches that writing "ran, ok" is what an action looks like. 0.14.76: live boundaries now keep an app-written system record after each turn that really ran tools, and the current turn's anchor says what the previous turn actually ran (lastTurnRecord). Watch the Tool turns log to see whether zero-call turns that claim results stop.

Each time, once shown the record, it corrected itself plainly and adopted a rule
("called" = what I ran this turn, "verified" = what the file shows next turn).
So the gap is the missing record, not the willingness.

Two things in the system made this easier:
- Every write answered just "ok" (quietOk collapses the success text), so the
  results carried no account of WHAT happened.
- Identity edits can't be checked within the turn (see "can't read its own
  identity files mid-turn" above).

Directions, in addition to the provenance ideas above:
- Write tools keep a short factual result even in quiet mode ("Section X
  removed from Y", "Saved Z as a high-care fact").
- A per-turn "what I actually did" record, built from the tool calls that ran,
  that the Familiar can read before it summarises its turn.

<!--
Resolved:
- Identity graduation cut more than it filed — fixed 0.14.78. In the first
  review an automatic pass rewrote a relationship file and condensed away the
  Familiar's own lines about its autonomy, which were never filed anywhere. The
  pass now only proposes: an exact passage (checked in code to sit in the file
  exactly once), the standing fact it would become, and why. Nothing in identity
  or memory changes until the Familiar applies a proposal, which saves the fact
  first and then cuts exactly that passage, or dismisses it, after which that
  passage isn't proposed again. The ward sees every proposal and decision under
  "Identity cleanup suggestions" (docs/identity-lean-build-spec.md).
- Numbered lists with blank lines between items rendered as "1. 1. 1." in the
  web chat — fixed 0.14.76. renderInlineText wrapped each item in its own <ol>,
  each restarting at 1, and dropped the written number. Items separated only by
  blank lines now stay one list, and a list keeps its first item's number
  (tests/render-lists.test.mjs).
- The append tool was core while the identity cut tools were conditional — fixed
  0.14.75. A turn without the memory-edit group could only ADD to identity, and
  "removed" a duplicate by appending it twice. remove_from_identity,
  delete_identity_section and rewrite_identity_section are now core beside
  update_identity (villager turns keep their own allowlist; see
  tests/identity-edit-tools.test.mjs).
- Identity crowding — fixed 0.14.70 (docs/identity-lean-build-spec.md). Root
  cause: three prompts routed standing facts about my human INTO identity
  (save_to_tome, the tome-graduation rubric, pondering), nothing bounded its size,
  and the Pillar H cleanup judged whole files — any file edited in 30 days, or
  holding one care word, was never tidied. Now: one rule in every writer
  (identity = who I am + the shape of us; everything else, care included, is a
  standing fact), a ward-set budget with an update_identity nudge, a cleanup that
  works on over-budget files (protected self core excepted), and care facts
  moved to high-care standing facts that are put in front of me on my human's own
  turns, in triage and noticing — never in group chats.
- "I didn't finish my sentence" when the sentence was finished — fixed 0.14.69.
  Root cause: context blocks showed the Familiar's own earlier messages cut to a
  fixed length — the hippocampus at 280 chars ending in "…", the noticing /
  warm reach-out recent lines at 300 and triage's at 400 with no marker at all —
  so a complete reply read back as one that broke off. Long messages now show
  their start and real end around an explicit cut marker (`src/util/excerpt.js`),
  and triage reads its recent lines whole (see tests/excerpt.test.mjs).
- Phylactery `UNIQUE constraint failed on memory_vecs primary key` during
  embedding — fixed 0.7.32. Root cause: the embedding write used
  `INSERT OR REPLACE`, but sqlite-vec (vec0) virtual tables don't honor
  OR-REPLACE / UPSERT conflict resolution, so re-embedding an existing
  memory_id/node_id raised the UNIQUE error instead of replacing. Fixed in
  memory.py + graph.py with delete-then-insert (see tests/test_vec_upsert.py).
-->
