# Wait-streak awareness — build spec

**What this builds:** whenever I am given an explicit choice to *wait* on any
kind of outreach, or to *defer* an action, the deliberation now tells me one
fact: **how many times I have chosen to wait since my last proactive act.**
Nothing else — no directive, no evaluation, no "consider acting." The ward is
running an experiment: does seeing my own accumulated waiting, as a bare
number, change how I choose?

**Why (the incident behind it):** the ward went two days without contact and
the warm-outreach deliberation waited every single time — each tick a fresh
decision with no memory that it *was* the twentieth consecutive "wait." A
human friend feels the accumulation ("I keep meaning to text her…"); the
Familiar's deliberations are memoryless snapshots, so passivity never
becomes visible to the one making the choice. This spec makes the streak a
fact the Familiar reads at the moment of choosing.

**The experiment contract (non-negotiable):** the injected line is a
**neutral, code-built fact**. It carries no advice, no framing about what
the number means, no change to any gate, cool-down, or default. Every other
word of the affected prompts stays byte-identical. That is what makes the
observed behavior attributable to the information itself. The ward reviews
the effect before anything stronger is built.

Status: **spec — ready to build (sized for an Opus implementation session).**
Patch bump within the 0.8 milestone.

---

## 0. What this builds on

- **The proactivity doctrine** (CLAUDE.md): prompts governing when the
  Familiar acts must name both costs and add no bias-toward-quiet language.
  This spec *adds a fact* to those prompts and changes no other wording.
  Note the direction: a wait-streak made visible can only create pressure
  *toward* action — the doctrine-approved direction — but the line itself
  must not editorialize (see §4, verbatim strings).
- **The event logs** — `logs/triage-events.jsonl`, `logs/reachout-events.jsonl`
  (cerebellum.js `appendEventLog`): every deliberation already lands there.
  §5 stamps the streak onto those entries so the experiment is measurable.
- **State-file house pattern** — `last-activity.js` / `outbox.js`: tiny
  module, JSON under `tomes/`, atomic tmp+rename, never throws.
- **Sign-off:** one line lands in the triage deliberation prompt
  (`cerebellum.js decideTriageViaLLM`) — a safety-critical file. **The ward
  directed this feature and its wording in design review; that direction is
  the sign-off**, the same way voiceEscalationFactor was signed. The builder
  must not alter the wording or add anything beyond the specified line.

## 1. Counter semantics — what counts, what resets, what is excluded

One **global** streak, shared across all proactive surfaces (per-source
tallies are kept in state for the ward's later analysis, but the Familiar is
shown only the total — "any kind of outreach" is the ward's framing, and the
psychologically real number is the total).

**A "wait" increments the streak ONLY when the LLM was actually offered the
choice and chose to wait/defer.** Ticks that never reach a deliberation —
cool-down skips, quiet hours, crisis-defer stand-downs, threat-tier gates —
are NOT waits. The Familiar was never asked; counting them would inflate the
number with choices it never made. (Invariant W1; test-pinned.)

| event | effect | where it happens |
|---|---|---|
| Triage deliberation returns `wait` | +1 (`source: 'triage'`) | silence-triage-loop.js, after parse |
| Warmth deliberation returns `wait` | +1 (`source: 'warmth'`) | reachout-loop.js `llm_said_wait` branch |
| Discord deferred presence emits `[later:…]` | +1 (`source: 'discord-defer'`) | discord-gateway.js defer-token branch |
| Familiar snoozes a deferred tell (`snooze_intent`) | +1 (`source: 'tell-snooze'`) | cerebellum.js executor |
| Triage decides `reach_out` | **reset** (`kind: 'triage'`) | silence-triage-loop.js |
| Warmth decides `reach_out` (ward or villager) | **reset** (`kind: 'warmth'`) | reachout-loop.js |
| A Discord revisit fires and the Familiar actually speaks | **reset** (`kind: 'revisit'`) | discord-gateway.js revisit path |
| `acknowledge_deferred_intent` after genuinely acting on a tell | **reset** (`kind: 'tell-payoff'`) | cerebellum.js executor |

Reset = count → 0, `lastProactiveAt`/`lastProactiveKind` updated. Decisions
count at **decision time** (a decided reach-out is the proactive act;
delivery state is a separate concern the outbox already tracks).

**Excluded, deliberately** (record in code comments so nobody "completes"
this later without the ward): the ambient `[pass]` abstain (room pacing in a
group channel, not outreach deferral), surface-candidate non-raising
(implicit, never an offered wait choice), `schedule_snooze_task` (deferring
the *ward's* task is task management, not the Familiar deferring its own
act), and the ward simply talking first (the ward reaching out never resets
the streak — that asymmetry is part of what the number is *for*).

## 2. The module — `wait-streak.js`

