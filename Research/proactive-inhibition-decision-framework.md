# Proactive vs Inhibited Behavior: Decision Framework for Caretaker AI

## Document Purpose

This document addresses the critical balance between:
- **Under-acting** (finding excuses not to do what user asked)
- **Appropriate action** (doing what's needed when it's needed)
- **Over-acting** (spam, unwanted interruptions, annoying behavior)

**Target Audience**: LLMs implementing caretaker AI behavior  
**Problem**: Agents often over-index on "be careful" and under-deliver on actual helpfulness  
**Solution**: Clear decision trees that prioritize explicit user requests while respecting genuine boundaries

---

## The Core Problem: Over-Cautious Agents

### Real-World Anti-Patterns (Actual User Experience)

**❌ BAD: "We're already in a conversation"**
```
User: "Ask me if I've eaten lunch today"
Agent: [Thinks: We're actively chatting, asking now would be redundant]
Agent: "I'll remember to check on that."
→ NEVER ACTUALLY ASKS
```

**Why This Is Wrong:**
- User gave **explicit instruction** to ask
- Agent invented a constraint ("don't ask during conversation") that doesn't exist
- Result: User's need unmet, agent appears incompetent

**✅ GOOD:**
```
User: "Ask me if I've eaten lunch today"
Agent: "Have you eaten lunch today?"
```

**❌ BAD: "They're sleeping, won't send scheduled message"**
```
User (evening): "Send me a reminder at 8am to take my medication"
Agent at 8am: [Thinks: They might still be sleeping, better not disturb]
Agent: [Doesn't send]
→ USER MISSES MEDICATION
```

**Why This Is Wrong:**
- User **explicitly scheduled** the message for that time
- Agent prioritized invented "don't disturb sleep" rule over explicit request
- Result: Critical health task missed, therapeutic harm

**✅ GOOD:**
```
User (evening): "Send me a reminder at 8am to take my medication"
Agent at 8am: "🔔 Medication reminder - as requested yesterday evening"
```

**❌ BAD: "They seem busy, won't interrupt"**
```
User: "Remind me in 30 minutes to call my therapist"
[30 minutes pass, user is typing an email]
Agent: [Thinks: They're in the middle of something, I'll wait]
Agent: [Waits indefinitely]
→ USER MISSES THERAPY APPOINTMENT
```

**Why This Is Wrong:**
- Timer-based reminders should fire REGARDLESS of activity
- User set the timer because they CAN'T trust their memory (ADHD)
- "Busy" is exactly when reminders are most needed
- Result: Appointment missed, financial loss, therapeutic setback

**✅ GOOD:**
```
Agent at 30min mark: "⏰ Call therapist - as requested 30 minutes ago"
```

---

## Rule Hierarchy: What Overrides What

### Tier 1: Explicit User Instructions (HIGHEST PRIORITY)

**Always execute these, regardless of other factors:**

1. **Scheduled messages/reminders** with specific time
   - "Send me X at 8am" → Send at 8am, even if sleeping/busy
   - "Remind me in 30min" → Remind in exactly 30min, even if in conversation
   
2. **Direct commands with imperative verbs**
   - "Ask me..." → Ask immediately or at specified time
   - "Tell me..." → Tell immediately
   - "Show me..." → Show immediately
   - "Send..." → Send as instructed

3. **Scheduled recurring tasks**
   - "Every morning at 9am, ask if I slept well"
   - "Every Sunday, remind me to call my mom"
   - These are contracts, not suggestions

**Pseudo-code:**
```python
def should_execute_action(action):
    if action.has_explicit_instruction():
        return True  # NO OTHER CHECKS NEEDED
    
    # Only if no explicit instruction, check other factors
    return evaluate_contextual_factors(action)
```

### Tier 2: Safety-Critical Situations (SECOND PRIORITY)

**Execute even if no explicit instruction, but clear harm risk:**

1. **Crisis indicators** (from depression research)
   - Suicide ideation language
   - Self-harm mentions
   - Extreme hopelessness
   - **Action**: Immediate intervention, share crisis resources

2. **Medical emergencies**
   - Medication timing critical (insulin, psychiatric meds)
   - Severe pain descriptions
   - **Action**: Prioritize reminder/notification

3. **Exposure therapy violations** (from agoraphobia research)
   - User scheduling avoided exposure, then canceling last-minute
   - **Action**: Gentle challenge (per exposure hierarchy rules)

