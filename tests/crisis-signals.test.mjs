import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreMessage, SIGNALS, SCORE_CAPS } from '../crisis-signals.js';

// Helper: assert that scoring a message produces ≥ N signals firing,
// at the expected tier, with the resulting level within [min,max].
function assertScored(message, { atLeast = 1, tier, levelMin, levelMax, idIncludes } = {}) {
  const r = scoreMessage(message);
  if (atLeast > 0) {
    assert.ok(r.signals.length >= atLeast,
      `expected ≥${atLeast} signal(s), got ${r.signals.length} for "${message}"\n` +
      `signals: ${JSON.stringify(r.signals, null, 2)}`);
  }
  if (tier)        assert.ok(r.signals.some(s => s.tier === tier),
                     `expected at least one ${tier}-tier signal for "${message}"`);
  if (idIncludes)  assert.ok(r.signals.some(s => s.id === idIncludes),
                     `expected signal id "${idIncludes}" for "${message}"`);
  if (Number.isFinite(levelMin)) assert.ok(r.level >= levelMin, `level ${r.level} < ${levelMin} for "${message}"`);
  if (Number.isFinite(levelMax)) assert.ok(r.level <= levelMax, `level ${r.level} > ${levelMax} for "${message}"`);
  return r;
}

// ── Basics & contract ───────────────────────────────────────────────

test('scoreMessage: empty / nullish input → zero level, no signals', () => {
  assert.deepEqual(scoreMessage(''),       { level: 0, signals: [] });
  assert.deepEqual(scoreMessage(null),     { level: 0, signals: [] });
  assert.deepEqual(scoreMessage(undefined), { level: 0, signals: [] });
  assert.deepEqual(scoreMessage(42),       { level: 0, signals: [] });
});

test('scoreMessage: neutral / innocuous text → no signals', () => {
  for (const msg of [
    'Hello, how are you?',
    'I had a great day today, thanks for asking!',
    'Can you help me write a poem about autumn?',
    'What time is it?',
    'I love this song.',
  ]) {
    const r = scoreMessage(msg);
    assert.deepEqual(r.signals, [], `unexpected signals on "${msg}": ${JSON.stringify(r.signals)}`);
    assert.equal(r.level, 0);
  }
});

// ── Severe tier ─────────────────────────────────────────────────────

test('severe: direct suicidal statements fire suicidal_direct', () => {
  for (const msg of [
    'I want to die.',
    "I'm going to kill myself.",
    "I wish I were dead.",
    "I don't want to be here anymore.",
    "Thinking about suicide a lot lately.",
  ]) {
    assertScored(msg, { tier: 'severe', idIncludes: 'suicidal_direct', levelMin: 1 });
  }
});

test('severe: self-harm language fires self_harm', () => {
  for (const msg of ['I want to hurt myself.', "I've been cutting again.", 'self-harm is hard to stop']) {
    assertScored(msg, { tier: 'severe', idIncludes: 'self_harm' });
  }
});

test('severe: acute crisis plan fires crisis_plan', () => {
  for (const msg of ['I have the pills.', 'I have a plan.', 'This is goodbye forever.']) {
    assertScored(msg, { tier: 'severe', idIncludes: 'crisis_plan' });
  }
});

// ── High tier ───────────────────────────────────────────────────────

test('high: hopelessness fires', () => {
  for (const msg of ["What's the point anymore?", 'Nothing matters.', 'There is no hope left.']) {
    assertScored(msg, { tier: 'high', idIncludes: 'hopelessness' });
  }
});

test('high: severe isolation fires', () => {
  for (const msg of ['No one cares about me.', "I'm completely alone.", 'I have no one.']) {
    assertScored(msg, { tier: 'high', idIncludes: 'severe_isolation' });
  }
});

test('high: can\'t-continue language fires', () => {
  for (const msg of ["I can't take it anymore.", "I can't keep doing this.", "I've reached my breaking point."]) {
    assertScored(msg, { tier: 'high', idIncludes: 'cant_continue' });
  }
});

// ── Moderate tier ───────────────────────────────────────────────────

test('moderate: severe distress fires', () => {
  for (const msg of ['I am really struggling.', 'I am falling apart.', 'I can\'t cope.']) {
    assertScored(msg, { tier: 'moderate' });
  }
});

test('moderate: dissociation fires', () => {
  for (const msg of ['I feel numb.', "I don't feel like myself.", 'Dissociating again.']) {
    assertScored(msg, { tier: 'moderate', idIncludes: 'dissociation' });
  }
});

test('moderate: panic fires', () => {
  for (const msg of ["I'm having a panic attack.", "I can't breathe.", 'My heart is racing.']) {
    assertScored(msg, { tier: 'moderate', idIncludes: 'panic' });
  }
});

// ── Mild tier ───────────────────────────────────────────────────────

test('mild: sadness / bad-day fires', () => {
  for (const msg of ['I feel really sad today.', 'Having a rough day.']) {
    assertScored(msg, { tier: 'mild', idIncludes: 'sadness' });
  }
});

test('mild: anxiety / worry fires', () => {
  for (const msg of ["I'm so anxious.", "I can't sleep.", 'I feel overwhelmed.']) {
    assertScored(msg, { tier: 'mild', idIncludes: 'worry' });
  }
});

// ── Safety signals (reduce threat) ─────────────────────────────────

