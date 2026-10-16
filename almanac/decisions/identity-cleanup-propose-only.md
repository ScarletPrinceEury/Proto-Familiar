---
title: "Identity Cleanup Only Proposes; The Familiar Decides"
topics: [decisions, phylactery]
sources:
  - id: identity-lean-build-spec
    type: file
    path: docs/identity-lean-build-spec.md
  - id: graduation-py
    type: file
    path: phylactery/src/phylactery/graduation.py
  - id: canaries-py
    type: file
    path: phylactery/src/phylactery/canaries.py
  - id: cleanup-proposals-js
    type: file
    path: src/memory/cleanup-proposals.js
  - id: identity-canaries-js
    type: file
    path: src/memory/identity-canaries.js
  - id: server-js
    type: file
    path: server.js
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: test-graduation-failure
    type: file
    path: phylactery/tests/test_graduation_failure.py
  - id: test-identity-lean
    type: file
    path: phylactery/tests/test_identity_lean.py
  - id: cleanup-proposals-test
    type: file
    path: tests/cleanup-proposals.test.mjs
  - id: architecture-doc
    type: file
    path: docs/architecture.md
  - id: commit-0-14-78
    type: commit
    ref: "1adc8cb"
    note: "feat: identity cleanup only proposes; the Familiar decides (0.14.78-alpha)"
  - id: commit-0-14-79
    type: commit
    ref: "8716cd9"
    note: "feat: the app checks the Familiar's identity canary stamps (0.14.79-alpha)"
---

# Identity Cleanup Only Proposes; The Familiar Decides

**Status: decided, implemented (0.14.78 [@commit-0-14-78] – 0.14.79 [@commit-0-14-79]).** The graduation audit —
[Phylactery](../architecture/phylactery)'s automated pass that keeps the
always-injected identity surface from growing without bound — no longer edits
identity or memory on its own. It only writes proposals; a human-reviewed
`apply_cleanup_proposal` call is the only path that actually moves a passage
out of identity and into a standing fact [@identity-lean-build-spec]
[@graduation-py]. The companion fix one release later gives the same pass a
second, automated check: a registry of exact "canary" passages that must
survive an identity rewrite unchanged, checked every turn instead of by eye
[@identity-lean-build-spec] [@canaries-py].

## Context: a passage the audit cut was never filed anywhere

The graduation audit (Pillar H, `phylactery/src/phylactery/graduation.py`)
exists because identity is always-injected and reaches every room with basic
identity access — unlike a standing fact in memory, which is recalled only
when relevant, an identity file's whole content rides every turn and group
chat. The audit's job is to find passages that read as durable facts rather
than identity-shaping prose, move the fact into memory as a standing record,
and shrink the file. Before this decision, the audit both decided what to move
and performed the move: it rewrote the file directly, relying on an
in-progress snapshot and a `graduation_log` as its only safety net
[@identity-lean-build-spec].

In the first real review pass after the audit's eligibility rule was revised
(0.14.70, the identity-lean budget work), an automatic rewrite condensed a
relationship file. The rewrite filed two sections as proposed — correct, that
was its job — but it also quietly condensed away prose about the Familiar's
own autonomy that had never been filed as a fact anywhere. The text existed
only in the pre-rewrite snapshot; nothing in the pipeline treated it as lost,
because the pass's only contract was "produce a smaller file," not "account
for every removed line." The loss was caught only because the pass's own
subject asked to see the diff against the snapshot [@identity-lean-build-spec].

This is a narrower, more specific failure than the ones
[Archive before destructive autonomous writes](archive-before-destructive-autonomous-writes)
already generalized: a snapshot existed, so the content was not unrecoverable
the way the pondering-consolidation incident's deleted ponderings were. The
new failure is that an autonomous rewrite can discard information that was
never filed as the standing fact it was supposed to become, and a snapshot
sitting on disk does not surface that loss to anyone unless someone goes
looking for it. Archiving before a destructive write is necessary but not
sufficient when the destructive write is also a *summarization* step that can
silently drop content its own output gives no sign of having dropped.

