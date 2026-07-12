# Trackers — research appendix (condition-specific self-monitoring)

**Companion to [`trackers-design.md`](trackers-design.md).** What clinical
practice actually tracks for ADHD, depression, OCD, agoraphobia/panic, and
manic states — how those instruments are composed — and what each implies for
our templates. Sources at the end; instrument names are the searchable
anchors (PHQ-9, ASRM, Y-BOCS, NIMH Life Chart, Mobility Inventory, SUDS).

The Familiar is not a clinician and these are not diagnostic instruments —
they are the *shapes* clinical self-monitoring has converged on, borrowed
because they demonstrably work as data and as care.

---

## 1. Bipolar / manic states — the Life Chart shape

**The standard:** the NIMH **Life Chart Method** — the de-facto standard for
long-term bipolar monitoring, validated in app form. Daily, low burden:
mood on a single bidirectional scale (depression ↔ mania), **hours slept**,
medication taken, energy, irritability, and notable life events. The
**Altman Self-Rating Mania Scale (ASRM)** is the 5-item self-report used for
manic-side severity.

**The load-bearing finding: sleep is the first domino.** The literature
supports a **24–72h lag between sleep disruption and mood destabilization**,
and multi-dimensional tracking detects early-warning signs **1–6 days before
a full episode**. Decreased *need* for sleep (not just less sleep),
irritability upticks, and racing thoughts are the classic prodromes.
Personalized early-warning-sign lists are standard relapse-prevention
practice.

**Template implications (`mood`, `sleep`, `meds`):**
- The mood series should be **bidirectional** (−3…+3 style, low ↔ elevated),
  not a happiness scale — a "great mood" streak reads differently when it
  comes with 4-hour nights.
- **Sleep must be its own tracker** (hours + optionally "needed less"), and
  the mood↔sleep join is the single most valuable correlation reflection can
  run: *code* can flag "3 nights short + mood rising" as a deviation fact
  for the noticing turn without any model judgment.
- Meds tracker: taken/skipped + time — the third leg of the Life Chart.
- This is also where the ward's severe-weather-style *proactive* posture
  earns its keep: a code-detected sleep-shortening run is exactly the kind
  of thing the Familiar should notice out loud, gently, days early.

## 2. Depression — the Behavioral Activation shape

**The standard:** **PHQ-9** for periodic severity (9 items, biweekly-ish —
a *questionnaire*, so at most an optional monthly ritual here, never daily),
and the daily instrument that actually carries treatment: the **Behavioral
Activation activity diary** — activities logged with **Mastery and Pleasure
ratings** (0–10 each). The evidence: activity↔mood linkage is the engine of
BA, an effective depression treatment; a *balance* of mastery and pleasure
activities predicts the largest symptom drop. Patients who benefited most
from app-based CBT were the ones who did more BA logging with more varied
activities.

**The burden finding (shapes our whole capture design):** EMA research shows
**depressed mood and stress themselves increase experienced tracking burden
and predict non-adherence** — tracking lapses exactly when it matters most.
A depression-aware tracker must treat missing data as signal-bearing and
normal, never as failure, and must lean on capture paths that don't require
the ward to do anything extra (our §2.2 passive inference is precisely this).

**Template implications (`mood`, plus an `activities` facet):**
- The mood tracker's facets should let entries carry *what my human was
  doing* — and passive inference can tag activity + apparent mood from
  ordinary conversation, giving BA-shaped data with zero diary discipline.
- Reflection's job: surface the personal mastery/pleasure pattern ("cooking
  reliably lifts you; doomscrolling evenings precede low mornings") into
  Phylactery — that's BA's insight loop, run by the machinery we have.
- Missing tags/days are **never** prompted about more than gently (§2.3
  budget); a quiet week is data, not delinquency.

## 3. ADHD — track function, not virtue

**The practice:** adult-ADHD self-monitoring is about *function*, not
symptom scores: **medication timing and effect window** (start-latency and
task-overrun before/after the dose; late-day wear-off), **sleep** (a major
modulator of time blindness and executive strain), task follow-through, and
external check-in cues (alarms/MotivAider-style prompts — external stimulus,
not willpower). Time-perception literature: stress, poor sleep, and overload
all worsen time blindness.

**The anti-pattern finding (validates the ward's no-gamification stance):**
streak-based habit trackers are actively hostile to ADHD — a broken streak
converts a neurological difference into **shame**, and the guidance is
explicit: *tracking systems should not reset progress or shame the user;
totals persist, you pick up where you left off.* The highest hidden cost of
time blindness is repeated shame, not lateness.

**Template implications (`meds`, `sleep`, and the existing machinery):**
- ADHD's "tracker" is mostly things this codebase already does (reminders,
  leads, needs windows, readiness) — the *new* value is the **meds tracker
  with an effect-window field** (taken-at + felt-wearing-off-at), which lets
  code correlate task-follow-through against the medication window and lets
  the Familiar time its nudges *inside* the window.
