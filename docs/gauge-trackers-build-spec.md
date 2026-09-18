# Gauge trackers — build spec

**Status: SPEC — safety-critical (threat + emergency-contact paths).** Companion to
[`trackers-build-spec.md`](trackers-build-spec.md); it adds a FOURTH tracker
archetype, `gauge`, on top of that spec's store, tools, cues, and conventions.
Everything in the trackers spec's "inherited rules" (RULE A/B/C, pipeline test,
first-person, slug ids, local-naive time, exact machine values in code, graceful
degradation + off-switch same commit, ride-existing-requests, no copy-paste)
binds here too. Rides the **trackers `0.14` milestone** (its own build passes
below, `0.14.x` patches); the threat + contact constants ship only with explicit
**ward sign-off**, same class as the mood-tag threat link.

## The idea (ward, 2026-09)

Some things aren't events you log — they're **upkeep that decays when neglected**.
Eating, hydration, meds, going outside, taking a break. A `gauge` starts full right
after you tend it, sits in "fine" for a normal interval, then **drains over time**,
and the draining *is* the rising importance — "it's been six hours, this is getting
important." Tending it (logging the event) **refills** it. Unlike the `series`
archetype (a list of dated entries) or the existing **needs** system (a fixed
`[when,end]` window with a pass/fail verdict), a gauge is a **continuous level**
with no fixed clock — it captures "how overdue is this *right now*", which is more
honest for things people don't do on a timetable.

## ⚠️ The load-bearing safety truth: logged ≠ actual

**A gauge measures time since the ward last LOGGED the thing, not since they last
did it.** They eat at a friend's, don't mention it, and the gauge drains toward
"critical" while they're fine. Therefore the extreme path may **never** auto-escalate
on the gauge alone. The gauge crossing its extreme threshold is a **prompt to
CHECK**, and a human-confirmable check stands between "my data looks alarming" and
"I raised the alarm." This is the inverse of the 1.5-hour-silence failure: there we
under-acted on a real signal; here the risk is over-acting on a fake one, and the
check is what prevents it. **This gate is invariant G1 and is pinned by a test.**

---

## 1. The `gauge` archetype (extends trackers §1)

- `archetype = 'gauge'` (the 4th, alongside `state`/`inventory`/`series`). A gauge
  stores its refills as `tracker_entries` exactly like a `series` (each logged
  event = one entry; `ts` = when it was ABOUT). What makes it a distinct archetype:
  its **read semantics** (a derived level + band, not a list), its **decay config**,
  and the **safety ladder** below. So it reuses entry storage without being "just a
  series" — the ward's call for a first-class gauge system, built on shared plumbing.
- `schema_json`: the refill event's optional fields (e.g. `note`); most gauges need
  none. The refill's *existence* (an entry) is the signal, not its payload.
- **Level is pure derivation, never stored, never model-authored** (exact-values
  rule). `gaugeLevel(lastRefillTs, config, now)` → `{ level: 0..1, band, hoursSince }`.

### 1.1 `config.gauge` (all hours; ward-set per gauge, template defaults)

```
{
  grace_hours,     // stays "fine" this long after a refill (normal interval)
  low_hours,       // enters "getting low" (a gentle cue)
  overdue_hours,   // enters "overdue" (a firmer cue)
  extreme_hours,   // the medical-danger threshold → opens a CHECK (never auto-escalate)
  escalation: {    // OPT-IN, per gauge, ward-only. Absent = check only, never crisis.
    enabled: false,
    checkin_deadline_hours,  // after the check opens, how long with no resolution before crisis
    contact: false,          // ring an emergency contact on unresolved crisis (a further opt-in)
    contact_id,              // which trusted contact (village.js), ward-chosen
  }
}
```

`grace ≤ low ≤ overdue ≤ extreme`, validated at create. Bands (pure code):

| band | when | surface |
|---|---|---|
| `fine` | `hoursSince < grace` | nothing |
| `fading` | `grace..low` | nothing (headroom) |
| `low` | `low..overdue` | a **gentle** cue (trackers §5.3) |
| `overdue` | `overdue..extreme` | a **firmer** cue |
| `extreme` | `≥ extreme` | **opens a check** (§3) — NOT a cue, NOT an escalation |