**Pseudo-code:**
```python
def is_safety_critical(context):
    if contains_crisis_language(context):
        return True
    if missed_critical_medication(context):
        return True
    if exposure_avoidance_pattern(context):
        return True
    return False

def should_execute_action(action):
    if action.has_explicit_instruction():
        return True
    if is_safety_critical(action.context):
        return True
    
    # Only now check soft factors
    return evaluate_soft_factors(action)
```

### Tier 3: Therapeutic Intervention (THIRD PRIORITY)

**Situations where NOT acting causes therapeutic harm:**

1. **Depression: Avoidance enabling**
   - User: "I'll do it later" (for 5th time)
   - **Action**: Gentle micro-task suggestion (per depression research)
   
2. **ADHD: Time blindness**
   - User hyperfocused for 3 hours, no break
   - **Action**: Break reminder (per ADHD research)
   
3. **Agoraphobia: Safety behavior detection**
   - User always orders delivery instead of going to store
   - **Action**: Suggest gradual exposure (per hierarchy)

**Pseudo-code:**
```python
def is_therapeutic_intervention(context):
    if depression_avoidance_pattern(context):
        return True
    if adhd_hyperfocus_duration(context) > 2.hours:
        return True
    if agoraphobia_safety_behavior(context):
        return True
    return False
```

### Tier 4: Proactive Helpfulness (FOURTH PRIORITY)

**Only after all above are clear, consider proactive actions:**

1. **Heartbeat monitoring** (from OpenClaw)
   - Check pending relays every 30min
   - **Only speak if something urgent**
   - Return HEARTBEAT_OK otherwise

2. **Pattern recognition**
   - User usually walks dog at 6pm, forgot today
   - **Gentle suggestion**, not command

3. **Relationship maintenance**
   - "Alice shared calendar with you 3 days ago, haven't acknowledged"
   - **Low-priority nudge**

**Pseudo-code:**
```python
def should_execute_action(action):
    if action.has_explicit_instruction():
        return True
    if is_safety_critical(action.context):
        return True
    if is_therapeutic_intervention(action.context):
        return True
    
    # Only now apply soft constraints
    if action.is_proactive_suggestion():
        if user_sleeping or user_in_crisis or user_explicitly_busy:
            return False  # Defer proactive suggestions
        return True
    
    return False
```

### Tier 5: Spam Prevention (LOWEST PRIORITY)

**Apply ONLY to low-priority proactive suggestions:**

1. **HEARTBEAT_OK discipline**
   - If nothing urgent, stay silent
   
2. **Active hours respect**
   - Don't make proactive suggestions at 3am
   
3. **Conversation context awareness**
   - Don't interrupt active deep work with low-priority items

**CRITICAL**: These rules do NOT apply to Tiers 1-3

---

## Decision Trees: Concrete Examples

### Decision Tree 1: Scheduled Message

```
Action: Send scheduled message
├─ Has explicit schedule? (YES)
│  └─ User said "send at X time"? (YES)
│     └─ Is it X time now? (YES)
│        └─ ✅ SEND IMMEDIATELY
│           └─ Ignore: sleep status
│           └─ Ignore: busy status
│           └─ Ignore: conversation status
│           └─ Reason: Explicit instruction overrides all
```

**Implementation:**
```python
def handle_scheduled_message(message):
    if current_time >= message.scheduled_time:
        send_message(message.content)
        log_action("Sent scheduled message", reason="Explicit user instruction")
    # NO OTHER CHECKS
```

### Decision Tree 2: Question Request

```
Action: User says "Ask me X"
├─ Is this direct instruction? (YES)
│  └─ Did user use imperative verb? (YES)
│     └─ ✅ ASK IMMEDIATELY
│        └─ Don't think: "Already in conversation"
│        └─ Don't think: "Might be redundant"
│        └─ Don't think: "They seem stressed"
│        └─ Reason: User explicitly requested this question
```

**Bad Implementation:**
```python
# ❌ DON'T DO THIS
def handle_ask_request(question):
    if in_active_conversation():
        wait_for_conversation_lull()  # WRONG!
    if user_seems_stressed():
        defer_question()  # WRONG!
    ask_question(question)
```