- **Hard rule for every template:** no streak resets anywhere; counts are
  cumulative; a gap renders as "picked back up", never "broke the chain".
  (The wait-streak experiment's neutrality discipline, applied to the ward.)

## 4. OCD — the ERP log shape, with a structural caution

**The standard:** **Y-BOCS** for periodic severity; the daily working
instrument is the **ERP (exposure & response prevention) log**: trigger,
obsession, **SUDS rating (0–100 subjective units of distress)** before /
during / after, whether the ritual was resisted or delayed, and which
safety behaviors were used. Ritual *time per day* and compulsion frequency
are the other classic series.

**The load-bearing caution — monitoring can become the compulsion.**
Clinical guidance is explicit: some people with OCD become compulsive about
the tracking itself — recording every thought, seeking certainty they've
logged accurately. The recommendation: keep monitoring **time-limited and
specific**, and watch for the pattern.

**Template implications (`erp` template + design guards):**
- The ERP-log template exists for wards doing exposure work (fields above),
  ward-private, with the Familiar celebrating *resistance and delay*, never
  policing completeness.
- **Structural guards, in code:** per-tracker daily entry caps (config), no
  completeness prompts on sensitive trackers, and a reflection-visible
  signal if logging frequency itself climbs abnormally (the tracker noticing
  its own overuse — surfaced privately to the ward, once). Clarification
  cues (§2.3) are hard-capped for this template regardless of budget.
- SUDS numbers get the §5.5 qualitative bands like everything else.

## 5. Agoraphobia / panic — the Mobility Inventory shape

**The standard:** the **Mobility Inventory for Agoraphobia (Chambless)** —
avoidance of ~26 situations rated on a 5-point scale, **separately for
"when accompanied" and "when alone"** (the two only moderately correlate;
the gap measures companion dependence). The daily instruments: the **panic
diary** (time, place, trigger, symptoms, intensity, duration) and the
**exposure/outing log** (destination, alone-or-accompanied, anticipatory
anxiety vs. how it actually went, safety behaviors used, time out of the
house).

**Template implications (`outings` template):**
- Fields: went out y/n · destination *label* (ward words, never geodata —
  the weather-spec privacy discipline applies) · **alone/accompanied** (the
  MIA's key axis) · anticipated vs. actual difficulty · duration. Panic
  events as an optional facet, not a separate mandatory log.
- The **anticipated-vs-actual gap is the therapeutic gold**: reflection
  surfacing "you expected 8/10, it was a 4 — again" is exactly the
  disconfirmation exposure therapy runs on.
- Natural joins the codebase already has: the `outside` obstacle tag, the
  weather spec (an outing log + forecast = informed encouragement), and
  time-outside-per-day as a mood correlate (§1 of the design).
- Never a guilt surface: like ADHD streaks, "didn't go out this week"
  renders as rhythm, not failure.

## 6. Cross-cutting conclusions (what the evidence settles for §8)

1. **Sleep is the universal series** — prodrome for mania, symptom and
   driver for depression, executive multiplier for ADHD. It joins the
   sensitive-by-default set and should ship in v1.
2. **The template set the evidence supports:** mood (bidirectional, faceted)
   · sleep · meds (with effect window) · outings (MIA-shaped) · pantry ·
   laundry — with **erp** and **menses** as shipped-but-not-suggested
   templates (present for wards who want them; the Familiar doesn't
   proactively offer clinical-adjacent trackers uninvited).
3. **Low burden beats completeness, everywhere.** The EMA adherence
   literature says burden rises exactly when tracking matters most; our
   passive-inference-first capture is the right architecture, and missing
   data must always be treated as ordinary.
4. **No streaks that can break.** Cumulative counts only; gaps render
   neutrally. (Shame is a failure mode of the *instrument*, per the ADHD
   literature — and it generalizes.)
5. **Monitoring itself needs a watchdog** (OCD finding): entry-rate caps and
   a private "this tracker is being fed unusually often" reflection signal.
6. **Anticipated-vs-actual is a first-class field pattern** (agoraphobia
   finding, but it generalizes to ADHD task-dread and depression
   activity-avoidance): several templates want a "how I expect it to go /
   how it went" pair, and reflection mining that gap is high-value care.

## Sources

- [Steadyline — bipolar mood tracking guide (Life Chart, sleep lag, early-warning windows)](https://steadyline.app/blog/complete-guide-bipolar-mood-tracking)
- [Validation of life-charts documented with the personal life-chart app (PMC)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4367878/)
- [Can Sleep Parameters Predict Upcoming Mood Episodes in Bipolar Disorder? (PMC)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12483305/)
- [Daily longitudinal self-monitoring of mood variability in bipolar disorder (PMC)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5296237/)
- [Psychology Tools — CBT daily activity diary with enjoyment and mastery ratings](https://www.psychologytools.com/resource/cbt-daily-activity-diary-e-m)
- [Psychology Tools — behavioral activation activity diary](https://www.psychologytools.com/resource/behavioral-activation-activity-diary)
- [Smartphone CBT skills completion and outcomes in major depression (PMC)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5785683/)
- [MoodSmith — SUDS in ERP for OCD](https://moodsmith.com/erp/suds-erp-ocd/)
- [Therapy Courses — OCD worksheets / ERP tools (incl. the monitoring-as-compulsion caution)](https://therapycourses.digital/blogs/therapy-resources/ocd-worksheets-erp-tools-therapists-use-in-session)
- [Therapist Aid — exposure tracking log](https://www.therapistaid.com/therapy-worksheet/exposure-tracking-log)
- [Psychometric properties of the Mobility Inventory for Agoraphobia (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC3519241/)
- [Chambless — Mobility Inventory for Agoraphobia (instrument PDF)](https://cpb-us-w2.wpmucdn.com/web.sas.upenn.edu/dist/6/184/files/2017/03/Mobility-Inventory-1zjichf.pdf)
- [Dr. Crystal Lee — effective self-monitoring strategies for adults with ADHD](https://laconciergepsychologist.com/blog/self-monitoring-adult-adhd/)
- [Habi — time blindness and ADHD (incl. streak/shame guidance)](https://habi.app/insights/time-blindness-adhd/)
- [Momentary factors associated with EMA burden and adherence (JMIR)](https://formative.jmir.org/2024/1/e49512)
- [Experienced burden of and adherence to smartphone EMA in affective disorders (PMC)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7073581/)
