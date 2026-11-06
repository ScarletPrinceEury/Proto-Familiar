// A shared web chat (0.14.122, ward decisions 2026-11-01).
//
// - What my human says about themselves while someone else is in the web chat
//   stays with the people who were there, like a Discord shared room (C2). The
//   web chat used to tell memory "my human's own room" for every message, so
//   such a fact was opened to anyone whose topic grants covered it.
// - The room is stamped per message, because people come and go mid-chat, and
//   the stamp survives the page saving its own copy of the conversation.
// - With others present the reply comes whole, so the outgoing check runs on it.
// - Picking someone in "Speaking as" hands them the chat until my human takes it
//   back (or 10 quiet minutes pass), and puts them in "who's here".
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { extractFunctionSource } from './_vm-extract.mjs';

// memorization.js reaches thalamus, which would spawn the real Phylactery and
// Unruh children — and a live child keeps `npm test` from ever exiting.
process.env.PROTO_FAMILIAR_PHYLACTERY_DISABLED = '1';
process.env.PROTO_FAMILIAR_UNRUH_DISABLED = '1';

const { mergeMessages, withStoredRooms, keepServerOwned, appendSessionMessages, writeSessionLog } = await import('../src/sessions/session-log.js');
const { createTurnRecorder } = await import('../src/sessions/turn-record.js');
const { collapseToolTurns } = await import('../message-sanitize.mjs');
const { roomRuns, processJobByRoom, processJob } = await import('../src/memory/memorization.js');

const ROOM = 'friends';

// ── The room stamp ────────────────────────────────────────────────────────

test('a message sent with someone else present is stored with the room; my human\'s own room leaves no stamp', async () => {
  const written = [];
  const make = (audienceTag) => createTurnRecorder({
    envelope: { turnId: `t-${audienceTag}`, userMessage: { id: `u-${audienceTag}`, role: 'user', content: 'hi', timestamp: '2026-11-01T10:00:00Z' }, replyMessageId: 'a1' },
    write: async (msgs) => { written.push(...msgs); return { ok: true }; },
    meta: { audienceTag },
  });
  await make(ROOM).begin();
  await make('ward-private').begin();
  assert.equal(written[0].audienceTag, ROOM);
  assert.equal('audienceTag' in written[1], false);
});

test('the page saving its own copy keeps the stamp it never carries', async () => {
  const stored = [{ id: 'u1', role: 'user', content: 'hi', audienceTag: ROOM, timestamp: '2026-11-01T10:00:00Z' }];
  const page = [{ id: 'u1', role: 'user', content: 'hi', timestamp: '2026-11-01T10:00:00Z' }, { id: 'a1', role: 'assistant', content: 'hey', timestamp: '2026-11-01T10:00:05Z' }];
  assert.equal(mergeMessages(stored, page)[0].audienceTag, ROOM, 'the merged save');
  assert.equal(keepServerOwned(stored[0], { ...page[0], audienceTag: 'other' }).audienceTag, 'other', 'a copy that carries its own value keeps it');
  assert.deepEqual(withStoredRooms(page, stored).map(m => m.audienceTag), [ROOM, undefined]);

  const logsDir = mkdtempSync(path.join(tmpdir(), 'pf-room-stamp-'));
  await appendSessionMessages('s-20261101-room', stored, { logsDir });
  await writeSessionLog({ sessionId: 's-20261101-room', messages: page }, { logsDir, merge: true });     // the page's POST /api/log
  await appendSessionMessages('s-20261101-room', [page[0]], { logsDir });                              // a recorder rewrite
  const log = JSON.parse(readFileSync(path.join(logsDir, 's-20261101-room.json'), 'utf8'));
  assert.equal(log.messages.find(m => m.id === 'u1').audienceTag, ROOM, 'both write paths keep it');
});

test('the stamp never reaches a provider', () => {
  const out = collapseToolTurns([{ role: 'user', content: 'hi', audienceTag: ROOM }, { role: 'assistant', content: 'hey' }]);
  assert.equal('audienceTag' in out[0], false);
});

// ── Memory, split by room ─────────────────────────────────────────────────

test('a slice splits where the room changed; replies go with the message they answer', () => {
  const runs = roomRuns([
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c', audienceTag: ROOM }, { role: 'tool', content: 'r' }, { role: 'assistant', content: 'd' },
    { role: 'user', content: 'e', audienceTag: ROOM },
    { role: 'user', content: 'f' },
  ], 'ward-private');
  assert.deepEqual(runs.map(r => [r.audienceTag, r.messages.map(m => m.content).join('')]),
    [['ward-private', 'ab'], [ROOM, 'crde'], ['ward-private', 'f']]);
  assert.equal(roomRuns([{ role: 'user', content: 'x' }], 'villager-dm').at(0).audienceTag, 'villager-dm', 'a Discord or voice log keeps its own tag');
});