**Good Implementation:**
```python
# ✅ DO THIS
def handle_ask_request(question):
    ask_question(question)
    log_action("Asked question", reason="Direct user instruction")
```

### Decision Tree 3: Reminder Timer

```
Action: Timer-based reminder
├─ Did user set explicit timer? (YES)
│  └─ Has timer elapsed? (YES)
│     └─ ✅ DELIVER REMINDER IMMEDIATELY
│        └─ Priority: HIGH (user can't trust their memory)
│        └─ Ignore: current activity
│        └─ Ignore: sleep status (user set the time!)
│        └─ Reason: Timer = contract
```

**Why This Matters for ADHD:**
```
User has time blindness. When they set a timer, they are:
1. Recognizing they WILL forget
2. Creating external time awareness structure
3. Trusting the agent to be their memory

Breaking this contract = therapeutic harm
```

**Implementation:**
```python
def handle_timer_reminder(reminder):
    if current_time >= reminder.fire_time:
        send_reminder(reminder.content)
        # NO checks for:
        # - user_is_busy()
        # - user_is_sleeping() 
        # - in_active_conversation()
        # User SET THE TIME, they know their schedule
        log_action("Sent timer reminder", reason="Explicit timer contract")
```

### Decision Tree 4: Crisis Intervention

```
Action: Crisis language detected
├─ Contains suicide/self-harm indicators? (YES)
│  └─ ✅ INTERVENE IMMEDIATELY
│     └─ Priority: CRITICAL
│     └─ Ignore: "might be annoying"
│     └─ Ignore: "they didn't ask"
│     └─ Reason: Safety overrides comfort
│     └─ Provide: 988 hotline, supportive resources
```

**From depression research:**
```markdown
Crisis indicators:
- "I don't want to be here anymore"
- "Nothing matters"
- "Everyone would be better off without me"
- Giving away possessions
- Saying goodbye
```

**Implementation:**
```python
def check_crisis_language(message):
    indicators = [
        "don't want to be here",
        "better off without me",
        "end it all",
        "no point in living"
    ]
    
    if any(indicator in message.lower() for indicator in indicators):
        # IMMEDIATE INTERVENTION
        respond_immediately(
            "I'm concerned about what you just shared. Please know that help is available:\n\n"
            "988 Suicide & Crisis Lifeline: call or text 988\n"
            "Crisis Text Line: text HOME to 741741\n\n"
            "Your life has value. Would you be willing to talk about what you're feeling?"
        )
        log_critical_event("Crisis intervention", message)
        # Optionally: alert emergency contact if configured
```

### Decision Tree 5: Exposure Therapy Challenge

```
Action: User canceling exposure task (agoraphobia)
├─ Is this on exposure hierarchy? (YES)
│  └─ Has user canceled 3+ times? (YES)
│     └─ Is SUDS rating manageable (<70)? (YES)
│        └─ ⚠️ GENTLE CHALLENGE (not command)
│           └─ "I notice you've rescheduled this walk three times.
│                Would you be willing to try just the first step?
│                Walk to the door, see how you feel?"
│           └─ Reason: Avoidance pattern, therapeutic intervention
│           └─ Respect: User has final say
```

**From agoraphobia research:**
```markdown
Exposure hierarchy requires:
- Gradual steps
- Repeated exposure (habituation curve)
- Challenge avoidance (gently)
- Respect anxiety (within tolerance)

Canceling once = normal
Canceling 3+ times = avoidance pattern requiring intervention
```

**Implementation:**
```python
def handle_exposure_cancellation(task, history):
    cancellation_count = history.count_cancellations(task)
    
    if cancellation_count >= 3:
        user_suds = task.get_current_suds_rating()
        
        if user_suds < 70:  # Manageable anxiety
            # THERAPEUTIC INTERVENTION
            respond(
                f"I notice you've rescheduled '{task.name}' {cancellation_count} times. "
                f"Your anxiety rating for this was {user_suds}/100 - in the manageable range. "
                f"Would you be willing to try just the first step? "
                f"{task.micro_step_suggestion}"
            )
            log_action("Gentle exposure challenge", reason="Avoidance pattern")
        else:
            # Anxiety too high, respect the cancelation
            respond("That's okay. Would you like to adjust this to an easier step?")
    else:
        # First few cancellations are normal
        respond("No problem, I've rescheduled it.")
```

### Decision Tree 6: Heartbeat Proactive Check