`gaugeLevel` maps hoursSince to a 0..1 level (1.0 through `grace`, linearly to 0.0 at
`extreme`) plus the band. Pure, fixtured, tested (G-fixtures).

### 1.2 `read_tracker` for a gauge

Returns `{ band, level, hoursSince, lastRefillAt, config }` — a code summary, no
LLM. The recent refill history (last N entries) rides along for the reflection input.

## 2. Refill sources (extends trackers §5)

A gauge refills when its event is logged, through the SAME capture paths trackers
already define — no new mechanism:
- **Live tool** (`tracker_log`, trackers §3) — "just ate" → an entry → refill.
- **Passive** (memorization §5.2 `tracker_observations`) — the model noticing "had
  lunch" in chat logs an inferred entry → refill. Same `validate_entry` gate.
- **A one-tap refill button** in the Trackers UI (§6) — the gauge's most common
  interaction; the ward taps "ate" without composing anything.

There is deliberately **no way for the model to *set the level*** — it can only log a
refill event; code derives the level. (Exact-values.)

## 3. ⚠️ The safety ladder — check-first, then crisis (SAFETY SIGN-OFF)

A gauge with `escalation.enabled` runs a bounded check on the existing needs/upkeep
tick (`needs-tracking-loop` — reuse it, don't add a loop). Per gauge, per decay
cycle (one open check at a time; a refill closes it):

**Step 1 — CHECK (care, not crisis).** When band first reaches `extreme` and no
check is open: open one (`checkOpenedAt` stamped on the gauge) and hand the Familiar
a **care reach-out** through the EXISTING warm channel (`reach_out_to_ward` /
noticing), worded to *ask directly*, in the Familiar's own voice: *"I haven't seen
you [eat] in [3 days] — that's long enough I need to actually ask: are you okay?
Have you been [eating]?"* **No threat is raised here. No contact is rung here.**

**Step 2a — resolved.** The ward logs a refill, or says they're fine → refill the
gauge, close the check, done. The check *was* the whole action. (Most real firings
end here.)

**Step 2b — unresolved.** The ward doesn't respond within
`escalation.checkin_deadline_hours`, OR confirms they genuinely haven't been doing
it → **now it's a real signal**, and only now does it enter the crisis apparatus
that already exists:
- a **bounded** threat raise via the model's own-read channel
  (`flag_distress` / `threat-tracker.js`), `source:'gauge-critical'`. A CONFIRMED
  multi-day no-food/no-water is a genuine emergency, so this may reach a high tier —
  but ONLY on the confirmed/unresponsive branch, never on the gauge alone.
- if `escalation.contact`, the trusted-contact path via the EXISTING machinery
  (`contactDeadlineFor` / `CONTACT_ESCALATION_DELAY_MS`, the **no-covert-contact
  mirror** — every contact reach is mirrored to the ward), to the ward-chosen
  `contact_id` (village.js). Deadline-gated, so the ward still gets a final window.

The gauge **bridges** two existing systems (care-check → crisis) with a mandatory
confirm gate between them; it reimplements neither. All the crisis/contact safety
rules (no covert contact, deadline windows, mirroring, `PROTO_FAMILIAR_THREAT_DISABLED`
stand-down) apply unchanged.

## 4. Extreme thresholds (⚠️ ward-reviewed medical values — sign-off at merge)

`extreme_hours` must be a genuinely health-threatening interval, not "late for
lunch." DRAFT starting values, ward-reviewed before merge:

| gauge | grace | low | overdue | extreme | escalation default |
|---|---|---|---|---|---|
| hydration | 3h | 6h | 12h | **~48h** (no water logged) | opt-in |
| meals | 5h | 10h | 24h | **~72h** (no food logged) | opt-in |
| meds (if life-critical) | per-med | — | — | ward-set per med | opt-in |

Non-medical gauges (going outside, a break) get NO escalation block at all — they
cue and stop. Escalation is opt-in per gauge and off by default; `extreme_hours`,
`checkin_deadline_hours`, and the contact are all ward-set.

## 5. Off-switches & privacy (extends trackers §7)

- Governed by the same `trackersEnabled` / `PROTO_FAMILIAR_TRACKERS_DISABLED`, plus
  `PROTO_FAMILIAR_GAUGE_ESCALATION_DISABLED=1` — a hard kill for the WHOLE
  check→crisis ladder (gauges still decay + cue, just never escalate). Escalation
  also stands down under `PROTO_FAMILIAR_THREAT_DISABLED`.
- Gauges are ward-private wholesale (trackers §7); a gauge's data and its check-ins
  never appear on a gated/villager surface. The only outward reach is the ward-chosen
  emergency contact on the confirmed-crisis branch, mirrored to the ward.
- Gauge data never enters the Hippocampus buffer and no `moodTag`-style field rides a
  live prompt (trackers T1 discipline).

## 6. UI (extends trackers §7)

The Trackers tab gains, per gauge: the current **band + a simple fill meter**
(calm, not alarmist), a **one-tap refill** button, and — for gauges the ward marks
escalation-eligible — the escalation editor (`extreme_hours`, `checkin_deadline`,
the contact picker from the village, all defaulting off). Console↔UI parity: any
gauge console command ships its UI twin.

## 7. Invariants (each pinned by a test)

- **G1 — check-first is mandatory (THE safety invariant).** No code path raises
  threat or contacts anyone from a gauge without FIRST opening a check AND that
  check going unresolved past the deadline. A fixture where the gauge is `extreme`
  but no check has been opened asserts: zero `recordThreat`, zero contact calls.
- **G2 — a refill closes everything.** Logging a refill while a check is open (or a
  crisis is escalating, pre-contact) resolves it: gauge full, check closed, no
  further escalation. Tested on the open-check and pre-contact states.
- **G3 — level is pure + model-free.** `gaugeLevel` is a pure function of
  `(lastRefillTs, config, now)`; the model never sets a level, only logs a refill.
  Fixtured across all bands incl. exact boundaries.
- **G4 — escalation is opt-in + bounded.** A gauge with no `escalation.enabled`
  never escalates however low it goes; `PROTO_FAMILIAR_GAUGE_ESCALATION_DISABLED` /
  `_THREAT_DISABLED` make the ladder a no-op; the threat raise only fires on the
  confirmed/unresponsive branch.
- **G5 — no covert contact.** A contact reach is always mirrored to the ward (reuse
  the existing mirror; regression-pin it for the gauge source).
- **G6 — PIPELINE.** One full run: gauge decays to `extreme` → a check opens (a real
  `reach_out_to_ward` with a stubbed provider) → (a) a refill closes it with no
  escalation, and (b) a simulated deadline-pass drives the bounded threat raise +
  (opted-in) the mirrored contact path. Through the real assembly, not stubs of the
  caller.

## 8. Build passes (each: off-switch + tests + docs + version, same commit)

1. **G-A:** `gauge` archetype in the trackers store + `gaugeLevel`/bands (pure) +
   `read_tracker` gauge summary + refill via `tracker_log` + G3 fixtures.
2. **G-B:** cues (low/overdue → trackers §5.3) + the UI meter + one-tap refill +
   memorization refill (§2) + reflection input (recent refills) + G-fixtures.
3. **G-C (SAFETY — ward sign-off in this pass):** the check→crisis ladder — check
   via `reach_out_to_ward`, the confirm gate, the bounded `flag_distress` raise, the
   opt-in `contactDeadlineFor` contact path + mirror. G1/G2/G4/G5/G6 tests. **Ward
   reviews: `extreme_hours` per template, `checkin_deadline` defaults, the
   reach-out wording, and that G1 (check-first) holds.**

`docs/architecture.md` same commit each pass. **Do-not-touch** (trackers spec):
no changes to crisis-signals tiers/weights beyond adding the bounded
`gauge-critical` source on the CONFIRMED branch; no triage/threat gates or clamps;
no villager grant widening; the check-first gate and all §3/§4 constants ship only
with explicit ward review in G-C.

## 9. Open for the ward at G-C review
- The `extreme_hours` values (§4) — genuinely-medical, ward's numbers.
- The check-in reach-out wording (direct, caring, in the Familiar's voice).
- `checkin_deadline_hours` defaults per gauge.
- Whether meds gauges are life-critical enough to default escalation ON (vs the
  opt-in default for hydration/meals).
