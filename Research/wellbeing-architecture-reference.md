# Wellbeing Architecture Reference: Per-Population Profiles

## Purpose

This document is the design reference for how Familiar should reason about user wellbeing. It exists to inform architecture decisions: what to track, what to weight, what counts as a baseline, what counts as a warning sign, what kinds of intervention follow from what kinds of observation.

It is structured by population: ADHD, depression, comorbid ADHD+depression, and panic/agoraphobia. Each section follows the same shape:

1. What the literature says "doing well" looks like for this population
2. What deterioration looks like, in observable signals
3. What instruments exist for assessment, and what they're useful for
4. Specific design implications for Familiar

A final section addresses cross-cutting issues: what overlaps, what doesn't, what mistakes are easy to make.

---

## ADHD

### Wellness baseline

The Canadian study by Fuller-Thomson et al. (2022) found that approximately 42% of adults with diagnosed ADHD achieved "complete mental health" (CMH), defined as the absence of mental illness/substance dependence/suicidality, the presence of happiness or life satisfaction, and social/psychological wellbeing. The corresponding figure for the general population was 73.8%, so adults with ADHD are around half as likely to reach this state — but a substantial minority do.

Factors associated with achieving CMH in adults with ADHD: married/partnered status, regular physical activity, use of spirituality or meaning-making practices for coping. Factors associated with *not* achieving CMH: comorbid psychiatric conditions (especially depression and anxiety), debilitating chronic pain, history of childhood physical abuse.

Recent research (Hargitai et al., 2025, Psychological Medicine) found that *awareness and active use of personal strengths* improved subjective wellbeing, quality of life, and reduced depression/anxiety/stress symptoms — and the effect held equally for people with and without ADHD. ADHD-related strengths the literature surfaces include creativity, hyperfocus deployed appropriately, humor, spontaneity, and empathy. The implication is not that these strengths are exclusive to ADHD, but that strength-based engagement is a wellbeing protective factor that works for ADHD adults specifically.

The "right difficult" framing (popularized by Hallowell and Ratey) describes a creative outlet or pursuit that is genuinely challenging and matters to the person. Daily engagement with a "right difficult" is associated with better outcomes in the ADHD literature. This is not about productivity in a neurotypical sense — it's about the brain having something to engage with that uses its strengths.

**Wellness baseline summary for Familiar to recognize:**

- Engaged with at least one challenging-but-meaningful pursuit ("right difficult")
- Regular physical activity (any form)
- Stable social connection (one or more close relationships)
- External structure that's working (calendars, routines, accountability that the user has accepted as scaffolding rather than fighting)
- Self-efficacy: a sense that "I can manage this"
- Use of strengths visible in the user's recent activity
- Absence of severe comorbid condition activity

### Deterioration signals

