---
title: "Voluntary and Autonomic Lanes in Cerebellum"
topics: [decisions, architecture, safety]
sources:
  - id: fable-review-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/2acdb806-Welcome_to_Claude.txt
    note: "Wide-ranging review conversation with Claude Fable 5 in which the maintainer worked out a proposed consent framework for cerebellum's dispatcher, alongside the cerebellum-naming reasoning and the OpenClaw migration."
  - id: cerebellum-js
    type: file
    path: cerebellum.js
---

# Voluntary and Autonomic Lanes in Cerebellum

**Status: proposed, not yet implemented.** This page records a consent framework the maintainer
worked out for [cerebellum](../architecture)'s dispatcher, in the same conversation that
produced [Cerebellum's naming reasoning](cerebellum-naming). It explains, in general terms, why
cerebellum already applies different rules to different kinds of writes, and it proposes a
second distinction — not yet built — for a class of feature the project does not have yet:
continuous, autonomic rendering of the Familiar's own internal state to the outside world.
Reading `cerebellum.js` directly turns up no code or comments implementing either distinction
by name; both remain conceptual [@cerebellum-js].

## The self-directed / world-directed axis behind the write rule

[Multi-embodiment](../concepts/multi-embodiment) and [Architecture](../architecture) already
document a rule without fully explaining its reasoning: cerebellum never opens its own MCP
connection, and every write to identity, memory, or temporal state rides one of thalamus's
exported wrapper functions, while outbound effects that reach a person — a chat reply, a
trusted-contact ping, a Discord message — go through cerebellum's own delivery layer with its
own separate invariants (no covert contact, outbox mirroring, described in
[Safety spine](../architecture/safety-spine)). The proposed explanation for why these two kinds
of write get different consent regimes from the same dispatcher is an axis: a write to
[Phylactery](../architecture/phylactery) or [Unruh](../architecture/unruh) is **self-directed** —
it changes what the Familiar itself knows or remembers, so its integrity rules are about
correctness and provenance (snapshot before write, one enforcement point). A write that reaches
a person is **world-directed** — it changes what a human perceives, so its rules are about
visibility and consent (nothing reaches a person the ward cannot also see) [@fable-review-conversation].
The rule already shipped; this axis is the reasoning for why it has the shape it does, not a
change to the rule itself.

## The voluntary / autonomic lane, proposed for future world-directed features

Within the world-directed side specifically, the conversation proposes a second distinction for
features the project does not yet have: **voluntary** actions are commanded — deliberate,
dispatched from a chat turn or from silence-triage's deliberation, and carrying the full consent
invariants above. **Autonomic** rendering would be a continuous display of existing internal
state with no decision point in the loop at all — the worked example is a hypothetical mood
indicator that reflects the Familiar's current state passively, the way a face shows an
expression without deciding to [@fable-review-conversation].

The governing invariant proposed for this lane, stated in the conversation as "reflexes may
express, never address": the autonomic lane may render the Familiar's internal state outward,
but it must never be the thing that initiates contact with a person
[@fable-review-conversation]. The reasoning is a direct callback to a specific incident from
Eury's prior OpenClaw harness: a malformed response from OpenClaw's "Dreaming" function, with no
retry cap, produced 400 autonomous outbound requests in a single day while the maintainer was
away [@fable-review-conversation]. State fluctuation driving outbound traffic with no judgment
in the loop is exactly what that incident was — the autonomic-lane invariant is proposed
specifically so a future continuous-state-display feature cannot recreate the same failure mode
with better production values.

## Why this matters before the feature exists

No feature matching "autonomic rendering" is shipped yet, so this page documents intent rather
than a contract in force. Its value is for whoever builds the first one: a presence indicator, a
mood badge, or any surface that continuously reflects Familiar-side state needs to be built so
that state change alone can never fire an outbound send. Only a voluntary-lane dispatch — a chat
turn, an autonomous loop's own judgment call, silence-triage's deliberation — may initiate
contact with a person. This generalizes the same principle [Safety spine](../architecture/safety-spine)
already enforces for escalation (the decision to reach out always goes through an LLM reading
context, never a bare threshold) to any future feature that renders state outward.

## Related

- [Cerebellum's naming reasoning](cerebellum-naming) — the same conversation's reasoning for why
  cerebellum's own name commits it to executing rather than originating decisions.
- [Multi-embodiment](../concepts/multi-embodiment) — the shipped rule (writes to identity/memory
  route through thalamus's wrappers) that the self-directed side of this axis explains.
- [Safety spine](../architecture/safety-spine) — the shipped no-covert-contact and escalation
  rules that are the existing, shipped instance of "judgment must be in the loop before contact."
- [Architecture](../architecture) — cerebellum's current shipped responsibilities and its strict
  boundary with thalamus.
