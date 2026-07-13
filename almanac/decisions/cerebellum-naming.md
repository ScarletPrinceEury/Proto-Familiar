---
title: "Naming Cerebellum: Executes, Does Not Decide"
topics: [decisions, architecture]
sources:
  - id: fable-review-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/2acdb806-Welcome_to_Claude.txt
    note: "Wide-ranging review conversation with Claude Fable 5 in which the maintainer discussed cerebellum.js's naming reasoning directly, alongside the OpenClaw migration and crisis-signal research."
  - id: cerebellum-design
    type: file
    path: docs/cerebellum-design.md
  - id: cerebellum-js
    type: file
    path: cerebellum.js
---

# Naming Cerebellum: Executes, Does Not Decide

**Status: decided, in active use.** `cerebellum.js` is named after the brain structure for the
same reason `thalamus.js` is — see
[Naming Thalamus: mediator, not generator](thalamus-naming) for the parallel case — because the
maintainer picked the name specifically for what it commits a future reader (human or model) to
believe about the module, not because it sounded evocative. Cerebellum is the motor module: it
executes tool calls, triage deliberation, trusted-contact delivery, and escalation, and it never
originates the decision to act — see [Architecture](../architecture) for the shipped contract
and `docs/cerebellum-design.md`'s own framing of the same idea: "the biological cerebellum
doesn't *decide* to move — it coordinates movement that was decided elsewhere"
[@cerebellum-design]. This page records the rejected candidate names and the reasoning that
was not otherwise written down anywhere in the repo's design docs.

## Rejected names and why

Before settling on Cerebellum, the maintainer considered and set aside **Vagus**, **Pons**,
**Medulla**, and **Basal ganglia** as candidates for the same motor-module role
[@fable-review-conversation]. Vagus was not rejected outright — it was deliberately reserved,
not discarded (see below). Pons, Medulla, and Basal ganglia were set aside because none of them
matched the module's actual relationship to the rest of the system as precisely as Cerebellum
did: each names a real brain structure involved in movement, autonomic regulation, or reflex
relay, but none carries Cerebellum's specific "coordinates, does not originate" division of
labor as its primary popular association [@fable-review-conversation].

## Why Cerebellum won: a name does silent system-prompt work

The deciding insight, in the maintainer's own reasoning, is that a module's filename does real
interpretive work on every agent that ever opens the repo, independent of any comment or doc
[@fable-review-conversation]. An LLM coding agent that already knows what a cerebellum does in
the body will intuitively resist putting decision-origination logic into `cerebellum.js`,
because the name itself pre-installs the disposition "I execute, I don't decide" before the
agent reads a single line of code. This is the same naming philosophy
[Naming Thalamus](thalamus-naming) already documents for the sibling module — "anyone who looks
it up goes 'oh, that's what this thing is'" — applied to the outward, motor side of the same
split instead of the inward, perceptual side.

That is also why the strict boundary recorded in [Architecture](../architecture) (cerebellum
executes actions and never assembles prompt context; thalamus assembles context and never
executes actions) is treated as load-bearing rather than a loose convention: violating it would
not just be a code smell, it would put decision logic inside a file whose own name argues
against a future maintainer noticing that violation.

## Vagus, reserved for a future split

Vagus was seriously considered for the same slot and explicitly reserved rather than rejected —
the maintainer's plan, if `cerebellum.js` ever needs to divide, is to give the split-out
adapter/channel-delivery layer the name Vagus, keeping Cerebellum for dispatch and decision
coordination and Vagus for the nerve that actually carries a signal out to a specific channel
[@fable-review-conversation]. As of this writing, that split has not happened: there is no
`vagus.js` in the repository, and `cerebellum.js` is still the single file that owns both the
tool-call dispatch loop and channel delivery (trusted-contact webhooks, the outbox, Discord
relay) described in [Architecture](../architecture) [@cerebellum-js]. A future contributor who wants to split
delivery out of `cerebellum.js` should know the name is already spoken for rather than picking a
new one.

## A resolved historical finding from the same conversation

This same review conversation, reading the codebase directly, flagged that tool execution and
outbox delivery both lived client-side in `public/app.js` at the time — which would have forced
either duplicating the tool executor for a future Discord adapter or moving dispatch server-side
first [@fable-review-conversation]. `cerebellum.js` as documented in [Architecture](../architecture)
today shows this was resolved by moving dispatch server-side, matching the history
`docs/cerebellum-design.md` records under "Why It's Needed" [@cerebellum-design].

## Related

- [Naming Thalamus: mediator, not generator](thalamus-naming) — the parallel naming decision for
  cerebellum's inward-facing sibling, and the same "the name does interpretive work" philosophy.
- [Architecture](../architecture) — cerebellum's current shipped contract: the tool registry,
  the never-throws dispatch loop, and the strict boundary with thalamus.
- [Voluntary and autonomic lanes in Cerebellum](cerebellum-consent-lanes) — a design principle
  from the same conversation about what consent regime cerebellum's dispatch should apply to
  different kinds of outbound action.