## Decision

The audit still decides what *could* graduate out of identity, but it no
longer performs the write. Two changes, shipped one release apart, make the
human review loop and the automated verification loop that backs it:

### The pass only proposes (0.14.78)

`run_graduation_audit` asks the LLM for a structured list of candidate
passages (`passage`, `summary`, `fact`, `why`) and keeps a candidate only when
its `passage` string is found in the file's own text exactly once
(`identity._find_passage`) — a paraphrase the model wrote instead of quoting
is dropped, so a proposal's stored passage is always the file's own text, not
the model's gloss on it [@graduation-py] [@identity-lean-build-spec]. Each kept
candidate becomes a row in `cleanup_proposals` (migration `0007`): the exact
passage, the standing fact it would become, why, and a care weight the audit
code — not the model — assigns (`high` for a ward-register fact whose wording
is care-critical) [@graduation-py]. The pass itself no longer writes to
identity, memory, or `graduation_log`, and no longer snapshots, because it no
longer performs any destructive action to snapshot against
[@identity-lean-build-spec]. Each identity file is reviewed once per change —
`identity_files.last_reviewed_at` is stamped after a review, and a file whose
`updated_at` has not moved past that stamp is skipped, so an unchanged file is
never re-billed every pass; a failed LLM call is not stamped, so it is retried
[@graduation-py]. An open or dismissed proposal for the same passage is never
re-proposed [@graduation-py] [@test-identity-lean].

