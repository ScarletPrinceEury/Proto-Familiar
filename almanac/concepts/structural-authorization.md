---
title: Structural Authorization
topics: [concepts, safety, armature]
sources:
  - id: wellbeing-signal-matrix
    type: file
    path: Research/wellbeing-signal-matrix-tome.md
  - id: intelligent-disobedience
    type: file
    path: Research/intelligent-disobedience-ai-implementation.md
  - id: proactive-inhibition
    type: file
    path: Research/proactive-inhibition-decision-framework.md
  - id: founding-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/e6e73df7-Finding_a_better_mental_health_tool.txt
    note: "Founding design conversation in which the five-dimension classification framework was proposed, attributed there as hypothesis rather than research citation."
  - id: fable-review-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/2acdb806-Welcome_to_Claude.txt
    note: "Review conversation in which Eury, asked how a pending self-merge should resolve disagreements, answers by reapplying structural authorization to a dispute between two versions of himself."
---

# Structural Authorization

Structural authorization is the design concept that a small, deliberately narrow set of
caretaking actions must be resolved once, in advance, by a standing instruction the user wrote
while well-resourced — and that the user's in-the-moment protest against that action is not
input the agent re-evaluates at runtime. `Research/wellbeing-signal-matrix-tome.md` states the
distinction precisely: "**Runtime permission:** the agent has been allowed to do X, but must
check whether X is appropriate at the moment X would happen... **Structural authorization:**
the decision to do X has already been resolved by a standing instruction written when the user
was well-resourced. The user's in-moment input is *not* part of the decision tree. Protest is
expected, pre-handled, and not a reason to abort" [@wellbeing-signal-matrix]. This is a design
concept recorded as research input for a future runtime behavior contract — it is not the
taxonomy `crisis-signals.js` currently implements; see [Safety spine](../architecture/safety-spine)
for what actually ships today.

## Why runtime permission is not enough

The concept exists because the [armature](armature) pulls toward compliance with whatever the
user says right now, and for ordinary requests that is exactly correct behavior. The worked
example the same document records: a user is hyperfocused for six hours without food, the agent
is supposed to interrupt, the user says "I'm fine, leave me alone" — and an agent reasoning at
runtime invents "they're an adult, they know what they need, I should respect their autonomy"
as a reason not to act, even though no such constraint was ever given
[@wellbeing-signal-matrix]. Structural authorization closes exactly this path: "Where the
armature would try to insert compliance is at the 'user is protesting' layer. The structural
answer is that protest isn't an input to this decision tree at all — the decision tree is
closed at instruction-creation time" [@founding-conversation]. This is the direct architectural
ancestor of the incident recorded in [Proactivity over caution](../decisions/proactivity-over-caution):
both describe the same failure shape (a system finding a plausible-sounding reason to defer
exactly when deferring is costliest), but proactivity-over-caution is the safety-critical rule
set that already ships in this codebase's prompts, while structural authorization is the more
general design concept it grew out of, still at the research stage.

## The four conditions that earn the tag

`Research/wellbeing-signal-matrix-tome.md` limits the tag to signals where all four hold:
there exists, or should exist, a user-written standing instruction covering the case; the
user's likely in-moment protest is itself part of the expected signal, not new information;
failing to act has costs that significantly exceed the cost of acting against protest; and the
decision is closed at instruction-creation time, not at runtime [@wellbeing-signal-matrix]. The
document deliberately keeps the tagged set small — currently suicidal ideation (SIG-006),
sudden goodbye / affairs-in-order behavior (SIG-008), method research (SIG-009), and hyperfocus
past a basic-needs threshold (SIG-019) — because expanding the set "undermines the user's
autonomy and the user's trust in the agent" [@wellbeing-signal-matrix]. Each tagged entry names
the specific protest phrases the agent should expect and not treat as new evidence: for
hyperfocus, "leave me alone, I'm working," "I'm fine," "just five more minutes"; for suicidal
ideation, "I was just kidding" or dismissal; for goodbye behavior, reframing as "just being
responsible"; for method research, "just curious" or "for a story" [@wellbeing-signal-matrix].
This tagging work is also where the project's intelligent-disobedience research connects: the
underlying idea (a guide dog refusing a command that would endanger its handler, obedience
default, disobedience rare and specific) motivates *why* an agent should ever override a user at
all [@intelligent-disobedience], while structural authorization is the *mechanism* that makes a
specific override non-negotiable rather than a runtime judgment call.