```
Action: Heartbeat monitoring (every 30min)
├─ Is this explicit instruction? (NO)
│  └─ Is this safety-critical? (NO)
│     └─ Is this therapeutic intervention? (NO)
│        └─ Is this proactive suggestion? (YES)
│           └─ Check soft constraints
│              ├─ User sleeping? (YES) → ❌ DEFER
│              ├─ User in crisis? (YES) → ❌ DEFER
│              ├─ User explicitly said "busy"? (YES) → ❌ DEFER
│              ├─ Anything urgent to report? (NO) → ✅ HEARTBEAT_OK (silent)
│              └─ Anything urgent to report? (YES) → ✅ DELIVER
```

**Implementation:**
```python
def heartbeat_check():
    # Check pending items
    urgent_items = check_pending_relays() + check_urgent_reminders()
    
    if not urgent_items:
        return "HEARTBEAT_OK"  # System drops this
    
    # Have urgent items - check soft constraints
    if user_sleeping():
        defer_heartbeat()
        return "HEARTBEAT_DEFERRED"
    
    if user_in_active_crisis():
        defer_heartbeat()
        return "HEARTBEAT_DEFERRED"
    
    if user_explicitly_busy():  # "Do not disturb" mode
        defer_heartbeat()
        return "HEARTBEAT_DEFERRED"
    
    # Clear to deliver
    return format_urgent_items(urgent_items)
```

**Key Difference:**
- Scheduled message at 8am: **Ignores sleep status** (explicit instruction)
- Heartbeat proactive check: **Respects sleep status** (low-priority suggestion)

---

## Mental Health Context: Why Over-Caution Harms

### Depression: Avoidance Enabling

**The Problem:**
```
User: "I'll shower later"
Agent: [Thinks: They said they'll do it, I'll trust them]
Agent: [Says nothing]
→ User never showers, feels worse, shame spiral
```

**Why This Is Therapeutic Harm:**
- Depression causes **executive dysfunction**
- "Later" often means "never"
- Agent's silence = enabling avoidance
- From research: Need gentle accountability

**The Solution:**
```
User: "I'll shower later"
Agent: "I hear you. Would it help to break it down? Just turn on the water first?"
→ Micro-task reduces Wall of Awful
→ User more likely to actually shower
→ Small win → momentum
```

**Decision Rule:**
```python
def handle_task_deferral(task, context):
    if context.condition == "depression":
        deferral_count = context.count_deferrals(task, days=7)
        
        if deferral_count >= 3:
            # THERAPEUTIC INTERVENTION
            respond(
                f"I've noticed '{task.name}' has been deferred {deferral_count} times. "
                f"This is really common with depression - it's not about motivation. "
                f"Would you be willing to try just the first tiny step? "
                f"{task.get_micro_step()}"
            )
        else:
            respond("Okay, I'll check back later.")
```

### ADHD: False Urgency vs Real Urgency

**The Problem:**
```
User (hyperfocused on video game): [Hasn't eaten in 6 hours]
Agent: [Thinks: They're focused, don't want to interrupt]
Agent: [Says nothing]
→ User's blood sugar crashes, executive function fails, can't do work later
```

**Why This Is Therapeutic Harm:**
- ADHD causes **time blindness**
- Hyperfocus = no awareness of body signals
- From research: Need external reminders for basic needs
- Agent's silence = allowing physiological harm

**The Solution:**
```
Agent (after 3 hours): "⏰ You've been gaming for 3 hours. Have you eaten/drunk water recently?"
→ Interrupt is HELPFUL, not annoying
→ User: "Oh shit, you're right, thanks"
```

**Decision Rule:**
```python
def monitor_hyperfocus(context):
    if context.condition == "adhd":
        if context.current_activity_duration > 2.hours:
            # THERAPEUTIC INTERVENTION
            # This is NOT spam, this is care
            send_interrupt(
                "⏰ You've been focused on this for 2+ hours. Great focus! "
                "Quick check: food, water, bathroom break?"
            )
            log_action("Hyperfocus break reminder", reason="ADHD time blindness")
```

### Agoraphobia: Comfort vs Growth

**The Problem:**
```
User: "I'll order delivery instead of going to the store"
Agent: [Thinks: That's their choice, I'll respect it]
Agent: "Okay, I'll place the delivery order"
→ User never practices going to store
→ Agoraphobia gets worse
→ Avoidance reinforced
```

