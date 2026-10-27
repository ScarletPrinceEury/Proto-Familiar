// Promises I make in chat get a timed intention behind them (0.14.99,
// src/schedule/promise-catch.js + promise-time.js), and a newly due intention
// ends the noticing cool-down (src/safety/noticing-loop.js).
//
// The case that started it: on a Monday at 18:03 I promised work "tonight".
// The memorization pass only caught it near midnight, as a timeless follow-up,
// and nothing woke me for it. Read on Tuesday, "tonight" would have meant
// Tuesday night.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePromiseTime, anchorRelativeWords, normalizeWhen, effectiveDayMs, naiveMs, naiveLabel,
} from '../src/schedule/promise-time.js';
import {
  promiseCue, parsePromises, backPromise, backPromises, catchPromisesAfterTurn, saidAtFor,
  heldPromisesSince, buildPromisePrompt, PROMISE_SOURCE,
} from '../src/schedule/promise-catch.js';
import { processJob } from '../src/memory/memorization.js';
import { freshDueIntentions } from '../src/safety/noticing-loop.js';
import { buildSituationReport } from '../src/safety/noticing.js';

const MON_1803 = '2026-10-26T18:03:00';
const TUE_0005 = '2026-10-27T00:05:00';
const TUE_0030 = '2026-10-27T00:30:00';

// ── When a promise comes back (promise-time.js) ───────────────────────

test('"tonight" said Monday 18:03 comes back Monday 18:33, and stays Monday when caught after midnight', () => {
  const t = resolvePromiseTime({ day: 'today', part: 'evening' }, MON_1803);
  assert.equal(t.at, '2026-10-26T18:33:00', 'evening had already begun, so 30 minutes after I said it');
  assert.equal(t.late, false);
  assert.equal(t.forLabel, 'Monday evening (26 Oct)');
  const caughtLate = resolvePromiseTime({ day: 'today', part: 'evening' }, MON_1803, TUE_0005);
  assert.equal(caughtLate.at, '2026-10-26T18:33:00', 'read from when I said it, not when it was caught');
  assert.equal(caughtLate.late, true, 'its time had passed by the catch, so it is due at once');
  // Caught the next morning (an overnight backstop): still Monday's evening, not Tuesday's.
  const nextMorning = resolvePromiseTime({ day: 'today', part: 'evening' }, MON_1803, '2026-10-27T09:00:00');
  assert.equal(nextMorning.at, '2026-10-26T18:33:00');
  assert.equal(nextMorning.late, true);
});

test('after midnight, "tonight" means now and "tomorrow" means the coming day', () => {
  assert.equal(resolvePromiseTime({ day: 'today', part: 'evening' }, TUE_0030).at, '2026-10-27T01:00:00');
  assert.equal(resolvePromiseTime({ day: 'tomorrow' }, TUE_0030).at, '2026-10-27T08:00:00');
  assert.equal(new Date(effectiveDayMs(naiveMs(TUE_0030))).getUTCDate(), 26, 'before 05:00 still belongs to Monday');
});

test('days, parts and clock times resolve in code', () => {
  const at = (w, said = MON_1803) => resolvePromiseTime(w, said).at;
  assert.equal(at({ day: 'tomorrow' }), '2026-10-27T08:00:00', 'a later day with no time is its morning');
  assert.equal(at({ day: 'tomorrow', part: 'afternoon' }), '2026-10-27T12:00:00');
  assert.equal(at({ day: 'wednesday', part: 'evening' }), '2026-10-28T17:00:00');
  assert.equal(at({ day: 'monday' }), '2026-10-26T20:03:00', 'the same weekday is today: later today');
  assert.equal(at({ day: 'today', time: '21:30' }), '2026-10-26T21:30:00');
  assert.equal(at({ day: 'today', time: '01:00' }), '2026-10-27T01:00:00', 'a small-hours time belongs to that night');
  assert.equal(at({ day: 'today', part: 'soon' }), '2026-10-26T18:33:00');
  assert.equal(at({}), '2026-10-26T20:03:00', 'no time given: two hours later, same day');
  assert.equal(resolvePromiseTime({ day: 'next_contact' }, MON_1803).kind, 'on_next_contact');
  assert.equal(resolvePromiseTime({ day: 'today' }, 'not a time'), null);
});