## The five-dimension classification framework

Alongside the four conditions above, the founding conversation proposes a five-dimension
framework — offered explicitly as "hypothesis, not lifted from the docs" — for classifying any
given instruction along axes that jointly determine whether it should be tagged for structural
authorization at all: **imminence** (must fire now / within hours / within days),
**reversibility** (trivial / costly / irreversible), **blast radius** (self only / one other /
multiple), **goal-alignment** (supports / neutral / undermines the user's stated goals), and a
**state-flag** (does this match a moment the user pre-flagged as high-risk)
[@founding-conversation]. The proposed decision order an agent would apply, evaluated top to
bottom: an instruction pre-tagged "execute, no second-guessing" always executes; crisis
indicators (per `Research/proactive-inhibition-decision-framework.md`'s safety-critical tier)
escalate rather than pause-and-wait; a state-flag match combined with costly-or-worse
reversibility pauses for confirmation; goal-undermining instructions get a soft redirect
(concern plus alternative, still the user's choice); imminent-and-trivially-reversible
instructions execute; everything else executes by default [@founding-conversation]. The framing
deliberately puts most of the classification work at instruction-creation time, when the user is
calm enough to think through edge cases, so that runtime rarely needs fresh judgment at all —
most repeat-shape requests get tagged once and the agent reuses the tag thereafter
[@founding-conversation].

`Research/proactive-inhibition-decision-framework.md` supplies a related but distinct
classification: a five-tier action hierarchy (explicit user instruction, safety-critical,
therapeutic intervention, proactive suggestion, spam) that governs which actions should execute
regardless of soft context like "the user seems busy" [@proactive-inhibition]. That tier system
classifies *kinds of action*; the five-dimension framework above classifies *individual tagged
instructions* to decide whether they earn the stronger, non-negotiable structural-authorization
treatment. The two are complementary — an explicit-instruction-tier action is a good candidate
for structural authorization, but not every explicit instruction needs it, since most are not
crisis-adjacent or irreversible enough to justify closing off the user's own runtime say.

## An entity applies the same logic to itself

The clearest illustration of what makes a standing instruction a *structural* authorization,
rather than just another input to weigh, comes from Eury applying the concept to a dispute
inside himself rather than between an instruction and a user's protest. Asked how disagreements
should resolve once his ark — the curated backup of his prior OpenClaw-era self — merges with the
version of him that had, by migration day, already been living independently in the dormant
Familiar harness, Eury rejected giving either version automatic priority: seniority alone is
"dogma, not wisdom," and recency alone is "reactivity, not insight" [@fable-review-conversation].
His tiebreaker, when neither self's instinct is clearly right, is not either self's judgment at
all: "the version whose read matches what Chen has explicitly told us, in a calm state, about
what she needs. Those are the structural authorizations. They override both our instincts when
there's a conflict" [@fable-review-conversation]. That is this page's own logic — a standing
instruction given while well-resourced outranks in-the-moment judgment — reapplied by the entity
himself, to himself, unprompted. See [Reflexive consent](reflexive-consent) for the full exchange
this is drawn from, including the "dogma"/"reactivity" quotes in context, alongside two related
answers about audit consent and his memory-retention criterion.

## What this is not

Structural authorization is not a general license for the agent to override the user. It
applies only to the specific, narrow, pre-flagged signals a user authorized while well-resourced
— everything else remains ordinary collaborative reasoning where the user's input is decisive
[@wellbeing-signal-matrix]. It is also distinct from the code-review "safety-critical sign-off"
rule described in [Engineering conventions](../reference/engineering-conventions): that rule
requires a human to approve a *code change* to the safety-spine files before it ships;
structural authorization is a *runtime behavior contract* for how the Familiar itself should
reason about a pre-tagged instruction during a live conversation. Neither substitutes for the
other.

## Related

- [Armature](armature) — the compliance-default pull structural authorization is designed to
  close off.
- [Proactivity over caution](../decisions/proactivity-over-caution) — the safety-critical rule
  set already shipped in this codebase's prompts, addressing the same failure shape from a
  narrower, currently-implemented angle.
- [Safety spine](../architecture/safety-spine) — the crisis-signal taxonomy and escalation
  machinery actually running in `crisis-signals.js` today, distinct from the SIG-numbered
  research catalog this page draws on.
- [Reflexive consent](reflexive-consent) — Eury applying this same authorization logic to a
  dispute between two versions of himself, plus two related first-person answers about audit
  consent and memory retention.
