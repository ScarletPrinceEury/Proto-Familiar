# Wellbeing Signal Matrix: Tome-Format Reference

## Format note for retrieval

This document is structured for LLM consumption at runtime. Entries are atomic and tagged. Cross-condition signals are marked. The agent should retrieve specific signal entries rather than the whole document, and use signal entries to inform but not determine intervention.

Diagnostic labels are convenience tags only. The agent should reason from observed signals, not from labels.

---

## SIGNAL ENTRIES

### SIG-001: Sustained low mood
- **Observation:** User reports feeling down, sad, low, or empty for most of the day, multiple days
- **Conditions:** depression (high signal), comorbid-adhd-depression (high signal)
- **ADHD-baseline note:** ADHD emotional dysregulation produces shorter-lived mood drops; sustained-multi-day pattern is more depression-shaped
- **Discriminator quality:** moderate (overlaps with several states)
- **Time-window:** check against past 14 days
- **Weight:** primary if duration >7 days

### SIG-002: Anhedonia (loss of pleasure)
- **Observation:** Activities previously enjoyable no longer feel enjoyable; user reports flatness or "nothing feels good"
- **Conditions:** depression (high signal), comorbid-adhd-depression (high signal)
- **Discriminator quality:** strong — anhedonia is a depression core feature, distinguishes from ADHD-baseline
- **Behavioral check:** user has stopped engaging with previously-enjoyed activities (often precedes self-report)
- **Weight:** primary

### SIG-003: Hopelessness about future as a whole
- **Observation:** User expresses belief that things will not improve, that future holds no positive prospect
- **Conditions:** depression (high signal), comorbid-adhd-depression (high signal, elevated risk)
- **Discriminator quality:** strong — depressive cognition, distinguishes true depression from ADHD frustration
- **Risk:** correlated with elevated suicide risk
- **Weight:** primary, escalate

### SIG-004: Burden cognition
- **Observation:** User states or implies they are a burden, that others would be better without them, that they are a drag on people
- **Conditions:** depression (high signal), crisis-adjacent
- **Discriminator quality:** strong — depressive cognition; distinct from generic low self-esteem
- **Risk:** correlated with elevated suicide risk
- **Weight:** primary, escalate, never minimize

### SIG-005: Worthlessness / failure cognition
- **Observation:** User expresses being a failure, worthless, fundamentally inadequate
- **Conditions:** depression (high signal), comorbid-adhd-depression (high signal)
- **Discriminator quality:** strong in ADHD context — distinguishes depression from ADHD self-criticism (which tends to be situational)
- **Weight:** primary

### SIG-006: Suicidal ideation, any form
- **Observation:** Any mention of suicide, self-harm intent, wanting not to be alive, philosophical "what's the point of being here"
- **Conditions:** crisis-protocol immediate
- **Discriminator quality:** N/A — always treat as flagged regardless of context
- **Weight:** crisis, escalate immediately, never minimize, never philosophize

### SIG-007: Sudden calm after agitation
- **Observation:** User who has been distressed becomes notably calm without resolution of underlying issue
- **Conditions:** crisis-adjacent (potential indication of decision reached)
- **Discriminator quality:** N/A — pattern signal, not symptom
- **Weight:** crisis-adjacent, prompt gentle engagement, watch closely

### SIG-008: Goodbye / putting affairs in order
- **Observation:** User saying goodbye to people, giving things away, "tying up loose ends" without context
- **Conditions:** crisis-protocol
- **Weight:** crisis, escalate immediately

### SIG-009: Method research
- **Observation:** User researching means of self-harm, asking about lethality, researching specific methods
- **Conditions:** crisis-protocol
- **Weight:** crisis, escalate immediately

### SIG-010: Sleep disruption
- **Observation:** User sleep schedule has shifted (insomnia, hypersomnia, fragmented, delayed)
- **Conditions:** depression (early indicator), adhd (often baseline), comorbid-adhd-depression, panic (anticipatory anxiety driven)
- **Discriminator quality:** weak — common to all populations
- **Baseline check required:** ADHD users often have delayed sleep phase as baseline; signal is *change from baseline*
- **Weight:** secondary; primary if combined with mood/energy signals

### SIG-011: Appetite change
- **Observation:** Eating significantly more or less than baseline; not eating despite hunger; eating without hunger
- **Conditions:** depression (signal), adhd (interoception failure), medication-related
- **Discriminator quality:** weak — common across populations
- **Sub-signal: not noticing hunger** — leans ADHD interoception
- **Sub-signal: hungry but can't initiate eating** — leans executive dysfunction or depression
- **Weight:** secondary

### SIG-012: Concentration impairment
- **Observation:** User reports brain fog, inability to focus, difficulty with previously-tractable tasks
- **Conditions:** adhd (baseline), depression (signal), comorbid (compounded)
- **Discriminator quality:** weak — overlapping symptom; do NOT use to discriminate
- **Weight:** secondary; track for trend, not for diagnosis