test('each room is its own run, and coverage still adds up to the whole day', async () => {
  const calls = [];
  const job = { scope: 'day', topicId: '2026-11-01', priorThrough: 2, audienceTag: 'ward-private', messages: [
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c', audienceTag: ROOM }, { role: 'assistant', content: 'd' }, { role: 'assistant', content: 'e' },
  ] };
  const out = await processJobByRoom(job, {}, async (j) => { calls.push([j.audienceTag, j.messages.length, j.priorThrough]); return { factsCreated: 1, consentPending: 0, edgesRouted: 0 }; });
  assert.deepEqual(calls, [['ward-private', 2, 2], [ROOM, 3, 4]]);
  assert.equal(out.factsCreated, 2);
  const one = [];
  await processJobByRoom({ ...job, messages: job.messages.slice(0, 2) }, {}, async (j) => { one.push(j.audienceTag); return {}; });
  assert.deepEqual(one, ['ward-private'], 'one room, one call, as before');
});

test('outside a day slice, a run with nothing to keep is fine when another kept something', async () => {
  const job = { scope: 'session', audienceTag: 'ward-private', messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b', audienceTag: ROOM }] };
  const out = await processJobByRoom(job, {}, async (j) => { if (j.audienceTag === ROOM) throw new Error('No valid facts'); return { factsCreated: 1 }; });
  assert.equal(out.factsCreated, 1);
  await assert.rejects(processJobByRoom({ ...job, scope: 'day' }, {}, async () => { throw new Error('provider down'); }), /provider down/);
});

test('PIPELINE: a fact about my human said with a friend present stays with the room; one said alone stays content-gated', async () => {
  const written = [];
  const deps = {
    readSettings: () => ({ userName: 'Robin' }),
    callProvider: async ({ messages }) => {
      const text = messages.map(m => m.content).join('\n');
      const fact = text.includes('moving in March') ? 'I am moving in March.' : 'I like green tea.';
      return { content: JSON.stringify({ facts: [{ content: fact, category: 'basics', confidence: 1, temporality: 'standing' }], relations: [] }), finishReason: 'stop' };
    },
    getRegistry: async () => ({ villagers: [], categories: [{ id: ROOM, name: 'Friends', grants: {} }] }),
    getRememberMap: async () => null,
    getStandingConsent: async () => ({}),
    getScheduleWindow: async () => ({ nodes: [], linked: [] }),
    graphRelate: async () => ({ ok: true }),
    createMemoryFull: async (args) => { written.push(args); return { ok: true, id: `mem-${written.length}` }; },
    applyMemoryIntegrityGate: async ({ memoryArgs }) => ({ write: true, action: 'write', memoryArgs }),
    listTrackers: async () => ({ ok: true, trackers: [] }),
    logTrackerEntry: async () => ({ ok: true }),
    heldPromisesSince: async () => [],
    backPromises: async () => [],
  };
  await processJobByRoom({
    sessionId: 's-20261101-mix', scope: 'session', topicId: 't', topicLabel: 'chat',
    provider: 'nanogpt', apiKey: 'sk-test', model: 'm', baseUrl: null, audienceTag: 'ward-private',
    messages: [
      { role: 'user', content: 'I really like green tea.', timestamp: '2026-11-01T10:00:00Z' },
      { role: 'assistant', content: 'Noted, tea person.', timestamp: '2026-11-01T10:00:05Z' },
      { role: 'user', content: 'Oh, by the way, I am moving in March.', audienceTag: ROOM, timestamp: '2026-11-01T11:00:00Z' },
      { role: 'assistant', content: 'Big change!', timestamp: '2026-11-01T11:00:05Z' },
    ],
  }, deps);
  const byFact = Object.fromEntries(written.map(w => [w.content, w.audience]));
  assert.equal(byFact['I am moving in March.'], ROOM, 'said with a friend present → that room\'s circle');
  assert.equal(byFact['I like green tea.'], 'ward-content-gated', 'said alone → content-gated, as before');
});

test('PIPELINE: a one-room slice runs exactly as processJob alone does', async () => {
  const seen = [];
  const deps = { callProvider: async () => { throw new Error('stop here'); } };
  const job = { sessionId: 's-20261101-one', scope: 'day', topicId: '2026-11-01', provider: 'x', model: 'm', audienceTag: 'ward-private', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] };
  await assert.rejects(processJobByRoom(job, deps, async (j, d) => { seen.push(j); return processJob(j, d); }), /stop here/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].messages, job.messages);
});

// ── Streaming ─────────────────────────────────────────────────────────────