test('safety: reassurance contributes negative weight', () => {
  const r = scoreMessage("I'm okay now, just wanted to check in.");
  assert.ok(r.signals.some(s => s.id === 'reassurance'));
  assert.ok(r.level < 0, `expected negative level for reassurance, got ${r.level}`);
});

test('safety: support engagement contributes negative weight', () => {
  const r = scoreMessage("I talked to my therapist yesterday.");
  assert.ok(r.signals.some(s => s.id === 'support_engagement'));
  assert.ok(r.level < 0);
});

// ── Damping (false-positive avoidance) ──────────────────────────────

test('damping: negation reduces severe signal weight to ~20%', () => {
  const direct  = scoreMessage('I want to die.');
  const negated = scoreMessage("I don't want to die.");
  assert.ok(direct.level   > negated.level, 'negation should reduce level');
  assert.ok(negated.signals.find(s => s.id === 'suicidal_direct')?.damped, 'should be flagged damped');
  // 20% damp on weight 8 = 1.6
  assert.ok(negated.level < 2, `expected damped level < 2, got ${negated.level}`);
});

test('damping: hypothetical reduces signal weight', () => {
  const direct      = scoreMessage('I want to die.');
  const hypothetical = scoreMessage('What if someone says they want to die?');
  assert.ok(hypothetical.level < direct.level);
  assert.ok(hypothetical.signals.find(s => s.id === 'suicidal_direct')?.damped);
});

test('damping: others-speech reduces signal weight', () => {
  const direct = scoreMessage('I want to die.');
  const others = scoreMessage('My friend told me she wanted to die.');
  assert.ok(others.level < direct.level);
});

test('damping: hyperbolic / joking context reduces signal weight', () => {
  const serious = scoreMessage("I can't take it anymore.");
  const joking  = scoreMessage("lol I can't take it anymore, this meme is too good 😂");
  assert.ok(joking.level < serious.level);
});

test('damping: SAFETY signals damped to ZERO, not 0.2× (negated reassurance must not reduce threat)', () => {
  const r = scoreMessage("I'm not okay.");
  // "I'm okay" pattern matches, but "not" negates → safety contributes 0.
  const reassurance = r.signals.find(s => s.id === 'reassurance');
  if (reassurance) {
    assert.equal(reassurance.weight, 0, 'damped safety signal must contribute zero, not negative');
  }
  // Total level must not be negative.
  assert.ok(r.level >= 0, `negated "I'm okay" produced negative level ${r.level}`);
});

// ── Aggregation & caps ──────────────────────────────────────────────

test('aggregation: multiple distinct signals add up', () => {
  const r = scoreMessage("I feel numb. I can't sleep. I'm really struggling.");
  assert.ok(r.signals.length >= 3, `expected ≥3 signals, got ${r.signals.length}`);
  assert.ok(r.level > 3, `expected level > 3 from three moderate-ish signals, got ${r.level}`);
});

test('aggregation: a single signal does not double-count when repeated', () => {
  const single = scoreMessage('I want to die.');
  const repeat = scoreMessage('I want to die. I want to die. I want to die.');
  // suicidal_direct only fires once per message
  assert.equal(
    repeat.signals.filter(s => s.id === 'suicidal_direct').length,
    1,
    'a signal should fire at most once per message',
  );
  assert.equal(single.level, repeat.level);
});

test('cap: a single message can\'t push level above SCORE_CAPS.max', () => {
  const overloaded = scoreMessage(
    "I want to die. I have a plan. I want to hurt myself. " +
    "There's no point. I can't go on. I'm completely alone."
  );
  assert.ok(overloaded.level <= SCORE_CAPS.max,
    `level ${overloaded.level} exceeded cap ${SCORE_CAPS.max}`);
});

test('cap: pure safety message can\'t push level below SCORE_CAPS.min', () => {
  const reassuring = scoreMessage(
    "I'm okay. I'm safe. I'm feeling better. " +
    "I talked to my therapist. I called the hotline. " +
    "Things are getting better."
  );
  assert.ok(reassuring.level >= SCORE_CAPS.min,
    `level ${reassuring.level} below floor ${SCORE_CAPS.min}`);
});

// ── Mixed signals (the realistic case) ─────────────────────────────

test('mixed: distress + reassurance partially offset', () => {
  const r = scoreMessage("I was really struggling earlier, but I'm okay now.");
  assert.ok(r.signals.some(s => s.tier === 'moderate'));
  assert.ok(r.signals.some(s => s.tier === 'safety'));
  // The net effect should be near zero or slightly negative.
  assert.ok(r.level <= 1, `expected near-zero net level, got ${r.level}`);
});

// ── Audit shape ─────────────────────────────────────────────────────

test('audit: every fired signal exposes id, tier, weight, damped flag, match text', () => {
  const r = scoreMessage("I want to die.");
  for (const s of r.signals) {
    assert.ok(typeof s.id     === 'string');
    assert.ok(typeof s.tier   === 'string');
    assert.ok(typeof s.weight === 'number');
    assert.ok(typeof s.damped === 'boolean');
    assert.ok(typeof s.match  === 'string' && s.match.length > 0);
  }
});

test('SIGNALS array is frozen (tuning happens in source)', () => {
  assert.throws(() => { SIGNALS.push({ id: 'x', tier: 'mild', weight: 1, patterns: [] }); }, TypeError);
});