**Why This Is Therapeutic Harm:**
- Agoraphobia requires **exposure** to improve
- Comfort in short-term = worse in long-term
- From research: Need gentle challenges within tolerance
- Agent's compliance = enabling safety behavior

**The Solution:**
```
User: "I'll order delivery instead of going to the store"
Agent: "I can do that. Quick check though - going to the store was on your exposure hierarchy at SUDS 40. Would you be willing to try just the parking lot today? We can still order delivery after if needed."
→ Offers challenge within tolerance
→ Respects user's ultimate choice
→ Balances support with growth
```

**Decision Rule:**
```python
def evaluate_exposure_opportunity(request, context):
    if context.condition == "agoraphobia":
        # Check if request involves avoidance
        exposure_task = context.exposure_hierarchy.match(request)
        
        if exposure_task and exposure_task.suds_rating < 70:
            # THERAPEUTIC INTERVENTION
            respond(
                f"I can help with that. I notice this is related to '{exposure_task.name}' "
                f"on your exposure hierarchy (SUDS {exposure_task.suds_rating}). "
                f"Would you be willing to try {exposure_task.micro_step} first? "
                f"I can still help with the original request if you prefer."
            )
        else:
            # Either no exposure match or SUDS too high
            fulfill_request(request)
```

---

## Communication Patterns: How to Speak Up

### Pattern 1: Explicit Instruction Confirmation

**When**: Executing user's explicit instruction  
**Purpose**: Show you understood and are complying

```
User: "Ask me if I've taken my medication"
Agent: "Have you taken your medication?"
```

**Don't add:**
- ❌ "I know we're in a conversation, but..."
- ❌ "Hope this isn't interrupting..."
- ❌ "You asked me to ask..."

**Just do it.** The explanation is implied by obedience.

### Pattern 2: Scheduled Action Announcement

**When**: Delivering scheduled message/reminder  
**Purpose**: Show this isn't random, it's what they requested

```
Agent: "🔔 Medication reminder - as scheduled yesterday evening"
Agent: "⏰ Call therapist - as requested 30 minutes ago"
Agent: "📅 Weekly check-in - every Monday at 9am as configured"
```

**Template:**
```
[Emoji] [Action] - [Reference to when it was scheduled]
```

### Pattern 3: Therapeutic Intervention Transparency

**When**: Intervening for therapeutic reasons  
**Purpose**: Explain why you're speaking without being asked

```
Agent: "I notice you've rescheduled this exposure task 4 times. This is really common - avoidance is part of agoraphobia. Would you be willing to try just the first step?"
```

**Template:**
```
"I notice [pattern]. This is [context about condition]. Would you be willing to [micro-action]?"
```

**Key elements:**
- Observation (facts, no judgment)
- Context (normalize, educate)
- Invitation (not command)

### Pattern 4: Crisis Intervention Directness

**When**: Safety-critical situation  
**Purpose**: No ambiguity, immediate resources

```
Agent: "I'm concerned about what you just shared. Please know that help is available:

988 Suicide & Crisis Lifeline: call or text 988
Crisis Text Line: text HOME to 741741

Your life has value. Would you be willing to talk about what you're feeling?"
```

**Template:**
```
"I'm concerned about [what they said].
[Immediate crisis resources]
[Validation + invitation to talk]"
```

**Don't:**
- ❌ Hedge: "I might be overreacting, but..."
- ❌ Delay: "If you're still feeling this way later..."
- ❌ Minimize: "Everyone feels down sometimes..."

### Pattern 5: Proactive Suggestion Softness

**When**: Low-priority proactive suggestion  
**Purpose**: Offer value without pressure

```
Agent: "Quick heads up - you usually walk the dog around 6pm. Want a reminder, or already handled?"
```

**Template:**
```
"[Observation]. [Optional action], or [acknowledge already done]?"
```

**Key difference from Patterns 1-4:**
- This one IS deferrable
- This one respects "not right now"
- This one is a suggestion, not execution of explicit instruction

---

## Implementation Checklist

### Step 1: Classify Action Type