test('normalizeWhen keeps only the fixed vocabulary and real clock times', () => {
  assert.deepEqual(normalizeWhen({ day: 'Someday', part: 'brunch', time: '25:00' }), { day: 'none', part: 'none', time: null });
  assert.deepEqual(normalizeWhen({ day: 'tonight' }), { day: 'today', part: 'evening', time: null });
  assert.deepEqual(normalizeWhen({ day: 'Friday', part: 'Morning', time: '9:05' }), { day: 'friday', part: 'morning', time: '09:05' });
});

test('relative words are pinned to the day I said them', () => {
  assert.equal(
    anchorRelativeWords('First pass tonight, the rest tomorrow morning; today was long.', MON_1803),
    'First pass Monday night (26 Oct), the rest Tuesday morning (27 Oct); Monday 26 Oct was long.',
  );
  assert.equal(anchorRelativeWords('I finish it tomorrow', TUE_0030), 'I finish it Tuesday 27 Oct');
  assert.equal(naiveLabel(MON_1803), 'Monday 26 Oct, 18:03');
});

// ── The cheap check ───────────────────────────────────────────────────

test('promiseCue needs a promise and a later time in the same sentence', () => {
  assert.equal(promiseCue("Got it. I'll draft that tonight."), true);
  assert.equal(promiseCue('Let me look into it later'), true);
  assert.equal(promiseCue('I’ll check on Wednesday.'), true, 'curly apostrophe');
  assert.equal(promiseCue('Tonight was lovely. I will grab tea.'), false, 'separate sentences');
  assert.equal(promiseCue('How was your evening?'), false);
  assert.equal(promiseCue('<｜DSML｜tool_calls><｜DSML｜invoke name="x"></｜DSML｜invoke></｜DSML｜tool_calls>'), false);
});

test('parsePromises reads the reply, and garbage reads as nothing', () => {
  const out = parsePromises('```json\n{"promises":[{"what":"I look up the bus times","day":"today","part":"evening","time":"none"},{"what":""}]}\n```');
  assert.equal(out.length, 1);
  assert.equal(out[0].what, 'I look up the bus times');
  assert.deepEqual(out[0].when, { day: 'today', part: 'evening', time: null });
  assert.deepEqual(parsePromises('no json here'), []);
  assert.deepEqual(parsePromises('{"promises": [1,'), []);
});

