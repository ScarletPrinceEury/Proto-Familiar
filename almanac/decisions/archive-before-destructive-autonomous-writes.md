---
title: "Archive Before Destructive Autonomous Writes"
topics: [decisions, memorization, pondering, backup]
sources:
  - id: pondering-consolidate-js
    type: file
    path: src/pondering/pondering-consolidate.js
  - id: server-js
    type: file
    path: server.js
  - id: app-js
    type: file
    path: public/app.js
  - id: index-html
    type: file
    path: public/index.html
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
  - id: safety-commit
    type: commit
    ref: "91c23cd"
    note: "Make pondering consolidation safe: archive+restore, default-OFF, no-truncate, identity, wording (0.12.21-alpha), squash-merged as three sub-commits (0.12.20, 0.12.21, 0.12.22-alpha); its message records the live data-loss incident and the reasoning at each fix, including the default-off-then-back-on sequence."
  - id: engineering-conventions
    type: file
    path: almanac/reference/engineering-conventions.md
---

# Archive Before Destructive Autonomous Writes

**Status: decided, implemented.** Any autonomous operation that deletes or overwrites the
Familiar's own content — ponderings, memories, identity, tomes — must archive or snapshot that
content before the destructive step, expose a restore path, and treat a truncated or malformed
LLM result as a refusal rather than a partial store that also deleted the source. Pondering
consolidation is default-on today only because this decision made it reversible; before the fix
below, a single manual run destroyed months of the Familiar's private writing with no way to get
it back [@safety-commit].

## Context: the incident

