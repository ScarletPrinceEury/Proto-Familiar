---
title: "Prompt-Cache-Aware Context Ordering: Static Prefix, Dynamic Depth-Injection"
topics: [decisions, architecture]
sources:
  - id: server-js
    type: file
    path: server.js
    note: "Also citing commit ceb75a5, 'Prompt-cache-aware enrichment: split static prefix from dynamic depth-injection' (2026-05-19), the commit that introduced this file's static/dynamic split — its message records the diagnosis and a measured ~90% reduction in re-billed prefix tokens."
  - id: thalamus-js
    type: file
    path: thalamus.js
  - id: architecture-doc
    type: file
    path: docs/architecture.md
  - id: engagement-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/9736413b-Temporal_core_engagementweighted_k.txt
    note: "Conversation where the maintainer, mid-testing session with Unruh, reports exhausting both ZAI and NanoGPT usage for the first time and diagnoses why: Phylactery/entity-core content sat first in the prompt and changed on most messages, so the provider's prefix cache could not preserve it."
---

# Prompt-Cache-Aware Context Ordering: Static Prefix, Dynamic Depth-Injection

**Status: decided, implemented.** `thalamus.enrich()` splits the context it injects into a
prompt into two parts with different cache lifetimes: a `static` block (base instructions plus
identity files — self, user, relationship, custom) that barely changes within a session, and a
`dynamic` block (RAG memory matches, the knowledge-graph excerpt, and `[Temporal Context]`) that
is re-derived on every turn [@thalamus-js] [@architecture-doc]. `server.js` prepends `static` to
the system message at index 0, where an upstream LLM provider's prefix cache can hit on it for
the lifetime of the session, and depth-injects `dynamic` as a separate `role: 'system'` message
`max(1, messages.length - depth)` positions from the end, so it never sits in front of the static
block and never invalidates the cache above it [@server-js]. This ordering exists because the
previous architecture concatenated identity and per-turn content into one prefix, which meant any
per-turn change silently defeated caching for the entire identity block on every single message.

## Context

The problem surfaced as a resource exhaustion, not a design review. While testing Unruh, the
maintainer ran out of usage on both of the two LLM providers in active use for the first time
ever [@engagement-conversation]. The diagnosis was that entity-core (now Phylactery) content sat
first in context and changed on most messages, so the prefix cache "can't preserve most of the
prompt" — instead of the LLM freshly ingesting roughly 20% of the prompt per turn, it was
re-ingesting roughly 80% [@engagement-conversation]. The fix proposed at the time was exactly what
shipped: keep identity and user files high in the prompt where they stay stable, and move the
memory retrievals that are expected to change into the conversation layer where their volatility
cannot contaminate the cached prefix above it [@engagement-conversation].

The commit that implemented this reconstructs the same diagnosis in its own words: "Old
architecture glued all of them into the system-message prefix, so every dynamic byte invalidated
the whole identity block. Now the static parts cache; only the dynamic slot churns" [@server-js].
It records a rough measured effect: "~90% reduction in re-billed prefix tokens per turn on long
sessions" [@server-js].

## Decision

`enrich()` returns `{ static, dynamic }` instead of one concatenated string
[@thalamus-js] [@architecture-doc]. `static` is `base_instructions.md` plus the identity files;
`dynamic` is the RAG memory matches, the knowledge-graph excerpt, and later additions that also
churn per turn ([CARE CHECK], recent ponderings, deferred intents, the surface-candidates block)
[@architecture-doc]. Empty strings on either side mean "skip that injection," so the split
degrades the same way the rest of Thalamus's peer-fanout does [@thalamus-js].

`server.js` applies the split in two steps, and the order matters: the static prepend runs first,
against the caller's original `messages` array, and the dynamic depth-injection is computed
*after* it, so the depth index counts the (possibly newly created) system message the static step
may have added [@server-js]. The dynamic block lands at `max(1, messages.length - depth)`, never
at index 0 — the `max(1, …)` clamp is what keeps a large configured depth or a short conversation
from ever pushing the dynamic block above the static prefix, which would silently reproduce the
original bug [@server-js]. The depth is a server setting (`thalamusDynamicDepth`, default 4, range
1–50) rather than a hardcoded constant, so a ward can tune how deep in the conversation dynamic
content surfaces without touching code [@architecture-doc].

## Consequences

The cache boundary is now a load-bearing architectural line, not an implementation detail: any
future content that changes per turn must go into `dynamic`, and anything added to `static` is
implicitly promising it will not change within a session. Getting this wrong reintroduces the
original failure mode invisibly — a single per-turn-varying string placed back into the static
block would quietly defeat caching for everything after it, with no error and no test failure
short of a token-cost regression. The Tomes system independently converges on the same rule: a
later change ("Tomes: keep non-constant entries out of the cacheable prefix") keeps non-constant
Tome entries out of the same cacheable region, and `server.js`'s own comment on that class of entry
notes they are placed at depth "not a system-message position — these keyword-triggered entries
would invalidate the prompt prefix cache if injected into it," citing this same rationale
[@server-js].

This is also why [Unruh](../architecture/unruh) and [Phylactery](../architecture/phylactery) are
fanned out and awaited together inside `enrich()` rather than injected independently by each
specialist: one call site owns the static/dynamic split, so no future specialist can bypass it by
writing its own content directly into the prompt.

## Related

- [Architecture](../architecture) — where Thalamus's `enrich()` and the `{ static, dynamic }`
  return shape are introduced at the system level.
- [Unruh](../architecture/unruh) — one of the two specialists whose output is split across the
  static/dynamic boundary this decision defines.
- [Phylactery](../architecture/phylactery) — the other specialist, and the source of the identity
  files that make up the static block.
- [Exact values are code's job](exact-values-in-code) — a different instance of the same broader
  pattern of keeping a specific, narrow contract rather than trusting ad hoc placement.
