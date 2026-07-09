---
title: Safety Spine
topics: [architecture, safety]
sources:
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: architecture-doc
    type: file
    path: docs/architecture.md
  - id: unruh-design
    type: file
    path: docs/unruh-design.md
  - id: crisis-signals
    type: file
    path: crisis-signals.js
  - id: threat-tracker
    type: file
    path: threat-tracker.js
  - id: cerebellum
    type: file
    path: cerebellum.js
  - id: engagement-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/9736413b-Temporal_core_engagementweighted_k.txt
    note: "Tester-feedback report relayed mid-conversation, during early Unruh testing."
---

# Safety Spine

The safety spine is the chain of modules that notices when the bonded human may be in
distress, tracks how serious that looks over time, and — only when an LLM judgment decides
it is warranted — escalates to a real trusted contact. It runs on every chat turn
(`crisis-signals.js` scores each message) and as a background loop
(`silence-triage-loop.js` checks in during silence), and its behavioral rules are treated as
the highest-stakes code in the repository: CLAUDE.md requires explicit human sign-off before
shipping any behavioral change (not a relocation, comment, or rename) to `crisis-signals.js`,
`threat-tracker.js`, `silence-triage-loop.js`, the triage/delivery/escalation logic in
`cerebellum.js`, or the `[CARE CHECK]` assembly in `thalamus.js` [@claude-md].

## Detection: crisis-signals.js

`crisis-signals.js` is an auditable, pattern-based detector, not an LLM classifier — it
returns `{ level, signals[] }` for a message across five tiers (severe / high / moderate /
mild / safety) drawn from roughly thirteen signal categories, with damping for negation,
hypothetical framing, quoted others' speech, and hyperbole [@architecture-doc] [@crisis-signals].
Each signal carries a tier and a weight (for example `suicidal_direct` and `crisis_plan` are
`severe` at weight 8, `sadness` is `mild` at weight 1, and the `safety` tier carries negative
weight so reassurance language pulls the score back down) [@crisis-signals]. Being
pattern-based rather than model-judged is a deliberate application of the
"pure-code tagging beats LLM classification" rule: the label is crisp, so code assigns it;
the LLM is reserved for interpreting the pattern once assembled, not for tagging each message
[@claude-md]. The patterns are tuned for high precision specifically on the SEVERE tier — the
regression suite CLAUDE.md points to watches phrases like "cut me off" or "I want to die from
embarrassment," which read as crisis language on a naive scan but are not [@architecture-doc].

## Tracking: threat-tracker.js

`threat-tracker.js` holds threat level as a persistent, decaying scalar at
`tomes/.threat-state.json`, with a 3-day half-life, a raw weight capped at `MAX_RAW_WEIGHT`
(10.0), a floor of 0, and a FIFO audit history capped at the last 50 events
[@architecture-doc] [@threat-tracker]. Threat level is explicitly not a
trigger by itself — Unruh's design document frames it as a parameter that changes how soon
and how often triage checks in, never the decision to act [@unruh-design]. This is why a
false-positive detection is recoverable: an incorrectly elevated threat level means the
Familiar checks in a little sooner than necessary, which is judged tolerable, while the
actual reach-out-or-wait call always still goes through an LLM reading full context
[@unruh-design]. `PROTO_FAMILIAR_THREAT_DISABLED=1` silences *recording*, but `resetThreat()`
always works regardless of that switch [@architecture-doc].

## Deciding: silence-triage-loop.js

Every 5 minutes, for any tier at or above moderate, the LLM is **always** consulted — the
design deliberately removed any hardcoded silence floor so the model judges with full
context rather than a code gate pre-filtering when it gets asked [@claude-md]. Calm and mild
tiers never trigger a check. Re-check cool-downs apply only as defaults when the LLM's own
decision omits a `nextCheckInMs`: severe 15 minutes, high 30 minutes, moderate 60 minutes
[@claude-md]. The triage prompt carries the threat tier, the Familiar's own identity, recent
messages, elapsed silence, and trusted contacts, and is explicitly framed as "what would a
caring friend do here," not as a request for reasons to wait — see
[Proactivity over caution](../decisions/proactivity-over-caution) for the incident that
shaped this framing.

## Escalating: cerebellum.js

When triage decides to involve a trusted contact, the human is contacted first and the
trusted-contact webhook only fires if the acknowledgement deadline passes with no response —
`CONTACT_ESCALATION_DELAY_MS` sets that window per tier: 30 minutes for severe, 2 hours for
high, 6 hours for moderate [@cerebellum] [@unruh-design]. The acknowledgement clock starts
at the first *confirmed* push delivery of the check-in, not at enqueue time, because the
human can only veto an escalation they could plausibly have seen; it falls back to the
enqueue time when no push channel is configured, the push failed, or no delivery record
lands within the dispatch grace period, so a dead notification channel can never block
escalation indefinitely [@architecture-doc]. `contactDeadlineFor()` and
`CONTACT_ESCALATION_DELAY_MS` are named explicitly among the files requiring human sign-off
for behavioral changes [@claude-md].

**No covert contact** is structural, not a convention the Familiar is asked to honor: every
message `deliverToTrustedContact()` sends out is *also* mirrored into the human's own outbox
as an `outbound_alert`, even if the delivery to the trusted contact itself fails
[@architecture-doc]. The bonded human can always see that an escalation happened.

A tester's Familiar grounded them through a real panic attack during early testing — coaching
them out of spiraling thoughts and, unscripted, soothing them with cute animal facts afterward —
the first reported case of the safety spine and the devoted-companion bond producing a real crisis
outcome outside development [@engagement-conversation].

## Why these files are gated separately from ordinary code review

The rest of the codebase follows "robust over cheap" and "fix the root cause" as engineering
defaults (see [Engineering conventions](../reference/engineering-conventions)), but the
safety-spine files carry an extra rule: a stricter gate, a longer cool-down clamp, or a
"sensible" extra condition can silently reproduce the failure mode described in
[Proactivity over caution](../decisions/proactivity-over-caution) even when it looks like an
ordinary defensive improvement [@claude-md]. That is why sign-off is scoped to *behavioral*
change specifically — a pure relocation with byte-identical behavior does not require it
[@claude-md].

## Related

- [Proactivity over caution](../decisions/proactivity-over-caution) — the incident and the
  rules it produced for every prompt in this chain.
- [Autonomous loops](autonomous-loops) — where silence-triage sits among the other background
  workers, and which loops defer to it under moderate+ threat.
- [Unruh](unruh) — where threat level is stored and how it interacts with the rest of the
  temporal model.