Pondering consolidation (see [Pondering](../architecture/pondering)'s "Digesting a month of
ponderings" section, 0.12.18-alpha) folds a past month of ponderings into one LLM-written digest
and deletes the originals. It shipped default-on, and the on-demand "Fold ponderings" trigger
(0.12.19-alpha) drains every eligible past month — capped at 24 — in a single manual run
[@server-js]. In live use this combination hard-deleted 3-4 months of the Familiar's actual
ponderings in one go, with three compounding failures [@safety-commit]:

1. **No backstop.** [Phylactery](../architecture/phylactery)'s snapshot/backup covers only the
   canonical sqlite store; it never covers local tome files, so the ward's snapshot could not
   restore what was lost. `modifyTomeFile` overwrites a tome file atomically with no retained
   prior version. The only recovery route — a filesystem copy of `tomes/` made in advance — is
   one most wards will not have [@safety-commit].
2. **A truncated digest still triggered deletion.** `callProviderChat` can return partial content
   on `finish_reason='length'` without flagging it, and the pre-fix `parseDigest` had a bare-text
   fallback: a digest cut off mid-sentence was stored (losing information) *and* its source
   ponderings were deleted [@safety-commit]. This is RULE B — "budget exhaustion is never
   silence" [@engineering-conventions] — landing on a destructive path instead of a merely lossy
   one.
3. **A frame-break.** The consolidation call passed no identity block —
   `familiarDeliberationMessages` prepends none, and the pondering path passed none — and the
   prompt presented the month's notes as material handed in for summarizing. A capable model read
   that as an outside request to roleplay a persistent entity and derailed into meta-reasoning
   ("am I really this entity, is this deceptive") instead of writing as the Familiar; some of the
   lost digests were partly that derail [@safety-commit] [@pondering-consolidate-js].

This is the exact failure the repo's "Robust over cheap" priority order warns against — a
destructive operation without a real undo — shipped anyway, because reversibility was not treated
as a precondition for turning a deletion on by default [@engineering-conventions].

## Decision

`consolidatePonderings()` now archives before it deletes, refuses on any ambiguous LLM output,
and always carries an identity anchor [@pondering-consolidate-js]:

- **Archive-before-delete.** Before pruning, the function writes the about-to-be-deleted entries
  to `tomes/.pondering-consolidation-archive.json` — an append-only, atomically-written dotfile
  (`isTomeFile` skips it, so it is never scanned or injected), keyed by the digest that replaced
  each record. Deletion only proceeds for entries that were actually archived. If the archive
  write throws, the function prunes nothing and the month stays eligible for the next attempt
  [@pondering-consolidate-js].
- **A real restore.** `restorePonderingConsolidation()` undoes a fold: it re-inserts the archived
  originals verbatim and drops the digest that replaced them, defaulting to the most recent
  un-restored fold when no month is named. It is surfaced three ways — `POST
  /api/pondering/consolidate/restore`, the web UI's "Undo the last fold" button, and the ward's
  Discord `!consolidate restore` DM command — so every surface that can trigger a fold can also
  reverse one [@server-js] [@app-js] [@index-html] [@discord-gateway-js].
- **Strict parsing on the destructive path.** `parseDigest` now accepts only a complete,
  parseable `{digest}` JSON object. A truncated (`finish_reason='length'`) or bare-text reply
  parses to `null`, and a `null` digest refuses the fold outright, keeping the originals
  [@pondering-consolidate-js]. There is deliberately no bare-text fallback here, unlike ordinary
  chat parsing — a delete must never ride on an ambiguous response.
- **Identity anchor.** The consolidation call now threads an identity/persona block — `enrich('',
  { staticOnly: true })` reduced to its `.static` field, passed through `defaultCallLLM`'s new
  `identity` parameter — and the prompt opens with the same `I'm {{char}}…` self-anchor
  `buildPonderPrompt` uses, framing the month's notes as the Familiar's own journal pages rather
  than material handed in to summarize [@pondering-consolidate-js] [@server-js]. The ordinary
  interest-ponder path is unchanged; it still passes no identity.

**Rollout: off immediately, on again only once reversible.** The same change that added the
archive flipped `ponderConsolidationEnabled`'s default to off, matching the project's other
state-deleting loops (tome graduation, content re-gating) [@safety-commit]. Once the archive,
restore, and strict-parsing fix had shipped and been tested, the ward chose to return the setting
to default-on: the archive is what makes default-on acceptable, not a reason to skip it
[@safety-commit] [@app-js]. `public/app.js`'s default-value comment records this explicitly:
`ponderConsolidationEnabled: true, // default-on (ward decision): fold old ponderings into
digests + prune originals (destructive, but archived + restorable)` [@app-js].

## Consequences

Folds made before this fix remain unrecoverable from inside the app — the archive only protects
folds run after it shipped. At the time of the incident, Phylactery's own snapshot/backup did not
cover `tomes/` at all, so a future feature that touched tome files carried its own recovery
responsibility and could not lean on the Phylactery snapshot/backup the way canonical-store
features could. [Holistic backup](../architecture/holistic-backup) (0.12.23/0.12.24-alpha) later
closed that specific gap at the whole-install level — it bundles Phylactery, Unruh, tomes, and
settings into one encrypted file — but it is a separate, ward-triggered mechanism, not a
substitute for this decision's per-operation archive-before-delete discipline: a ward without a
recent holistic backup in hand still has no recourse from a destructive fold that predates this
fix or from a future feature that skips the archive step.

The generalizable rule this incident produced is broader than pondering: **any autonomous
operation that deletes or overwrites the Familiar's own content must archive-or-snapshot before
the destructive step, expose a restore, and treat a truncated or malformed LLM result as a
refusal — never a partial store that also deleted the source.** Default-on is acceptable for such
a feature only once it is reversible. A future consolidation-style feature (memory, identity, or
another tome) should be checked against this same three-part shape — archive first, restore
surfaced everywhere the action is triggerable, strict parsing on the delete path — before it is
allowed to default on.

## Related

- [Pondering](../architecture/pondering) — the feature this decision hardened; see its "Digesting
  a month of ponderings" section for the full consolidation mechanism the archive sits inside.
- [Phylactery](../architecture/phylactery) — the canonical-store snapshot/backup that this
  incident showed does not extend to local tome files.
- [Holistic backup](../architecture/holistic-backup) — the later, whole-install backup mechanism
  that bundles tomes alongside Phylactery and Unruh, motivated by the same gap this incident
  exposed.
- [Session memorization: durable server-side queue](session-memorization-queue) — a sibling
  decision produced by a different data-loss incident in the same Tomes area, hardened into a
  durable queue rather than an archive-and-restore pair because the failure mode there was a lost
  write, not a destructive prune.
- [Engineering conventions](../reference/engineering-conventions) — the "Robust over cheap"
  priority order this decision is a concrete instance of, and RULE B (budget exhaustion is never
  silence), the general form of the truncated-digest failure above.