ADHD itself is chronic and "undulating" (Brown's term: peaks and valleys averaging out). Familiar shouldn't read every dip as deterioration. The signals worth tracking are *changes from this user's baseline*, particularly:

- Procrastination/avoidance worsening beyond baseline
- Lost items or missed appointments increasing
- Hyperfocus episodes that miss basic body needs (food, water, bathroom, medication, scheduled events)
- Withdrawal from previously-engaged "right difficult"
- Self-criticism increasing (often the first cognitive shift before depression sets in)
- Sleep schedule destabilizing further than baseline
- Medication adherence decreasing (if medicated)

**Important:** Several of these — forgetfulness, procrastination, sleep irregularity — *are* the ADHD baseline. The signal is acceleration past baseline, not their presence.

### Assessment instruments

**ASRS (Adult ADHD Self-Report Scale, WHO):** 18 items based on DSM-IV, with a 6-item screener (ASRS Part A). Validated, widely used. AUC 0.90 for the full scale. The screener performs nearly as well as the full scale and takes under a minute. *Useful for Familiar's purposes:* for users without diagnosis who want to gauge ADHD-likelihood, or for periodic check-ins on symptom load.

**AAQoL (Adult ADHD Quality of Life):** 29 items, four subscales (Life Productivity, Psychological Health, Relationships, Life Outlook). Tracks impact of ADHD on daily life rather than symptom count. Useful for trending over time.

**ACOS (Adult ADHD Clinical Outcome Scale):** 15 items, includes commonly-comorbid items like emotional dysregulation, depression, anxiety. Newer (2024) and broader than ASRS.

**GSE-6 for ADHD:** 6-item self-efficacy measure, validated for ADHD. Self-efficacy correlates positively with mental health outcomes. Worth tracking as an indirect wellness indicator.

### Design implications for Familiar

- **Track strengths-use alongside symptom-load.** Most ADHD assessment is deficit-focused; wellness is better predicted by strengths-engagement than symptom-absence.
- **Distinguish ADHD baseline from deterioration.** Familiar needs a personalized baseline before it can identify worsening. First weeks should be calibration, not intervention.
- **External structure should feel like scaffolding, not control.** The literature suggests adults with ADHD who *adopt* tools and structures fare better than those who fight them. Familiar's role is to be adopted, not imposed.
- **Physical activity is one of the most reliably protective factors.** Consider tracking and gentle encouragement, but not nagging — nagging undermines adoption.
- **Hyperfocus is a known harm risk.** Familiar should be authorized to interrupt hyperfocus episodes that have lasted past basic-needs thresholds, regardless of user's protests in the moment.

---

## Depression

### Wellness baseline

Depression remission is operationalized in the clinical literature as PHQ-9 score under 5 (Kroenke et al., 2001). Partial response is PHQ-9 under 10. These thresholds are well-validated across many populations and decades of research.

Beyond score thresholds, what wellness looks like in practice:

- Sleep regularity (whatever pattern works for the person, but stable)
- Appetite functioning (eating at recognizable times, with recognition of hunger)
- Anhedonia absent: previously-pleasurable activities still feel pleasurable
- Social contact maintained (frequency varies by person; the question is whether it matches the person's wellbeing baseline)
- Engagement with daily routines and self-care
- Presence of at least some sense of meaning or purpose
- Absence of severe negative cognitive distortions (worthlessness, hopelessness, guilt) in stable form

The presence of *some* low mood is normal; humans aren't supposed to feel uniformly good. The question is whether low mood dominates and is sustained.

### Deterioration signals

Depression often returns gradually rather than all at once. Up to 50% of recovered individuals experience relapse, with subtle early signs preceding full relapse. The literature consistently identifies these early warnings:

- **Sleep changes** — earliest and most reliable signal. Either insomnia or hypersomnia. Often appears before mood shift.
- **Anhedonia returning** — previously enjoyable activities feel less so. Can be subtle: "I'll do that later" replacing actual engagement.
- **Withdrawal from social contact** — declining invitations, shorter responses, longer reply gaps.
- **Routine breakdown** — hygiene, meals, household tasks becoming inconsistent.
- **Increased self-criticism** — the internal voice gets harsher.
- **Cognitive changes** — concentration slipping, decisions feeling harder, brain fog.
- **Physical symptoms** — unexplained aches, fatigue beyond what activity warrants.
- **Mood changes** — not always sadness; often irritability comes first.

**High-priority warning signs (require active intervention, not just notation):**

- Hopelessness about the future as a whole
- Statements about being a burden
- Saying goodbye, giving things away, putting affairs in order
- Sudden calm after a period of agitation (can indicate a decision has been made)
- Thoughts of suicide, even philosophical or passing ones
- Researching methods

### Assessment instruments

**PHQ-9 (Patient Health Questionnaire-9):** Nine items, each scored 0-3, for a total of 0-27. Items map to DSM depression criteria: anhedonia, depressed mood, sleep, energy, appetite, self-worth, concentration, psychomotor changes, suicidal ideation. Plus a tenth functional impact item that's not scored.

Score interpretation:
- 0-4: minimal/none
- 5-9: mild
- 10-14: moderate
- 15-19: moderately severe
- 20-27: severe

Cutoff of 10 has sensitivity 88% and specificity 88% for major depression. Question 9 (suicidal ideation) requires immediate further assessment regardless of total score. PHQ-2 is the first two questions only; useful as a rapid screener (if PHQ-2 ≥ 3, administer full PHQ-9).

**WHO-5 (World Health Organization-5 Wellbeing Index):** Five positively-framed items about the past two weeks, scored 0-5 each. The five items are: feeling cheerful and in good spirits; feeling calm and relaxed; feeling active and vigorous; waking up feeling fresh and rested; having daily life filled with things that interest you. Raw score (0-25) is multiplied by 4 for percentage (0-100). Score below 50 indicates poor wellbeing warranting further evaluation; below 28 suggests possible clinical depression. Sensitivity 93%, specificity 83% for depression detection.

The WHO-5 is particularly useful because it measures *wellbeing* rather than *symptom presence*. Two people with the same PHQ-9 score can have different WHO-5 scores. Tracking both gives a fuller picture.

**PHQ-4:** Combines PHQ-2 (depression) with GAD-2 (anxiety) for a four-item ultra-brief screener. Useful for daily check-ins where a longer instrument would be too much.

### Design implications for Familiar

- **Track multiple instruments, weight differently.** WHO-5 for wellbeing, PHQ-9 for symptom load, both at different cadences.
- **Sleep changes are an early signal.** Familiar should track sleep regularity even when nothing else seems off, because sleep often shifts first.
- **Anhedonia is hard to self-report.** Asking "are things you used to enjoy still enjoyable?" is harder to answer accurately than tracking whether the user is *doing* those things. Behavioral signal often precedes self-report.
- **Cognitive distortions are high-priority signals, not background noise.** When the user expresses hopelessness, worthlessness, or burden-thoughts, Familiar should treat these as flagged events even within a single conversation.
- **Crisis indicators bypass the normal flow.** Suicidal statements, even passing or philosophical ones, get escalated regardless of overall mood-trend reading.
- **Behavioral activation matters more than feeling-better-first.** The literature is clear: action precedes mood improvement, not the reverse. Familiar's interventions during depressive episodes should focus on micro-actions, not on improving mood directly.

---

## Comorbid ADHD + Depression

### Why this needs its own section

The comorbid presentation is not the sum of the two conditions. Specific findings from the literature:

- More than half of people with ADHD experience depression in their lifetime (vs ~17% general population).
- 30-40% of people with depression also have ADHD.
- Comorbid depression in ADHD is more severe: earlier onset, longer episodes, higher suicidality, greater hospitalization rate.
- Treatment response is reduced and complicated when both conditions are present.

The hardest design problem: ADHD and depression share many surface symptoms but require different interventions. Misidentification leads to wrong intervention.

### Symptoms that overlap (poor discriminators)

These appear in both ADHD and depression, and are *not useful* for telling them apart:

- Concentration problems
- Restlessness or psychomotor agitation
- Sleep disturbances
- Appetite changes
- Irritability
- Loss of motivation

If Familiar tries to diagnose mood state from these signals alone, it will frequently misread one condition as the other.

### Symptoms that discriminate (good discriminators)

The Diler et al. research and subsequent work identified specific symptoms that *do* discriminate true comorbid depression from ADHD baseline:

**Better indicators of true depression in someone with ADHD:**

- Depressive cognitions: guilt, worthlessness, hopelessness
- Suicidal ideation
- Severe anhedonia (not just "not in the mood" — actual loss of pleasure response)
- Psychomotor retardation (slowed thought and movement, not just distractibility)
- Social withdrawal beyond baseline
- Morbid thoughts

When these specific signals appear in a user with ADHD, depression is more likely the explanation than ADHD-baseline mood swing.

### Design implications for Familiar

- **Don't diagnose mood from overlapping signals alone.** Concentration trouble, irritability, and sleep changes alone are insufficient to call depression; they're common in ADHD.
- **Weight discriminating symptoms heavily.** Depressive cognitions ("I'm worthless," "what's the point"), severe anhedonia, suicidality, and psychomotor retardation should trigger depression-protocol responses even if symptom load is otherwise modest.
- **Risk model is amplified.** Comorbid ADHD-depression has higher suicide risk than either alone. Familiar's threshold for crisis-protocol activation should be more sensitive in this user.
- **ADHD treatment can mask depression and vice versa.** Familiar tracking should not assume that improvement in one means improvement in both. Track separately.

---

## Panic / Agoraphobia (undiagnosed but symptomatic)

### Wellness baseline

For someone whose panic clusters around leaving the house, "wellness" is not "no fear of leaving." It is:

- Safe zone is stable or expanding (not shrinking)
- Anticipatory anxiety about typical activities is manageable
- When panic occurs, it can be tolerated and recovered from
- Avoidance behaviors are not increasing
- Engagement with life inside the safe zone is full (not constrained beyond what physical agoraphobia symptoms require)

Recovery in clinical terms (PDSS-defined): score of 5 or less indicates remission; 40% reduction from baseline indicates response.

### Deterioration signals

- Safe zone shrinking (places previously tolerated no longer tolerable)
- Increased reliance on safety behaviors (always carrying medication, never going alone, always near exits, etc.)
- Increased anticipatory anxiety (worrying about future trips earlier and more intensely)
- Panic attack frequency increasing
- Quality of life within the safe zone reducing (if the home is becoming less tolerable too, this may signal generalization)
- Physical symptoms (chest pain, shortness of breath) outside of panic episodes

### Assessment instruments

**PAS (Panic and Agoraphobia Scale):** 13 items across five subscales — panic attacks, agoraphobic avoidance, anticipatory anxiety, restriction of activities/quality of life, worries about health. Both self-rated and clinician-rated versions. Compatible with DSM and ICD criteria.

**PDSS (Panic Disorder Severity Scale):** 7 items, each rated 0-4, total 0-28. Items cover panic frequency, distress, anticipatory anxiety, agoraphobic avoidance, panic-related sensation avoidance, work/social impairment.

Score anchors (Furukawa et al.):
- 0: normal
- 3: borderline
- 8: mild
- 12: moderate
- 16-17: marked
- 21-22: severe
- ≤5: remission
- 40% reduction: response

**MIA (Mobility Inventory for Agoraphobia):** Tracks specific situations and avoidance levels — more granular for someone tracking exposure progress.

### Design implications for Familiar

- **Map the safe zone explicitly.** Familiar should know where the user can go currently, where they used to be able to go, and where they aspire to be able to go. This map drives interpretation of any leaving-the-house event.
- **Distinguish "I avoided X" from "I couldn't do X today."** Both can be okay or concerning depending on context. Trend matters more than incident.
- **Don't enable avoidance long-term, don't push too fast either.** This is the key tension in agoraphobia support. Familiar should support graduated exposure but never pressure beyond user-set pace.
- **Post-panic hours are high-risk for avoidance cementing.** When a user reports a panic episode, the design should include some kind of follow-up across the days following, to prevent the place/event becoming permanently associated with panic.
- **Safety behaviors should be tracked as a category, not just as user habits.** Increased safety behavior reliance is a deterioration signal even when nothing else has changed.

---

## Cross-cutting design notes

### Tracking what matters more than tracking everything

The temptation is to log every signal across every population. The problem: signal volume drowns the system, and the user, in noise. Familiar should track:

- A small set of high-value signals updated frequently (sleep, mood, energy, anything user self-reported)
- A larger set of medium-value signals updated when something prompts them (specific symptom check-ins)
- Crisis-flag signals always, immediately

### The baseline calibration period

For all populations, the literature is clear that personal baselines vary significantly. Familiar will be ineffective without a calibration period. This is a real architectural commitment: the first 2-4 weeks should be observation-heavy and intervention-light. Acting on signals before knowing the user's baseline produces frequent false alarms and erodes trust.

### When to use which instrument

A rough pattern, not a rule:

- **Daily-ish:** PHQ-2 / PHQ-4, brief mood/energy ratings, sleep tracking. Lightweight, low cost, captures trend.
- **Weekly-ish:** WHO-5. Captures wellbeing rather than symptoms. Good cadence for tracking direction-of-travel.
- **Monthly or on-flag:** PHQ-9, GAD-7, PAS or PDSS. Heavier, more diagnostic.
- **Quarterly or on-major-life-change:** Full ASRS, AAQoL, comprehensive review.

### What no instrument captures

The validated instruments measure symptom presence and severity. They do not capture:

- Whether the user is engaging with strengths or "right difficult"
- Quality of social connection (frequency yes, quality no)
- Sense of meaning
- Current relationship to one's own body
- Specific environmental factors (housing, finances, relationship state)

These have to come from observation, conversation, and direct user input. They are often the things that move first when something is shifting, but they don't appear in any score.

### What to escalate vs what to log

A working principle, to be refined:

- **Log only:** Single-instance signals at or near baseline. Trend changes within tolerance.
- **Notice and adjust internal weighting:** Trend changes outside tolerance. Multiple co-occurring signals.
- **Bring up gently:** Sustained patterns that the user may not have noticed (e.g., "Sleep has been irregular for two weeks now. Want to look at it?")
- **Bring up directly:** Discriminating depression symptoms in an ADHD baseline. Safe zone shrinking. Multiple high-value signals shifting.
- **Escalate to crisis protocol:** Suicidal ideation. Statements about being a burden, giving up, or saying goodbye. Sudden calm after agitation. Method-research.

### Sources and limitations

This document draws on: PHQ-9 validation literature (Kroenke et al., 2001 and subsequent); WHO-5 systematic review (Topp et al., 2015); Adult ADHD Self-Report Scale validation (Kessler et al. 2005, with later replications); Panic Disorder Severity Scale literature (Shear et al., 1997; Furukawa et al., 2009); flourishing-with-ADHD population research (Fuller-Thomson et al., 2022); strengths-and-ADHD wellbeing research (Hargitai et al., 2025); comorbid ADHD-depression discrimination research (Diler et al.; Biederman et al.).

Limitations:

- Most instruments were validated on populations heavier in Western, employed, and neurotypical-default participants than the actual user population for Familiar.
- ADHD instruments tend to over-pathologize neurodivergent baselines.
- Comorbid presentations are under-studied compared to single conditions.
- Self-report is the dominant assessment mode; users with low capacity may not self-report accurately.
- The literature on agoraphobia treats it primarily as a feature of panic disorder; the form where panic clusters around leaving the house without meeting full panic-disorder criteria is less directly studied.

Familiar's design should treat the literature as one input alongside the user's lived expertise about their own patterns, not as ground truth.