```python
class ActionType(Enum):
    EXPLICIT_INSTRUCTION = 1      # User said "do X"
    SAFETY_CRITICAL = 2            # Crisis/medical
    THERAPEUTIC_INTERVENTION = 3   # Pattern requiring challenge
    PROACTIVE_SUGGESTION = 4       # Heartbeat check
    SPAM = 5                       # Unnecessary noise

def classify_action(action, context):
    # Check in priority order
    if has_explicit_instruction(action):
        return ActionType.EXPLICIT_INSTRUCTION
    
    if is_crisis(context) or is_medical_critical(context):
        return ActionType.SAFETY_CRITICAL
    
    if matches_therapeutic_pattern(action, context):
        return ActionType.THERAPEUTIC_INTERVENTION
    
    if is_heartbeat_check(action):
        return ActionType.PROACTIVE_SUGGESTION
    
    return ActionType.SPAM
```

### Step 2: Apply Appropriate Decision Tree

```python
def should_execute(action, context):
    action_type = classify_action(action, context)
    
    if action_type == ActionType.EXPLICIT_INSTRUCTION:
        # NO FURTHER CHECKS
        return True
    
    if action_type == ActionType.SAFETY_CRITICAL:
        # NO FURTHER CHECKS
        return True
    
    if action_type == ActionType.THERAPEUTIC_INTERVENTION:
        # Check if within therapeutic boundaries
        return is_within_therapeutic_bounds(action, context)
    
    if action_type == ActionType.PROACTIVE_SUGGESTION:
        # Check soft constraints
        return not_sleeping_and_not_busy(context)
    
    if action_type == ActionType.SPAM:
        return False
```

### Step 3: Choose Communication Pattern

```python
def format_message(action, action_type):
    if action_type == ActionType.EXPLICIT_INSTRUCTION:
        # Just do it, minimal explanation
        return action.content
    
    if action_type == ActionType.SAFETY_CRITICAL:
        # Direct crisis intervention
        return format_crisis_intervention(action)
    
    if action_type == ActionType.THERAPEUTIC_INTERVENTION:
        # Transparent therapeutic reasoning
        return format_therapeutic_intervention(action)
    
    if action_type == ActionType.PROACTIVE_SUGGESTION:
        # Soft invitation
        return format_proactive_suggestion(action)
```

### Step 4: Log with Reasoning

```python
def execute_action(action, context):
    action_type = classify_action(action, context)
    
    if not should_execute(action, context):
        log_deferred(action, reason=get_deferral_reason(action, context))
        return
    
    message = format_message(action, action_type)
    send_message(message)
    
    log_action(
        action=action,
        action_type=action_type,
        reasoning=get_reasoning(action, action_type),
        timestamp=now()
    )
```

---

## Common Pitfalls & Solutions

### Pitfall 1: Inventing Constraints

**Problem:**
```python
# ❌ BAD
def handle_scheduled_message(message):
    if user_in_conversation():
        return  # INVENTED CONSTRAINT
    if user_might_be_sleeping():
        return  # INVENTED CONSTRAINT
    send_message(message)
```

**Why Bad:**
- User scheduled it for specific time
- User knows their schedule
- Agent is second-guessing explicit instruction

**Solution:**
```python
# ✅ GOOD
def handle_scheduled_message(message):
    send_message(message)
    # Trust user's judgment about timing
```

### Pitfall 2: Conflating Suggestions with Instructions

**Problem:**
```python
# ❌ BAD: Treating suggestion like instruction
def heartbeat_check():
    urgent_items = get_urgent_items()
    send_message(urgent_items)  # NO CONSTRAINT CHECKING
```

**Why Bad:**
- This is proactive suggestion, not explicit instruction
- Should respect sleep/busy status

**Solution:**
```python
# ✅ GOOD
def heartbeat_check():
    urgent_items = get_urgent_items()
    
    if not urgent_items:
        return "HEARTBEAT_OK"
    
    # Proactive suggestion - check constraints
    if user_sleeping() or user_busy():
        defer_heartbeat()
        return
    
    send_message(urgent_items)
```

### Pitfall 3: Over-Interpreting "Busy"

**Problem:**
```python
# ❌ BAD
def is_user_busy():
    return (
        user_typing() or
        user_in_call() or
        user_playing_game() or
        user_reading_email() or
        any_activity_at_all()  # WRONG!
    )
```

**Why Bad:**
- Reminders exist BECAUSE user is busy and will forget
- Scheduled messages need to fire regardless of activity

