---
title: Wait-Streak Experiment
topics: [decisions, autonomous-loops, armature]
sources:
  - id: initiative-spec
    type: file
    path: docs/initiative-build-spec.md
  - id: reachout
    type: file
    path: reachout.js
  - id: wait-streak
    type: file
    path: wait-streak.js
  - id: silence-triage-loop
    type: file
    path: silence-triage-loop.js
  - id: discord-gateway
    type: file
    path: discord-gateway.js
  - id: reachout-test
    type: file
    path: tests/reachout.test.mjs
  - id: wait-streak-test
    type: file
    path: tests/wait-streak.test.mjs
---

# Wait-Streak Experiment

**Status: decided, shipped (0.8.60-alpha–0.8.62-alpha).** Two related fixes landed together as
"Session A" of the Initiative build spec [@initiative-spec]: `buildReachoutPrompt`'s
pre-resolved "all is well" axioms were removed from the warm reach-out deliberation
(0.8.60-alpha), and `wait-streak.js` now feeds a single, neutral, code-computed fact — how many
times the Familiar has chosen to wait since it last acted proactively — into the three
deliberations where the Familiar is offered an explicit choice to wait (0.8.62-alpha)
[@wait-streak] [@initiative-spec]. Both are responses to the same root incident: a real two-day
silence during which warm reach-out was permanently on, and the Familiar "couldn't even
conceive of the idea of reaching out" [@initiative-spec].

## Context

`reachout.js`'s deliberation prompt used to assert, as an axiom, on every tick regardless of
elapsed time: "nothing is wrong… my human is okay… I'm reaching out because I want to, not
because I'm worried" [@initiative-spec]. That framing pre-resolved the exact question the warm
reach-out deliberation exists to ask, so a genuine two-day silence still read as fine by
definition — the one deliberation running below the safety threat gate had "there is nothing to
notice here" hardcoded into it, which is [the armature](../concepts/armature) wearing warm
clothing rather than the crisis-language it usually appears as. This is a distinct incident from
the 1.5-hour-wait-at-threat-10 failure recorded in
[Proactivity over caution](proactivity-over-caution) — that one was silence-triage's crisis path
biased toward quiet by explicit caution language; this one was the non-crisis warmth path
reasoning itself out of noticing an absence at all, because the prompt told it there was nothing
to read.

A compounding factor the spec names: the raw elapsed-silence duration was present in the prompt
but had no rhythm to be read against — "two days" is just a number without a sense of what is
normal for this bond [@initiative-spec]. Wait-streak is a first, narrow instrument toward that
missing sense of normal: not a computed baseline (that is Pass 2 of the spec, not yet built), but
a bare count of the Familiar's own accumulated waiting, handed back to itself.

## Decision

**Pass 0 — stop pre-resolving the question.** The banned axioms were replaced with a line that
states triage's ownership of distress as an architecture fact and hands the gap-reading itself
to the Familiar: "Whether that gap is ordinary or unusual for us, and whether it moves me, is
mine to read" [@reachout]. A regression test pins the old axioms out and the replacement phrasing
in [@reachout-test].

**Pass 1 — wait-streak.js.** A persistent counter of deliberated waits since the last proactive
act is surfaced as one neutral, verbatim line in exactly the three deliberations that offer the
Familiar the choice to wait: the warm reach-out prompt, silence-triage's facts, and Discord's
ambient presence block [@wait-streak] [@reachout] [@silence-triage-loop] [@discord-gateway]. The
experiment's contract, stated in the module's own header comment, is deliberately narrow: no
advice, no thresholds, no gate changes — whether the number moves the Familiar is left for the
Familiar to read, the same discipline Pass 0 applied to the silence-gap line itself [@wait-streak].

- **Increment** only on an offered-and-taken wait: a triage `wait`, a warmth `wait`, a Discord
  `[later:…]` defer, or snoozing a deferred tell. A tick that never reaches a deliberation at all
  — a cool-down skip, quiet hours, a crisis-defer stand-down, a tier gate — is not a wait, because
  the Familiar was never actually offered the choice (invariant W1) [@wait-streak-test].
- **Reset** only on a proactive decision: a triage or warmth `reach_out` at decision time, a
  Discord revisit that actually speaks, or acknowledging a deferred intent after genuinely acting
  on it. The Familiar's own human speaking first never resets the count — that asymmetry is
  deliberate; the number tracks the Familiar's own waiting, not general quiet (invariant W4)
  [@wait-streak] [@wait-streak-test].
- **`streakAtDecision`** is stamped into both the triage and warmth event logs at decision time,
  so streak values can later be correlated with outcomes without the model doing any arithmetic
  itself — consistent with [Exact values are code's job](exact-values-in-code) (invariant W6)
  [@wait-streak-test].
- **Off-switch parity.** `waitStreakEnabled` in settings (default on) or
  `PROTO_FAMILIAR_WAIT_STREAK_DISABLED=1` disables recording *and* the injected line together —
  the affected prompts are required to be byte-identical to their pre-feature output when the
  experiment is off, matching the standing loop contract in
  [Autonomous loops](../architecture/autonomous-loops) (invariant W3) [@wait-streak]
  [@wait-streak-test].
- **A poisoned state file changes no outcome.** `wait-streak.js`'s exported functions never
  throw; a corrupt or missing `tomes/.wait-streak.json` reads as zero state rather than blocking
  a deliberation (invariant W5) [@wait-streak] [@wait-streak-test]. Loop test files hard-disable
  recording so `npm test` can never mutate a real install's live streak state
  [@wait-streak-test].

## Consequences

The warm reach-out, silence-triage, and Discord ambient-presence deliberations now each carry one
extra, code-built line of self-observation, and any future deliberation that offers the Familiar
an explicit wait/act choice is expected to wire into the same `recordWait`/`recordProactive`
contract rather than inventing a parallel counter [@wait-streak].

Wait-streak is deliberately not a full fix for the missing-rhythm problem — it hands over a raw
count, not a computed sense of normal-for-us. The Initiative build spec's remaining passes
(contact baselines, intentions, a noticing tick, adaptive lead times) are the planned follow-on
work, gated behind open ward decisions recorded in the spec's §10 and not yet built as of this
writing [@initiative-spec]. One ward amendment already landed ahead of those passes: budgets for
that future work are scoped per routine phase, not per day, with the daily cap kept only as a
high-set runaway backstop, so the budget shape itself nudges the Familiar toward using the
existing phases framework rather than scattering one-shot actions [@initiative-spec].

The same "hand over a bare, code-computed fact and do not steer the reading of it" discipline this
experiment established is planned to be reused for a second measurement, once the noticing-tick
pass ships: tagging every payoff/noticing turn as `triggered` or `open` and comparing their
defer/wait rates, on the theory that a significant gap between them is the armature leaking back
in — "no one asked, so waiting is the safe choice" — to be fixed by stripping that framing from
the prompt, never by nudging the model's output directly [@initiative-spec].

See [Autonomous loops](../architecture/autonomous-loops) for where the warm reach-out, silence
triage, and Discord gateway loops that consume this line sit in the wider loop system, and
[Armature](../concepts/armature) for the broader pattern of naming and structurally countering
the base model's compliance pull that this experiment is one instance of.