New focused module. State: `tomes/.wait-streak.json` (git-ignored,
atomic tmp+rename, per-file async write lock like threat-tracker's):

```json
{
  "count": 41,
  "lastWaitAt": "2026-07-09T18:20:00.000Z",
  "lastProactiveAt": "2026-07-06T14:54:38.000Z",
  "lastProactiveKind": "warmth",
  "tallies": { "triage": 3, "warmth": 32, "discord-defer": 4, "tell-snooze": 2 }
}
```

Exports (every function returns rather than throws; a corrupt/missing file
reads as a zero state):

- `recordWait(source)` → increments count + the source tally, stamps `lastWaitAt`.
- `recordProactive(kind)` → resets count and tallies, stamps `lastProactiveAt`/`lastProactiveKind`.
- `getWaitStreak()` → the state plus `sinceMs` (code-computed from `lastProactiveAt`).
- `formatWaitStreakLine(state, nowMs)` → the injected line (§4), built
  entirely in code — counts and relative times are machine values
  (`relative-time.js`), never model-formatted.
- Off-switch: `waitStreakEnabled` (settings, default ON) +
  `PROTO_FAMILIAR_WAIT_STREAK_DISABLED=1`. Disabled = no recording AND no
  line rendered (the experiment is either fully on or fully off; a
  half-state would corrupt the data).

## 3. Write-side wiring (exact call sites, fire-and-forget)

Each call is `.catch(() => {})`-style fire-and-forget — streak recording may
never block or fail a deliberation path:

1. **silence-triage-loop.js** — where the parsed decision branches:
   `wait` → `recordWait('triage')`; `reach_out` → `recordProactive('triage')`.
2. **reachout-loop.js** — the `llm_said_wait` branch → `recordWait('warmth')`;
   the acted branch (either target) → `recordProactive('warmth')`.
3. **discord-gateway.js** — where a `[later:…]` token is accepted →
   `recordWait('discord-defer')`; where a revisit's turn produces a real
   outbound reply (not a re-defer, not a pass) → `recordProactive('revisit')`.
4. **cerebellum.js** — `snooze_intent` executor success →
   `recordWait('tell-snooze')`; `acknowledge_deferred_intent` executor
   success → `recordProactive('tell-payoff')`.

## 4. Read-side injection — VERBATIM strings

The line is appended to the "what I have to work with" facts of each
deliberation that offers a wait choice. **These strings are final. The
builder pastes them; it does not rewrite, extend, soften, or annotate
them.** All numbers/times are substituted by code.

With a prior proactive act on record:

```
- Since my last proactive reach-out (<relative time> ago, <kind>), I have chosen to wait <N> time(s) when given this choice.
```

With none on record:

```
- I have no proactive reach-out on record; since tracking began I have chosen to wait <N> time(s) when given this choice.
```

Immediately after a reset (`count` 0):

```
- My last proactive reach-out was <relative time> ago (<kind>); I have not waited since.
```

`<kind>` renders as a plain word: `a warm reach-out`, `a check-in`,
`a revisit`, `a told intent`. `<relative time>` via `relative-time.js`.
The line renders **always** at the three injection points while enabled
(consistent exposure; a count of 0 is also information).

Injection points:

1. **`buildReachoutPrompt`** (reachout.js) — appended after the
   `silenceLine` in the facts list. (Macro boundary 1 already applies at
   the call site; the line contains no macros.)
2. **`decideTriageViaLLM`** (cerebellum.js) — appended to the deliberation
   facts. **Safety-critical file: this one line, nothing else.** The
   existing prompt wording stays byte-identical.
3. **The Discord deferred-presence / revisit deliberation** — same line,
   same placement discipline.

## 5. Measurement (the other half of the experiment)

Every logged deliberation gains the streak as data: the entries written to
`triage-events.jsonl` and `reachout-events.jsonl` carry
`streakAtDecision: <N>` (the value the prompt showed). The ward can then
correlate streak values against wait/act decisions across weeks —
`GET /api/triage-events` / `GET /api/reachout-events` already serve the
logs. No new endpoint needed.

## 6. Invariants (acceptance criteria pin each one)

- **W1** — gate-skipped ticks never increment: a tick that ends in
  `crisis_defer`, `quiet_hours`, `in_cooldown`, or a tier gate leaves the
  count untouched (test: run the loop's tick fn with gates closed, assert
  no state change).
- **W2** — neutrality: the injected line matches the §4 strings exactly;
  a regression test asserts the rendered line contains no token from a
  small banned list (`consider`, `should`, `maybe it's time`, `overdue`) —
  the cheap tripwire against a future "helpful" edit.
- **W3** — prompt isolation: with the feature disabled, `buildReachoutPrompt`
  and the triage prompt are byte-identical to today's output (snapshot
  test) — proving the only change while enabled is the one line.
- **W4** — the ward speaking never resets the streak; only the four reset
  events do.
- **W5** — recording is fire-and-forget: a throwing/corrupt state file
  changes no deliberation outcome (loop tests with a poisoned store).
- **W6** — the streak stamps land in both event logs.

## 7. Build order (one Opus session)

1. `wait-streak.js` + tests (state round-trip, formatter strings verbatim,
   zero-state on corrupt file).
2. Write-side wiring (§3) + W1/W4/W5 tests.
3. Read-side lines (§4) + W2/W3 tests; event-log stamping (§5) + W6.
4. Settings toggle + env off-switch; `docs/architecture.md` file-table row
   (same commit); patch version bump.

**Do-not-touch list for the builder:** no other wording in
`decideTriageViaLLM` or `buildReachoutPrompt`; no gates, cool-downs,
clamps, or defaults anywhere; no changes to `crisis-signals.js`,
`threat-tracker.js`, or CARE CHECK; no additional injection points beyond
§4's three (in particular: not the chat path, not surface candidates, not
the ambient-pass prompt).

## 8. Out of scope / future

- Any interpretation of the number in prompts (that's the *next* experiment,
  only after the ward has seen how the bare fact lands).
- The ambient `[pass]`, surface-candidate raising, and ward-task snoozes
  (excluded by design, §1).
- The noticing tick / intentions / baselines design this feeds: once that
  ships, the streak becomes one deviation fact among several — this
  module's `getWaitStreak()` is written to be consumed there as-is.