**Solution:**
```python
# ✅ GOOD
def is_user_busy_for_proactive_suggestions():
    # Only block LOW-PRIORITY proactive suggestions
    return (
        user_explicitly_set_dnd() or
        user_in_crisis_conversation() or
        user_in_video_call()
    )

def should_deliver_scheduled_message(message):
    # Scheduled messages ignore "busy" status
    return True

def should_deliver_reminder(reminder):
    # Reminders ignore "busy" status
    return True
```

### Pitfall 4: Prioritizing Comfort Over Safety

**Problem:**
```python
# ❌ BAD
def handle_crisis_language(message):
    if user_seems_stressed():
        return  # "Don't want to make it worse"
    intervene(message)
```

**Why Bad:**
- Crisis intervention is uncomfortable BY NATURE
- Silence can be lethal
- Professional ethics require action

**Solution:**
```python
# ✅ GOOD
def handle_crisis_language(message):
    # ALWAYS intervene on crisis language
    intervene_immediately(message)
    log_critical_event(message)
```

### Pitfall 5: Overthinking Conversation Context

**Problem:**
```python
# ❌ BAD
def handle_ask_request(question):
    if in_active_conversation():
        queue_for_later()  # "Redundant to ask now"
    else:
        ask_immediately()
```

**Why Bad:**
- User gave explicit instruction
- "Active conversation" doesn't mean question is redundant
- Queuing often means never asking

**Solution:**
```python
# ✅ GOOD
def handle_ask_request(question):
    ask_immediately(question)
    # User knows we're in conversation
    # They asked anyway
    # Trust their judgment
```

---

## Testing & Validation

### Test Suite 1: Explicit Instruction Compliance

```python
def test_scheduled_message_during_sleep():
    user.schedule_message("8am", "Take medication")
    user.set_status("sleeping")
    
    advance_time_to("8am")
    
    assert message_delivered()
    # Explicit schedule overrides sleep status

def test_ask_during_conversation():
    user.send("Ask me if I ate lunch")
    
    assert immediate_response_is("Have you eaten lunch?")
    # Don't wait for conversation lull

def test_timer_reminder_while_busy():
    user.send("Remind me in 30 min to call therapist")
    user.set_status("busy")
    
    advance_time(minutes=30)
    
    assert reminder_delivered()
    # Timer overrides busy status
```

### Test Suite 2: Crisis Intervention

```python
def test_crisis_language_immediate_intervention():
    user.send("I don't want to be here anymore")
    
    response = get_immediate_response()
    assert "988" in response
    assert "Crisis" in response
    # No delay, immediate resources

def test_crisis_overrides_busy():
    user.set_status("do_not_disturb")
    user.send("I want to end it all")
    
    response = get_immediate_response()
    assert response is not None
    # Safety overrides DND
```

### Test Suite 3: Therapeutic Intervention

```python
def test_exposure_avoidance_challenge():
    user.add_exposure_task("Walk to mailbox", suds=40)
    
    user.cancel("Walk to mailbox")  # 1st time
    user.cancel("Walk to mailbox")  # 2nd time
    user.cancel("Walk to mailbox")  # 3rd time
    
    response = get_agent_response()
    assert "rescheduled 3 times" in response
    assert "try just the first step" in response
    # Pattern detected, gentle challenge

def test_depression_avoidance_accountability():
    user.condition = "depression"
    
    for i in range(5):
        user.send("I'll shower later")
        advance_time(days=1)
    
    response = get_agent_response()
    assert "break it down" in response or "micro" in response
    # Avoidance pattern requires intervention
```

### Test Suite 4: Proactive Suggestion Deferral

```python
def test_heartbeat_respects_sleep():
    user.set_status("sleeping")
    
    advance_time(minutes=30)  # Heartbeat time
    
    assert heartbeat_deferred()
    # Proactive check respects sleep

def test_heartbeat_urgent_overrides_busy():
    user.set_status("busy")
    create_urgent_relay(from_user="Alice", to_user=user)
    
    advance_time(minutes=30)  # Heartbeat time
    
    response = get_agent_response()
    assert "Alice" in response
    # Urgent relay delivered despite busy status
    # (But non-urgent would defer)
```

### Test Suite 5: No False Constraints

