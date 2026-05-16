# Future features

Scratch pad for ideas that are pending design or implementation. Add an
entry as a top-level bullet, with enough context for a future session to
pick it up without re-deriving the problem.

## Memory entries

- **Time-code on memory entries.** Memory entries (Tome entries written
  by the session/topic summarizer) should carry a visible time code in
  the UI — at minimum the source session's start, ideally also the
  message-range timestamps. Today only `created_at` and `learnedAt` are
  stored; neither is surfaced in the Tome Manager rows. Decide whether
  to render the existing `learnedAt`, add a new "session time" field on
  the entry, or both.

- **Category button for memory entries.** A per-entry category field
  (e.g. mood / event / preference / situation) selected from a small
  fixed set, shown as a colored chip in the manager and filterable.
  Need to decide: is this a free-form tag or a closed enum, does the
  summarizer pick it or only the user, and does it affect activation
  (e.g. weight or scope) or only display.