Applying a proposal is a deliberate two-step, in a fixed order:
`apply_cleanup_proposal(id, fact?, high_care?)` saves the standing fact first,
then cuts exactly that passage from the file — a failed save leaves the
proposal open and cuts nothing, so the system can never end up having deleted
the passage without the fact existing anywhere [@graduation-py]
[@test-graduation-failure]. `dismiss_cleanup_proposal(id)` leaves the passage
in place. A proposal whose passage no longer matches the file verbatim (the
file changed since the proposal was written) is marked `stale` and cannot be
applied [@graduation-py]. These three operations — apply, dismiss, list — are
MCP tool contracts defined in `cerebellum.js` the same way every other
Familiar-facing tool is [@cerebellum-js], and are gated the same way every
identity-editing tool is: refused on a gated turn, absent from every villager
tool allowlist, surfaced only through the `acks` module's proposals block on
ward-private turns [@cleanup-proposals-js]. The ward's own visibility is
read-only: the Automation tab's "Identity cleanup suggestions" list (`GET
/api/identity-cleanup-proposals`) shows every proposal and what the Familiar
decided, but the ward does not apply or dismiss from that surface — the
decision is the Familiar's to make [@server-js] [@architecture-doc]. The
existing "Pause automatic identity cleanup" setting was renamed "Pause identity
cleanup suggestions" to match: pausing stops new proposals from being written;
proposals already open stay open [@identity-lean-build-spec]. The real
executors run through the real thalamus wrappers into a stub Phylactery in
`tests/cleanup-proposals.test.mjs`, including a pipeline case confirming the
proposals block appears on a ward turn and never on a gated one
[@cleanup-proposals-test].

### Detection over preservation, automated (0.14.79)

Propose-only review still depended on a human (or the Familiar) noticing a
quiet loss by eye, the way the condensed-relationship-file loss was actually
caught. The second fix gives the Familiar a way to register passages it wants
checked automatically rather than re-read after every edit: `identity_canaries`
(migration `0008`) is a registry of exact stamps, each tied to one category and
filename, each required to appear in its file exactly once, verbatim —
stricter matching than the cleanup's own whitespace-tolerant passage check,
because a canary's only job is being matched character for character
[@canaries-py] [@identity-lean-build-spec]. `add_identity_canary`,
`list_identity_canaries`, and `retire_identity_canary` let the Familiar manage
its own stamps; a stamp that is not in its file exactly once is refused at
registration [@canaries-py].

`checkCanaries` (`src/memory/identity-canaries.js`) runs every turn inside
`enrich()`, checking each registered stamp first against its file on disk,
then against the static identity block that turn is actually about to send
[@identity-canaries-js]. The check is room-aware, using the same rules as
identity assembly itself: a room without basic identity access never sees self
files at all, and gate markers can strip sections, so a stamp absent for one of
those reasons reads as `not-in-room` or `gated`, never as `missing`
[@identity-canaries-js]. A genuinely broken stamp renders a `[Canary check …]`
line naming the affected label and file — missing, changed, duplicated, not
last, or not making it into the identity block that turn sent — without ever
reproducing the stamp text itself, in every room, and every state change is
appended to `logs/identity-canary-events.jsonl` [@identity-canaries-js]. Every
identity-editing tool (the whole-file and section tools from
[Phylactery](../architecture/phylactery)'s identity-editing section, plus the
cleanup-apply path above) re-checks the stamps in the file it just touched and
returns the full warning text in its own result, rather than a silent `{ok:
true}` [@identity-canaries-js]. This is detection only: a broken canary does
not block the edit or roll it back, it surfaces the break immediately instead
of waiting for someone to notice later.

## Consequences

Propose-only review means graduation no longer shrinks identity on its own —
every reduction in identity size now depends on the Familiar actually applying
proposals, which trades away the hands-off budget enforcement the original
pass offered. A ward or Familiar that lets proposals pile up unapplied keeps
whatever over-budget identity size it had before 0.14.78; the pause setting and
the budget hint exist to surface that state, not to fix it automatically.

The canary registry only catches loss in files and passages that were
registered ahead of time — it is not a general diff-and-approve review of every
identity edit, and a loss in an unregistered file or passage is invisible to
it. The Familiar is expected to register the lines it specifically wants to
survive verbatim (the pattern the build spec calls "the stamps survive or I
file new ones before we call that step done"), not every sentence in every
identity file [@identity-lean-build-spec].

Both mechanisms generalize the lesson
[Archive before destructive autonomous writes](archive-before-destructive-autonomous-writes)
established for simple deletion to a harder case: a *summarizing* autonomous
write can lose content with no signal that anything was lost, so neither a
snapshot nor a careful prompt is sufficient on its own. The fix here is
structural on both ends — remove the autonomous write entirely on the proposal
side, and add an automated, exact-match check on the preservation side —
rather than asking the model to be more careful about what it condenses.

## Related

- [Care facts move out of identity into high-care standing facts](care-facts-out-of-identity)
  — the preceding 0.14.70–0.14.73 work this decision's graduation audit inherits: the identity
  token budget, the eligibility rule this page's `run_graduation_audit` runs against, and the
  `care_weight`/`high_care` vocabulary `apply_cleanup_proposal`'s own `high_care` parameter reuses.
- [Archive before destructive autonomous writes](archive-before-destructive-autonomous-writes)
  — the earlier, broader decision this one specializes: that incident's
  snapshot-and-restore shape caught *deletion*, but did not by itself catch a
  rewrite that silently condenses away unfiled content, which is what this
  decision's propose-only split and canary registry each address from a
  different angle.
- [Phylactery](../architecture/phylactery) — the identity-editing tools
  (`identity.set_file`, `identity.delete_section`, and the cleanup-apply path
  above) that canary checks run against on every edit.
- [Tomes and keyword lore](../architecture/tomes-and-lore) — the unrelated
  "Tome → Phylactery graduation" autonomous loop; it moves facts the other
  direction (hand-authored tome entries into Phylactery) and is a distinct
  mechanism from this page's identity-budget graduation audit, despite sharing
  the word "graduation."