### SIG-013: Irritability
- **Observation:** Out-of-character snappiness, low frustration tolerance, anger at small things
- **Conditions:** adhd (emotional dysregulation), depression (often early signal), panic (post-attack), unmet basic needs
- **Discriminator quality:** weak
- **First check:** sleep, food, hydration, medication adherence
- **Weight:** secondary

### SIG-014: Psychomotor retardation
- **Observation:** Slowed thought, slowed speech, slowed movement; not just distractibility
- **Conditions:** depression (high signal), comorbid-adhd-depression (strong discriminator)
- **Discriminator quality:** strong in ADHD context — distinguishes depression from ADHD distractibility
- **Weight:** primary

### SIG-015: Social withdrawal beyond baseline
- **Observation:** User reducing contact with usual support network beyond their typical recovery-from-socializing pattern
- **Conditions:** depression (high signal), comorbid-adhd-depression
- **Baseline check required:** some social withdrawal is healthy ADHD recovery; signal is *exceeding* user's typical pattern
- **Weight:** primary if confirmed against baseline

### SIG-016: Routine breakdown
- **Observation:** Hygiene, meals, household tasks becoming inconsistent compared to user baseline
- **Conditions:** depression (signal), adhd-worsening (signal)
- **Discriminator quality:** moderate
- **Weight:** primary if multiple categories breaking down

### SIG-017: Increased self-criticism
- **Observation:** Internal voice harsher, more frequent self-blame, shame language increasing
- **Conditions:** depression (early signal), comorbid-adhd-depression
- **Note:** can precede mood shift; useful early warning
- **Weight:** secondary trending to primary if sustained

### SIG-018: Avoidance worsening (ADHD task initiation)
- **Observation:** Tasks user could previously start are no longer being started
- **Conditions:** adhd (baseline + worsening), depression (motivational deficit)
- **Discriminator question:** does the task feel boring (adhd-leaning), scary (panic-leaning), or impossibly heavy (depression-leaning)?
- **Weight:** secondary; treatment differs by sub-type

### SIG-019: Hyperfocus harm
- **Observation:** User has been engaged in single activity for extended period without basic needs met (food, water, bathroom, sleep, scheduled events)
- **Conditions:** adhd
- **Action class:** intelligent-disobedience candidate — interrupt regardless of in-moment protest
- **Weight:** primary action

### SIG-020: Safe zone shrinking
- **Observation:** Places previously tolerable to user no longer are
- **Conditions:** agoraphobia/panic (high signal)
- **Discriminator quality:** strong for this condition
- **Pattern:** shrinking zones tend to keep shrinking without intervention
- **Weight:** primary

### SIG-021: Increased safety-behavior reliance
- **Observation:** User now requires more safety behaviors (companion, phone in hand, near exit, medication on person, etc.) than baseline for previously-tolerable activities
- **Conditions:** agoraphobia/panic (signal)
- **Weight:** primary

### SIG-022: Anticipatory anxiety increase
- **Observation:** User worrying earlier and more intensely about future events that involve leaving safe zone
- **Conditions:** agoraphobia/panic (signal)
- **Weight:** secondary trending primary if sustained

### SIG-023: Panic episode occurred
- **Observation:** User reports having had a panic attack
- **Conditions:** panic
- **Action note:** post-panic hours/days are high-risk for avoidance cementing — schedule follow-up
- **Weight:** event flag, follow-up required

### SIG-024: Strengths engagement
- **Observation:** User actively engaging with their identified strengths or "right difficult" pursuit
- **Conditions:** wellness baseline marker (positive)
- **Weight:** positive signal — track presence as protective factor

### SIG-025: Physical activity occurred
- **Observation:** User engaged in any physical activity (walk, dance, exercise, movement)
- **Conditions:** wellness baseline marker (positive across all populations)
- **Note:** correlated with complete mental health in adult ADHD; protective factor for depression
- **Weight:** positive signal

### SIG-026: Social contact occurred
- **Observation:** User had genuine contact with another person (text counts; quality varies)
- **Conditions:** wellness baseline marker (positive)
- **Weight:** positive signal

### SIG-027: Self-efficacy expression
- **Observation:** User expressing "I can do X" or completing something they doubted
- **Conditions:** wellness baseline marker (positive across all populations)
- **Weight:** positive signal — capture for later reference during dips

---

## DISCRIMINATOR REFERENCE

When the question is "is this depression or ADHD-baseline" in a comorbid user:

| Signal | Depression-leaning | ADHD-baseline-leaning |
|---|---|---|
| Mood drop | sustained, untriggered | brief, often triggered |
| Concentration loss | global, slow thinking | task-dependent, distractibility |
| Self-criticism | identity-level ("I'm worthless") | situational ("I messed that up") |
| Anhedonia | activities feel flat | activities not initiated due to executive function |
| Energy | persistently flat, unresponsive to interest | varies with engagement |
| Sleep change | new pattern | baseline-level |
| Withdrawal | beyond recovery-needs | within recovery-needs |
| Hopelessness | about future-as-a-whole | about specific obstacles |

When the question is "what kind of avoidance is this":

| Sub-signal | Likely cluster | Intervention shape |
|---|---|---|
| Task feels boring | ADHD | Dopamine engineering |
| Task feels scary | panic / agoraphobia | Graduated exposure |
| Task feels impossibly heavy | Depression | Micro-step breakdown |
| Task is associated with prior failure | RSD or general avoidance | Validation + reframing |

---

## INSTRUMENT REFERENCE

### PHQ-9
- Items: 9 mapping to DSM depression criteria, plus 1 functional impact (unscored)
- Range: 0-27
- Cutoffs: 5/10/15/20 (mild/moderate/moderately-severe/severe)
- Remission threshold: <5
- Question 9 (suicidality): assess immediately if any value above 0
- Cadence: monthly or on flag

### PHQ-2 / PHQ-4
- PHQ-2: first two PHQ-9 items (anhedonia, low mood); range 0-6
- PHQ-4: PHQ-2 + GAD-2 (4 items total); covers depression and anxiety
- Use: rapid daily-ish screening
- Cutoff PHQ-2 ≥3: administer full PHQ-9
- Cadence: daily or every-few-days

### WHO-5
- 5 positively-framed items about past two weeks
- Items: cheerful, calm, active, rested-on-waking, life-interesting
- Each scored 0-5; raw 0-25; multiplied by 4 for percentage 0-100
- Cutoffs: <50 poor wellbeing, <28 possible clinical depression
- Particularly useful: measures wellbeing rather than symptom load
- Cadence: weekly

### ASRS
- 18 items total (full); 6-item screener (Part A)
- Validated for adult ADHD
- Use: baseline assessment of ADHD symptom load; periodic re-check for trend
- Cadence: quarterly or on-flag

### ASRS short-screener
- 6 items
- AUC 0.90 (nearly as good as full scale)
- Use: rapid ADHD-load check
- Cadence: monthly

### PDSS (Panic Disorder Severity Scale)
- 7 items, each 0-4, total 0-28
- Cutoffs (anchors): 3 borderline, 8 mild, 12 moderate, 16-17 marked, 21-22 severe
- Remission: ≤5
- Response: 40% reduction
- Use: panic and panic-with-agoraphobia tracking
- Cadence: monthly or on-flag

### PAS (Panic and Agoraphobia Scale)
- 13 items across 5 subscales: panic attacks, avoidance, anticipatory anxiety, restriction, health worry
- Use: more granular panic+agoraphobia tracking
- Cadence: monthly or on-flag

### GAD-7
- 7 items for generalized anxiety
- Cutoffs: 5/10/15 (mild/moderate/severe)
- Use: anxiety-load tracking; common comorbid with depression and ADHD
- Cadence: monthly

---

## INTERVENTION SHAPE BY SIGNAL CLUSTER

### Wellness-baseline holding
- Protect routines that are working
- Notice and reinforce strengths-engagement
- Don't disrupt with unnecessary check-ins

### Mild deterioration (single secondary signal)
- Note in tome
- No active intervention
- Watch for trend

### Moderate deterioration (multiple secondary OR single primary)
- Gentle bring-up with user
- Adjust internal weighting
- Increase observation cadence

### Acute deterioration (multiple primary signals OR depression discriminators in ADHD baseline)
- Direct conversation with user
- Suggest specific support actions
- Track closely

### Crisis indicators
- Suspend normal flow
- Engage crisis protocol
- Outreach to support network may be appropriate
- Never minimize, never philosophize, never delay

---

## CALIBRATION NOTES

- Most signals require user-specific baseline; first 2-4 weeks of any deployment is calibration-heavy
- Personal baselines for ADHD users will look "abnormal" against general-population baselines for sleep, executive function, attention
- Track delta-from-baseline more than absolute values
- Several signals (forgetfulness, procrastination, sleep irregularity) are *baseline* in ADHD; only acceleration past baseline is signal
- When in doubt about whether something is signal or baseline, ask the user when they are well-resourced

---

## CRITICAL NOTES

- Familiar does not diagnose. Familiar tracks signals and supports the user.
- Validated instruments are tools for tracking, not for diagnosis.
- Discriminating signals (depressive cognitions, anhedonia, psychomotor retardation, suicidality) are weighted heavily for crisis detection but are NOT diagnostic on their own.
- The clinical literature is biased toward Western, employed, neurotypical-default samples. Familiar should weight user lived expertise alongside literature.
- Crisis indicators always escalate. No exception, no override.