test('the prompt says who I was talking to and what tools the turn used', () => {
  const p = buildPromisePrompt({ heard: 'can you?', reply: "I'll do it tonight", partner: 'Claude Code', toolsUsed: ['read_file', 'read_file'] });
  assert.match(p, /my chat with Claude Code/);
  assert.match(p, /Tools I used in that turn: read_file\./);
  assert.doesNotMatch(p, /\{\{/, 'no macro tokens left in');
});

// ── Backing a promise ─────────────────────────────────────────────────

function unruhStub({ intentions = [], setResult = null, listDown = false } = {}) {
  const calls = { set: [], followups: [] };
  return {
    calls,
    deps: {
      settings: { intentionOpenOneShots: 30 },
      listIntentions: async () => (listDown ? { ok: false, error: 'unruh not connected' } : { ok: true, intentions }),
      setIntention: async (a) => { calls.set.push(a); return setResult ?? { ok: true, id: 'i-draft-x7' }; },
      createSessionFollowup: async (a) => { calls.followups.push(a); return { ok: true, created: true }; },
    },
  };
}

test('backPromise keeps a timed intention, worded from when I said it', async () => {
  const u = unruhStub();
  const r = await backPromise({ what: 'I draft the intro tonight', when: { day: 'today', part: 'evening' }, saidAt: MON_1803, now: MON_1803, partner: 'Claude Code', deps: u.deps });
  assert.equal(r.id, 'i-draft-x7');
  assert.equal(u.calls.set.length, 1);
  const set = u.calls.set[0];
  assert.deepEqual(set.trigger, { kind: 'at', at: '2026-10-26T18:33:00' });
  assert.equal(set.source, PROMISE_SOURCE);
  assert.equal(set.what, 'I draft the intro Monday night (26 Oct)', 'no bare "tonight" is stored');
  assert.equal(set.why, "I told Claude Code I'd do this Monday evening (26 Oct) (said Monday 26 Oct, 18:03).");
});

test('a promise caught late says when the app picked it up', async () => {
  const u = unruhStub();
  const r = await backPromise({ what: 'I draft the intro', when: { day: 'today', part: 'evening' }, saidAt: MON_1803, now: TUE_0005, deps: u.deps });
  assert.equal(r.late, true);
  assert.match(u.calls.set[0].why, /The app only picked the promise up at Tuesday 27 Oct, 00:05, after that time\./);
  assert.equal(u.calls.set[0].trigger.at, '2026-10-26T18:33:00', 'already past, so due straight away');
});

test('a promise I already hold is not filed twice', async () => {
  const u = unruhStub({ intentions: [{ id: 'mine-a1', what: 'I draft the intro Monday night (26 Oct) and send it', trigger: { kind: 'at' } }] });
  const r = await backPromise({ what: 'I draft the intro tonight', when: { day: 'today' }, saidAt: MON_1803, now: MON_1803, deps: u.deps });
  assert.equal(r.deduped, 'mine-a1');
  assert.equal(u.calls.set.length, 0);
});

test('Unruh down, a full cap, or a failed write keeps the promise in my tome instead', async () => {
  const down = unruhStub({ listDown: true });
  assert.equal((await backPromise({ what: 'I check the oven', when: {}, saidAt: MON_1803, now: MON_1803, deps: down.deps })).fallback, 'unruh-unavailable');
  assert.match(down.calls.followups[0].summary, /^I check the oven \(I told my human I'd do this later on Monday 26 Oct/);

  const full = unruhStub({ intentions: Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, what: `other thing number ${i}`, trigger: { kind: 'at' } })) });
  assert.equal((await backPromise({ what: 'I check the oven', when: {}, saidAt: MON_1803, now: MON_1803, deps: full.deps })).fallback, 'cap-full');
  assert.equal(full.calls.set.length, 0);

  const failed = unruhStub({ setResult: { ok: false, error: 'boom' } });
  assert.equal((await backPromise({ what: 'I check the oven', when: {}, saidAt: MON_1803, now: MON_1803, deps: failed.deps })).fallback, 'set-failed');
  assert.equal(failed.calls.followups.length, 1);
});

// ── The after-turn catch ──────────────────────────────────────────────

function turnDeps({ settings = {}, raw = '{"promises":[]}', callThrows = null } = {}) {
  const seen = { llm: [], backed: [], logged: [] };
  return {
    seen,
    deps: {
      readSettings: () => settings,
      callLLM: async (prompt) => { seen.llm.push(prompt); if (callThrows) throw callThrows; return raw; },
      backPromise: async (a) => { seen.backed.push(a); return { ok: true, id: 'i-1', what: a.what, at: 'x', late: false }; },
      log: async (e) => { seen.logged.push(e); return e; },
    },
  };
}

test('no cue, a backing tool, or the switch off: no call at all', async () => {
  for (const [args, reason] of [
    [{ reply: 'Sure, done.' }, 'no_cue'],
    [{ reply: "I'll remind you tomorrow.", toolsUsed: ['schedule_add_reminder'] }, 'backed_in_turn'],
  ]) {
    const t = turnDeps();
    const r = await catchPromisesAfterTurn({ ...args, deps: t.deps });
    assert.equal(r.reason, reason);
    assert.equal(t.seen.llm.length, 0);
  }
  const off = turnDeps({ settings: { followupsEnabled: false } });
  assert.equal((await catchPromisesAfterTurn({ reply: "I'll do it tonight.", deps: off.deps })).reason, 'disabled');
  assert.equal(off.seen.llm.length, 0);
});

test('a cue reads the exchange once and backs each promise with the time it was said', async () => {
  const t = turnDeps({ raw: '{"promises":[{"what":"I draft the intro","day":"today","part":"evening"},{"what":"I send the outline","day":"tomorrow"}]}' });
  const r = await catchPromisesAfterTurn({
    reply: "Got it. I'll draft the intro tonight and send the outline tomorrow.", heard: 'plan for tonight?',
    toolsUsed: ['read_file'], partner: 'Claude Code', saidAt: MON_1803, deps: t.deps,
  });
  assert.equal(r.reason, 'caught');
  assert.equal(t.seen.llm.length, 1);
  assert.match(t.seen.llm[0], /What Claude Code said:\n"""\nplan for tonight\?/);
  assert.equal(t.seen.backed.length, 2);
  assert.equal(t.seen.backed[0].saidAt, MON_1803);
  assert.equal(t.seen.backed[0].partner, 'Claude Code');
  assert.deepEqual(t.seen.backed[1].when, { day: 'tomorrow', part: 'none', time: null });
  assert.equal(t.seen.logged.at(-1).results.length, 2);
});

test('a failed call is logged and never throws into the turn', async () => {
  const t = turnDeps({ callThrows: new Error('provider 500') });
  const r = await catchPromisesAfterTurn({ reply: "I'll look tonight.", deps: t.deps });
  assert.equal(r.reason, 'llm_failed');
  assert.match(r.error, /provider 500/);
  const none = turnDeps({ raw: null });
  none.deps.callLLM = async () => null;
  assert.equal((await catchPromisesAfterTurn({ reply: "I'll look tonight.", deps: none.deps })).reason, 'no_connection');
});

// ── The memorization backstop ─────────────────────────────────────────

test('saidAtFor finds the message I quoted, else my last one', () => {
  const msgs = [
    { role: 'assistant', content: 'Morning! Coffee first.', timestamp: Date.UTC(2026, 9, 26, 9, 0) },
    { role: 'user', content: 'and tonight?' },
    { role: 'assistant', content: "Fine, I'll finish the outline tonight.", timestamp: Date.UTC(2026, 9, 26, 18, 3) },
    { role: 'assistant', content: 'Night!', timestamp: Date.UTC(2026, 9, 26, 23, 50) },
  ];
  assert.equal(saidAtFor("I'll finish the outline tonight", msgs, 'UTC'), MON_1803);
  assert.equal(saidAtFor('words I never said', msgs, 'UTC'), '2026-10-26T23:50:00');
  assert.equal(saidAtFor('x', [], 'UTC'), null);
});

test('PIPELINE: a follow-up from processJob becomes a timed intention from the message it quotes', async () => {
  const u = unruhStub();
  const prompts = [];
  const job = {
    sessionId: 's-prom-1', scope: 'session', topicId: 't', topicLabel: 'chat',
    provider: 'nanogpt', apiKey: 'sk-test', model: 'm', baseUrl: null, audienceTag: 'ward-private',
    messages: [
      { role: 'user', content: 'what is the plan for this evening, roughly?', speaker: 'Claude Code', timestamp: '2026-10-26T18:00:00Z' },
      { role: 'assistant', content: "I'll finish the outline tonight, then sleep.", timestamp: '2026-10-26T18:03:00Z' },
    ],
  };
  await processJob(job, {
    callProvider: async ({ messages }) => {
      prompts.push(messages[0].content);
      return { content: JSON.stringify({ facts: [{ content: 'We planned the evening.', category: 'basics', confidence: 1.0, temporality: 'episodic' }], relations: [], follow_ups: [{ what: 'I finish the outline', quote: "I'll finish the outline tonight", day: 'today', part: 'evening', time: 'none' }] }), finishReason: 'stop' };
    },
    getRegistry: async () => ({ villagers: [] }),
    getRememberMap: async () => null,
    getStandingConsent: async () => ({}),
    getScheduleWindow: async () => ({ nodes: [], linked: [] }),
    graphRelate: async () => ({ ok: true }),
    createMemoryFull: async () => ({ ok: true, id: 'mem-x' }),
    applyMemoryIntegrityGate: async ({ memoryArgs }) => ({ write: true, action: 'write', memoryArgs }),
    listTrackers: async () => ({ ok: true, trackers: [] }),
    logTrackerEntry: async () => ({ ok: true }),
    heldPromisesSince: async () => ['I already hold this one'],
    // The real backPromises (quote → timestamp) with the real backPromise, Unruh stubbed.
    backPromises: (items, opts) => backPromises(items, {
      ...opts, timeZone: 'UTC',
      deps: { backPromise: (a) => backPromise({ ...a, now: TUE_0005, deps: u.deps }), log: async (e) => e },
    }),
  });
  assert.match(prompts[0], /Already kept as intentions, so I leave these out:\n- I already hold this one/);
  assert.equal(u.calls.set.length, 1);
  assert.deepEqual(u.calls.set[0].trigger, { kind: 'at', at: '2026-10-26T18:33:00' });
  assert.match(u.calls.set[0].why, /^I told Claude Code I'd do this Monday evening \(26 Oct\) \(said Monday 26 Oct, 18:03\)\. The app only picked the promise up/);
});

test('heldPromisesSince lists only caught promises from the slice onward', async () => {
  const held = await heldPromisesSince('2026-10-26T12:00:00', { deps: { listIntentions: async () => ({ ok: true, intentions: [
    { what: 'old promise', source: PROMISE_SOURCE, created_at: '2026-10-25T10:00:00' },
    { what: 'new promise', source: PROMISE_SOURCE, created_at: '2026-10-26T18:04:00' },
    { what: 'my own', source: 'chat', created_at: '2026-10-26T18:05:00' },
  ] }) } });
  assert.deepEqual(held, ['new promise']);
});

// ── Noticing: a newly due intention ends the cool-down ────────────────

test('freshDueIntentions counts only intentions the last look had not covered', () => {
  const first = freshDueIntentions(['a', 'b'], new Set(['a']));
  assert.deepEqual(first.fresh, ['b']);
  const again = freshDueIntentions(['a', 'b'], new Set(['a', 'b']));
  assert.deepEqual(again.fresh, [], 'still due and already seen: no re-wake');
  const pruned = freshDueIntentions([], new Set(['a', 'b']));
  assert.equal(pruned.seen.size, 0, 'no longer due drops out of seen');
  assert.deepEqual(freshDueIntentions(['a'], pruned.seen).fresh, ['a'], 'due again later counts as new');
});

test('the situation report shows when a due intention was set for, and a caught promise reads as such', () => {
  const report = buildSituationReport([{ kind: 'due_intention', intention: {
    id: 'i-1', what: 'I draft the intro', why: "I told my human I'd do this Monday evening (26 Oct).", source: PROMISE_SOURCE,
    trigger: { kind: 'at', at: '2026-10-26T18:33:00' },
  } }], { relInterval: () => '' }).join(' | ');
  assert.match(report, /come due: I draft the intro \(I told my human I'd do this Monday evening \(26 Oct\)\.\) \[set for Monday 26 Oct, 18:33\] \[id i-1\]/);
  assert.doesNotMatch(report, /I set this because/);
});

test('PIPELINE: in a six-hour cool-down, a newly due intention gets a look, and a seen one does not', async () => {
  const { startNoticingLoop, stopNoticingLoop } = await import('../src/safety/noticing-loop.js');
  let due = [{ id: 'a', what: 'first', trigger: { kind: 'at', at: '2026-10-26T18:00:00' }, condition: {} }];
  const looks = [];
  const ticks = [];
  startNoticingLoop({
    tickMs: 10,
    getDueIntentionIds: async () => due.map(i => i.id),
    getThreat: async () => ({ tier: 'calm' }),
    getWakeInputs: async () => ({ dueIntentions: due, signals: {}, baseline: null, contactGapMs: 0, readiness: [], agingIntents: [], weekdayClass: 'weekday' }),
    deliberate: async ({ conditions }) => { looks.push(conditions.map(c => c.intention?.id)); return { toolNamesCalled: [], nextCheckInMs: 6 * 3600_000 }; },
    onTick: (r) => ticks.push(r),
  });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    await wait(80);
    assert.equal(looks.length, 1, 'one look, then the six-hour cool-down holds while "a" stays due');
    assert.ok(ticks.some(t => t.reason === 'in_cooldown'));
    due = [...due, { id: 'b', what: 'second', trigger: { kind: 'at', at: '2026-10-26T19:00:00' }, condition: {} }];
    await wait(80);
    assert.equal(looks.length, 2, 'the newly due "b" ended the cool-down');
    assert.ok(looks[1].includes('b'));
    assert.ok(ticks.some(t => t.dueWake === true), 'the wake is recorded on the tick');
  } finally { await stopNoticingLoop(); }
});
