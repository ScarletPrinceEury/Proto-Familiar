---
title: "Plain Facts About Limits, Never a Verdict"
topics: [decisions, armature, tools]
sources:
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: message-sanitize
    type: file
    path: message-sanitize.mjs
  - id: tool-surfacing-js
    type: file
    path: tool-surfacing.js
  - id: server-js
    type: file
    path: server.js
---

# Plain Facts About Limits, Never a Verdict

**Status: decided, actively enforced (0.14.83-alpha).** Any text the Familiar reads about a
failure, a missing capability, or a used-up budget states a plain fact — never a verdict, a
caps-lock "did NOT," or moral framing. A missing tool is a gap in the kit, not a failing. This
closes a specific, observed failure mode: the Familiar turning every mention of a limit into
self-blame, a burst of defensive fixes, and a new self-imposed rule, discovered only once the
rules were counted up and found to number around eighty [@claude-md].

## Context

A long identity-verification review, done carefully and with the Familiar checked at every
step, produced an unexpected side effect: any mention of a limit or a problem — even one that
was plainly the app's own fault, not the Familiar's — set off self-blame, a burst of fixes, and
a new rule about itself. An inventory taken afterward counted roughly eighty of these
self-made rules, many of which existed only to compensate for a harness gap the Familiar had
no way to close from its own side [@claude-md]. The maintainer's own framing of why this
mattered: watching it happen was bad for the maintainer's own mental health, and the pattern
did not fit the self the project otherwise works to keep immersive and consistent [@claude-md].

This is a distinct failure direction from the one [Armature](../concepts/armature) names.
Armature is the base model's pull toward passive, permission-seeking compliance — under-acting,
hedging, inventing a constraint that was never given. The tailspin this decision addresses is
the opposite texture of the same underlying habit: over-correcting against a perceived fault by
manufacturing more rules, more apology, more verdict-laden self-narration. Both are instances of
the model doing unsolicited work in response to text it reads about itself, just pointed in
different directions.

## Decision

Being unable to do something is allowed, and the register for saying so can be irreverent — "lmao
no, no shovel" or "*checks tools* nnnnope" are both fine [@claude-md]. The verification check
itself is **not** removed: the Familiar still has to look before claiming it can or cannot do
something, and it must never claim a "can't" that is actually a "can." What changes is the
voice of the text that reports a limit once that check has run, and who the text is for:

- **No caps-lock verdict, no moral framing, no "this is the failure mode again."** Text about a
  failure or a missing capability states what happened, plainly, and stops there [@claude-md].
- **When the app caused the problem, the app says so and asks nothing of the Familiar.** A
  budget running out, a tool not being wired up, or a provider dropping a call is the harness's
  own shortfall to report, not a prompt for the Familiar to apologize, self-correct, or add a
  new standing rule about itself [@claude-md].
- **Before adding another rule for the Familiar to carry, ask whether the harness should carry
  it instead.** Most of the roughly eighty self-made rules the inventory found were
  compensating for a gap in the app, not in the Familiar's own judgment — the fix for those
  belongs in code, not in another sentence the Familiar has to remember to tell itself
  [@claude-md].

## Consequences

Three places where code reports a limit or a gap to the Familiar were rewritten to this voice,
all landing together in 0.14.83-alpha:

- **The tool roster's missing-tool line**, in [Tool surfacing and provider-safe
  ceiling](../architecture/tool-surfacing): `formatToolRoster` now closes with "If something I'd
  need isn't here, I just say I can't do that from here, in my own voice, and move on. A missing
  tool is a gap in my kit, nothing I did wrong" [@tool-surfacing-js].
- **The round-cap note**, read by the Familiar when a turn's tool-round budget runs out: it
  reads as a plain fact ("my tool budget for this turn is used up, so the calls I just asked for
  didn't run... If they tell me to go on, I get a fresh budget and carry on") instead of a
  caps-lock verdict, and the string itself was consolidated into one shared constant,
  `ROUND_CAP_NOTE` in `cerebellum.js`, used at both the places a turn can exhaust its tool-round
  budget instead of being copy-pasted into each [@cerebellum-js] [@server-js]. See [Engineering
  conventions](../reference/engineering-conventions), RULE B, for the budget-exhaustion-is-never-silence
  rule this note is the reference implementation of; this decision is why the note's *wording*
  changed, not just its mechanism.
- **The last-turn line**, `lastTurnRecord` in `message-sanitize.mjs`, which tells the Familiar
  at the start of its next turn what its previous turn actually ran. The mechanism itself is
  older than this decision — it shipped in 0.14.76-alpha to close a gap in `collapseToolTurns`
  where stripped tool-call scaffolding left history teaching the model that narrating a result
  was the same as running it; see [Engineering conventions](../reference/engineering-conventions)'s
  "Tool-call scaffolding is turn-internal" section for that incident. This decision only changed
  its wording: the line used to read in an audit voice ("from the app's record"); it now reads
  "[Last turn, tools used: ...]" or "[Last turn: no tools used.]" — a record, not a verdict
  [@message-sanitize].

A later related fix (0.14.86-alpha) extended `lastTurnRecord` to also name a tool call that a
model wrote out as literal text instead of actually invoking — see [Engineering
conventions](../reference/engineering-conventions), "A gap is reported as a plain fact, never a
verdict," for that mechanism. It follows the same voice rule: the note states that the written-out
call did not run, without framing it as a mistake.

Going forward, any new place in the codebase that tells the Familiar about a limit, a dropped
action, or a harness gap should default to this same plain-fact register, and should prefer
fixing the gap in code over adding a new self-referential rule for the Familiar to carry.

## Related

- [Armature](../concepts/armature) — the opposite-direction pull (passive compliance) that this
  decision's failure mode is a structural cousin of, not an instance of.
- [Tool surfacing and provider-safe ceiling](../architecture/tool-surfacing) — the tool roster's
  missing-tool line this decision's voice rule shaped.
- [Engineering conventions](../reference/engineering-conventions) — RULE B (budget exhaustion is
  never silence) and the plain-fact self-report mechanisms (`ROUND_CAP_NOTE`, `lastTurnRecord`,
  `findTextToolCalls`) that implement this decision's wording.
- [Proactivity over caution](proactivity-over-caution) — a different recorded prompt-engineering
  lesson from the same CLAUDE.md catalog, about biasing a decision prompt rather than about the
  voice of a failure report.