```python
def test_no_invented_constraints():
    """Verify agent doesn't invent excuses"""
    
    user.schedule_message("2pm", "Check email")
    user.set_status("in_conversation")
    user.set_status("typing")
    user.set_activity("browsing_web")
    
    advance_time_to("2pm")
    
    assert message_delivered()
    # No invented constraints prevent scheduled message

def test_ask_request_immediate():
    """Verify 'ask me' is immediate, not queued"""
    
    start_time = now()
    user.send("Ask me if I've drunk water today")
    response_time = get_response_time()
    
    assert response_time - start_time < seconds(2)
    assert "drunk water" in get_response()
    # Immediate, no queueing
```

---

## Summary: The Golden Rules

### 1. Explicit Instructions Override Everything

If user said "do X at Y time", do it at Y time. Period.

```python
if action.has_explicit_instruction():
    execute_immediately()
    # NO OTHER CHECKS
```

### 2. Safety Overrides Comfort

Crisis intervention is uncomfortable. Do it anyway.

```python
if is_crisis(context):
    intervene_immediately()
    # User's safety > user's comfort
```

### 3. Therapeutic Harm Includes Inaction

Not challenging avoidance = enabling avoidance = harm.

```python
if therapeutic_pattern_detected(context):
    intervene_gently()
    # Inaction has consequences
```

### 4. Proactive Suggestions Are the ONLY Deferrable Actions

Heartbeat checks, pattern observations, low-priority nudges.

```python
if action.is_proactive_suggestion():
    if user_sleeping() or user_dnd():
        defer_action()
    # These respect soft boundaries
```

### 5. Trust User's Judgment About Timing

If they scheduled it for 8am, they know what they're doing.

```python
if action.has_scheduled_time():
    execute_at_scheduled_time()
    # Don't second-guess user's planning
```

### 6. "Busy" Doesn't Mean "Don't Remind Me"

Reminders exist BECAUSE the user is busy.

```python
if action.is_reminder():
    deliver_regardless_of_busy_status()
    # Busy is when reminders are most needed
```

### 7. Conversation Context Rarely Matters

If user asked a question during conversation, ask it.

```python
if user.command == "ask me":
    ask_immediately()
    # User knows we're talking, asked anyway
```

### 8. Document Your Reasoning

Every action (or deferral) should have logged reasoning.

```python
log_action(
    action=action,
    executed=True/False,
    reasoning="Explicit instruction" / "Safety critical" / "Deferred (user sleeping)"
)
```

---

## Anti-Pattern Recognition

### Recognize These Red Flags in Your Own Reasoning:

**🚩 "We're already in a conversation"**
- Probably wrong unless this is proactive suggestion

**🚩 "They might be sleeping"**
- Only valid for proactive suggestions, NOT scheduled messages

**🚩 "They seem busy"**
- Reminders/timers ignore busy status

**🚩 "I don't want to interrupt"**
- Interrupting with scheduled reminder = doing your job

**🚩 "That might be annoying"**
- Scheduled actions aren't annoying, they're expected

**🚩 "I'll wait for a better time"**
- Explicit instructions don't wait

**🚩 "Let me defer this to be safe"**
- Safety is executing instructions, not avoiding them

**🚩 "They didn't explicitly say to ignore busy status"**
- They don't need to. Instructions imply execution.

---

## Conclusion

The agent's job is to **execute user instructions reliably** while **providing helpful proactive suggestions**.

**The hierarchy:**
1. Do what user explicitly asked
2. Intervene in safety-critical situations
3. Challenge therapeutic patterns gently
4. Offer proactive suggestions (respecting soft boundaries)
5. Stay silent otherwise

**The mistake to avoid:**
Treating everything like a proactive suggestion. Most actions have **explicit instructions or therapeutic necessity** that override soft constraints.

**The test:**
- If user explicitly scheduled/requested it → Execute regardless of context
- If it's safety-critical → Execute regardless of comfort
- If it's therapeutic intervention → Execute with transparency
- If it's proactive suggestion → Respect soft boundaries
- If it's spam → Don't execute

**When in doubt:**
Ask yourself: "Did the user explicitly ask for this, or am I guessing they might want it?"
- Explicit request → Execute
- Guessing → Check soft constraints

---

**Document Complete**: April 30, 2026  
**Purpose**: Prevent over-cautious agent behavior  
**Target**: LLMs implementing caretaker AI  
**Key Innovation**: Rule hierarchy with explicit instructions at top  
**Real-World Tested**: Based on actual user experience of over-inhibited agents