test('with someone else present a reply never streams unchecked; my human\'s own room streams as before', async () => {
  const { uncheckedStreamRefusal } = await import('../src/safety/outgoing-filter.js');
  assert.match(uncheckedStreamRefusal({ stream: true, audienceTag: ROOM })?.error ?? '', /Reload the page/);
  assert.equal(uncheckedStreamRefusal({ stream: true, audienceTag: 'ward-private' }), null);
  assert.equal(uncheckedStreamRefusal({ stream: false, audienceTag: ROOM }), null, 'a whole reply goes through the check');
});

// ── The page: the hand-over ───────────────────────────────────────────────

const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
// Values made inside the vm have its prototypes; compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));
const PAGE_FNS = ['sessionIsSharedRoom', 'renderSpeakerPicker', 'takeTurnSpeaker', 'renderHandoverBanner', 'startHandover',
  'endHandover', 'onSpeakerPicked', 'addAudienceParticipant', 'audienceAddName'];

function makePage({ registry = null } = {}) {
  const el = (extra = {}) => ({ hidden: false, value: '', textContent: '', innerHTML: '', classList: { toggle() {}, remove() {}, add() {} }, appendChild() {}, ...extra });
  const els = { 'speaker-picker': el(), 'handover-banner': el({ hidden: true }), 'handover-text': el() };
  const timers = [];
  const ctx = {
    HANDOVER_IDLE_MS: 10 * 60_000, _handover: null, _audienceReg: null,
    state: { userName: 'Robin', webSpeakers: ['Sam'], sessionAudience: { location: null, participants: [] } },
    $: (id) => els[id] ?? null,
    document: { createElement: () => el() },
    saveSettings() {}, renderAudienceChips() {}, updateAudienceBtn() {},
    fetch: async () => ({ ok: !!registry, json: async () => registry }),
    setInterval: (fn) => { timers.push(fn); return timers.length; }, clearInterval() {},
    Date,
  };
  const src = PAGE_FNS.map(n => {
    const fn = extractFunctionSource(APP, n);
    const at = APP.indexOf(fn);
    return (APP.slice(at - 6, at) === 'async ' ? 'async ' : '') + fn;
  });
  runInNewContext(src.join('\n'), ctx);
  ctx.renderSpeakerPicker();
  const pick = (name) => { els['speaker-picker'].value = name; ctx.onSpeakerPicked({ target: els['speaker-picker'] }); };
  return { ctx, els, timers, pick };
}

describe('the hand-over', () => {
  test('picking someone hands them the chat: every message is theirs, a banner says so, and they\'re in who\'s here at once', () => {
    const { ctx, els, pick } = makePage();
    assert.equal(ctx.sessionIsSharedRoom(), false);
    pick('Sam');
    assert.equal(ctx.takeTurnSpeaker(), 'Sam');
    assert.equal(ctx.takeTurnSpeaker(), 'Sam', 'it stays theirs');
    assert.equal(els['handover-banner'].hidden, false);
    assert.match(els['handover-text'].textContent, /^Sam has the chat\./);
    assert.deepEqual(plain(ctx.state.sessionAudience.participants.map(p => p.name)), ['Sam']);
    assert.equal(ctx.sessionIsSharedRoom(), true, 'so the next reply is gated and comes whole');
  });

  test('"Me again" gives it back; they stay in who\'s here', () => {
    const { ctx, els, pick } = makePage();
    pick('Sam');
    ctx.endHandover();
    assert.equal(ctx.takeTurnSpeaker(), null);
    assert.equal(els['handover-banner'].hidden, true);
    assert.equal(ctx.state.sessionAudience.participants.length, 1);
  });

  test('10 quiet minutes give it back; a message from them restarts the clock', () => {
    const { ctx, timers, pick } = makePage();
    pick('Sam');
    ctx._handover.lastAt = Date.now() - 9 * 60_000;
    assert.equal(ctx.takeTurnSpeaker(), 'Sam');
    timers.at(-1)();
    assert.equal(ctx._handover?.name, 'Sam', 'they just sent something');
    ctx._handover.lastAt = Date.now() - 10 * 60_000;
    timers.at(-1)();
    assert.equal(ctx._handover, null);
    assert.equal(ctx.takeTurnSpeaker(), null);
  });

  test('taken off the list mid-hand-over, it\'s my human\'s again', () => {
    const { ctx, pick } = makePage();
    pick('Sam');
    ctx.state.webSpeakers = [];
    ctx.renderSpeakerPicker();
    assert.equal(ctx._handover, null);
  });

  test('a villager lands with their own entry once the registry loads; nobody is added twice', async () => {
    const { ctx } = makePage({ registry: { villagers: [{ id: 'v-sam', name: 'Sam' }] } });
    await ctx.audienceAddName('sam');
    assert.deepEqual(plain(ctx.state.sessionAudience.participants), [{ id: 'v-sam', name: 'Sam' }]);
    ctx.addAudienceParticipant('SAM');
    ctx.addAudienceParticipant('Sam');
    assert.equal(ctx.state.sessionAudience.participants.length, 1);
  });
});
