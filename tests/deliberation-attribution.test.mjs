// Deliberations can't mislabel who spoke — the context slice is honest about
// its room, and a no-ward slice says so. Covers the bug where a warm reach-out
// DM'd my human about a question a VILLAGER asked in a group room (the most
// recently-touched log), because every `user` turn wore one label and the slice
// never said which room it came from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  formatRecentMessagesForContext,
  formatSliceProvenanceLines,
  getRecentSessionMessages,
  logHasWardTurn,
} from '../cerebellum.js';
import { sessionLogKind, isWardReadableLog } from '../src/sessions/session-search.js';
import { recordReachOut, recentReachOuts, formatReachOutBlock } from '../src/warmth/reach-out-log.js';
import { runOneReachoutTick } from '../src/warmth/reachout-loop.js';

const NOW = Date.parse('2026-09-12T12:00:00Z');
const iso = (minsAgo) => new Date(NOW - minsAgo * 60_000).toISOString();

// ── §2.1 formatRecentMessagesForContext renders the real speaker ────────────

test('formatRecentMessagesForContext: a villager turn wears the speaker, not a blanket Them', () => {
  const out = formatRecentMessagesForContext([
    { role: 'user', content: 'whose question was this', speaker: 'Alice Villager', timestamp: iso(30) },
    { role: 'assistant', content: 'my reply', timestamp: iso(29) },
  ], NOW);
  assert.match(out, /\[alice-villager · /, 'villager speaker resolved to a name-field handle');
  assert.match(out, /\bMe\b.*my reply/);
  assert.doesNotMatch(out, /Them/, 'a named speaker is never flattened to Them');
});

test('formatRecentMessagesForContext: a turn with no speaker stays Them (ward-private unchanged)', () => {
  const out = formatRecentMessagesForContext([
    { role: 'user', content: 'my own words', timestamp: iso(10) },
  ], NOW);
  assert.match(out, /\[Them · /);
});

test('formatRecentMessagesForContext: NAME_FIELDS_DISABLED falls back to Them/Me', () => {
  process.env.PROTO_FAMILIAR_NAME_FIELDS_DISABLED = '1';
  try {
    const out = formatRecentMessagesForContext([
      { role: 'user', content: 'x', speaker: 'Alice', timestamp: iso(5) },
    ], NOW);
    assert.match(out, /\[Them · /, 'speaker rendering is off under the master switch');
  } finally { delete process.env.PROTO_FAMILIAR_NAME_FIELDS_DISABLED; }
});

// §5 regression pin — a ward-private slice with no speaker fields is byte-identical.
test('formatRecentMessagesForContext: no-speaker rows render byte-identical to the pre-fix form', () => {
  const msgs = [
    { role: 'user', content: 'plain string message', timestamp: '2026-07-25T11:00:00Z' },
    { role: 'assistant', content: [{ type: 'text', text: 'array content message' }], timestamp: '2026-07-25T11:30:00Z' },
    { role: 'user', content: '' },
  ];
  const now = Date.parse('2026-07-25T12:00:00Z');
  const expected = [
    '  [Them · about an hour ago]: plain string message',
    '  [Me · 30 minutes ago]: array content message',
  ].join('\n');
  assert.equal(formatRecentMessagesForContext(msgs, now), expected);
});

// ── sessionLogKind + isWardReadableLog (one rule source) ────────────────────

test('sessionLogKind: derives each kind from audienceTag / location', () => {
  assert.equal(sessionLogKind({ audienceTag: null }), 'ward-private');
  assert.equal(sessionLogKind({ audienceTag: 'ward-private' }), 'ward-private');
  assert.equal(sessionLogKind({ audienceTag: 'circle-x', location: { kind: 'group' } }), 'group');
  assert.equal(sessionLogKind({ audienceTag: 'circle-x', location: { kind: 'guild', key: 'discord:guild:1:channel:2' } }), 'group');
  assert.equal(sessionLogKind({ audienceTag: 'v', location: { kind: 'villager-dm', key: 'discord:dm:9' } }), 'villager-dm');
  assert.equal(sessionLogKind({ audienceTag: 'v', location: { key: 'discord:dm:9' } }), 'villager-dm');
  assert.equal(sessionLogKind({ audienceTag: 'weird' }), 'unknown');
});

test('isWardReadableLog: behaviour pinned across kinds (ward-private + group readable; villager-dm + unknown not)', () => {
  assert.equal(isWardReadableLog({ audienceTag: null }), true);
  assert.equal(isWardReadableLog({ audienceTag: 'ward-private' }), true);
  assert.equal(isWardReadableLog({ audienceTag: 'c', location: { key: 'discord:guild:1:channel:2' } }), true);
  assert.equal(isWardReadableLog({ audienceTag: 'v', location: { key: 'discord:dm:9' } }), false);
  assert.equal(isWardReadableLog({ audienceTag: 'weird' }), false);
});

// ── §2.3 formatSliceProvenanceLines ─────────────────────────────────────────

test('formatSliceProvenanceLines: group room with no ward turn → room line + the no-ward sentence', () => {
  const out = formatSliceProvenanceLines(
    { kind: 'group', label: 'the kitchen', roster: ['Alice', 'Bob'], hasWardTurn: false },
    { wardLastSeenPhrase: '2 days ago' },
  );
  assert.match(out, /\[Recent conversation — from the group room "the kitchen"; speakers: Alice, Bob\]/);
  assert.match(out, /None of the messages below are from my human/);
  assert.match(out, /last turn anywhere was 2 days ago/);
});

test('formatSliceProvenanceLines: a ward-present private slice emits nothing (tuned framing kept)', () => {
  assert.equal(formatSliceProvenanceLines({ kind: 'ward-private', hasWardTurn: true }), '');
});

test('formatSliceProvenanceLines: group WITH a ward turn still states the room, no no-ward sentence', () => {
  const out = formatSliceProvenanceLines({ kind: 'group', label: 'r', roster: ['Alice'], hasWardTurn: true });
  assert.match(out, /from the group room/);
  assert.doesNotMatch(out, /None of the messages below/);
});

test('formatSliceProvenanceLines: off under NAME_FIELDS_DISABLED and for a null session', () => {
  assert.equal(formatSliceProvenanceLines(null), '');
  process.env.PROTO_FAMILIAR_NAME_FIELDS_DISABLED = '1';
  try { assert.equal(formatSliceProvenanceLines({ kind: 'group', hasWardTurn: false }), ''); }
  finally { delete process.env.PROTO_FAMILIAR_NAME_FIELDS_DISABLED; }
});

// ── §2.2 getRecentSessionMessages metadata (real reads of fixture logs) ─────

async function withLogs(files, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'delib-logs-'));
  let t = NOW - files.length * 60_000;
  for (const f of files) {
    const p = path.join(dir, `${f.name}.json`);
    await fsp.writeFile(p, JSON.stringify(f.log));
    // Touch mtime in order so the LAST entry is the most-recently-modified.
    t += 60_000;
    await fsp.utimes(p, new Date(t), new Date(t));
  }
  try { return await fn(dir); } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

test('getRecentSessionMessages: a group room (most recent) → kind group, roster dedup, hasWardTurn false', async () => {
  await withLogs([
    { name: 'old-ward', log: { sessionId: 's-ward', audienceTag: 'ward-private', messages: [{ role: 'user', content: 'hi', timestamp: iso(200) }] } },
    { name: 'live-room', log: {
      sessionId: 's-room', audienceTag: 'circle-friends',
      location: { kind: 'guild', key: 'discord:guild:1:channel:2', label: 'the kitchen' },
      messages: [
        { role: 'user', content: 'q1', speaker: 'Alice', timestamp: iso(10) },
        { role: 'user', content: 'q2', speaker: 'Bob', timestamp: iso(8) },
        { role: 'user', content: 'q3', speaker: 'Alice', timestamp: iso(6) },
        { role: 'assistant', content: 'reply', timestamp: iso(5) },
      ],
    } },
  ], async (dir) => {
    const turns = await getRecentSessionMessages({ logsDir: dir });
    assert.ok(turns.session, 'metadata attached');
    assert.equal(turns.session.kind, 'group');
    assert.equal(turns.session.label, 'the kitchen');
    assert.deepEqual(turns.session.roster, ['Alice', 'Bob'], 'roster deduped, user turns only');
    assert.equal(turns.session.hasWardTurn, false, 'no turn in this room is the ward\'s');
    assert.equal(turns.session.sessionId, 's-room');
  });
});

test('getRecentSessionMessages: a ward-private log → kind ward-private, hasWardTurn true (no speaker = the ward)', async () => {
  await withLogs([
    { name: 'ward', log: { sessionId: 's-ward', audienceTag: 'ward-private', messages: [
      { role: 'user', content: 'my own words', timestamp: iso(12) },
      { role: 'assistant', content: 'reply', timestamp: iso(11) },
    ] } },
  ], async (dir) => {
    const turns = await getRecentSessionMessages({ logsDir: dir });
    assert.equal(turns.session.kind, 'ward-private');
    assert.equal(turns.session.hasWardTurn, true);
    assert.deepEqual(turns.session.roster, [], 'ward-private turns carry no speaker');
  });
});

// ── slice-selection policy (follow-up): prefer:'ward' ───────────────────────

test("getRecentSessionMessages prefer:'ward' → skips a more-recent group room for the ward's own session", async () => {
  await withLogs([
    { name: 'ward-own', log: { sessionId: 's-ward', audienceTag: 'ward-private', messages: [
      { role: 'user', content: 'I had a rough morning', timestamp: iso(120) },
      { role: 'assistant', content: 'tell me about it', timestamp: iso(119) },
    ] } },
    // Most-recently-touched is a group room with NONE of my human's turns.
    { name: 'live-room', log: {
      sessionId: 's-room', audienceTag: 'circle-friends',
      location: { kind: 'guild', key: 'discord:guild:1:channel:2', label: 'the kitchen' },
      messages: [ { role: 'user', content: 'pizza later?', speaker: 'Alice', timestamp: iso(4) } ],
    } },
  ], async (dir) => {
    const recent = await getRecentSessionMessages({ logsDir: dir, prefer: 'recent' });
    assert.equal(recent.session.kind, 'group', 'default still takes the most-recent log');

    const ward = await getRecentSessionMessages({ logsDir: dir, prefer: 'ward' });
    assert.equal(ward.session.kind, 'ward-private', 'ward-preferred reaches back to my human\'s own session');
    assert.equal(ward.session.hasWardTurn, true);
    assert.match(formatRecentMessagesForContext(ward, NOW), /rough morning/);
  });
});

test('logHasWardTurn: a group room where my human speaks counts as theirs (ward detected by name slug)', () => {
  // ward-private log with no speaker → theirs via kind.
  assert.equal(logHasWardTurn({ audienceTag: 'ward-private', messages: [{ role: 'user', content: 'x' }] }, 'maus'), true);
  // group room, my human speaks (speaker slugs to the ward name) → theirs.
  assert.equal(logHasWardTurn({ audienceTag: 'circle', location: { kind: 'guild', key: 'discord:guild:1:channel:2' },
    messages: [{ role: 'user', content: 'hi', speaker: 'Alice' }, { role: 'user', content: 'not great today', speaker: 'Maus' }] }, 'maus'), true);
  // group room, only villagers → not theirs.
  assert.equal(logHasWardTurn({ audienceTag: 'circle', location: { kind: 'guild', key: 'discord:guild:1:channel:2' },
    messages: [{ role: 'user', content: 'hi', speaker: 'Alice' }] }, 'maus'), false);
  // ward-private but no ward name configured → a no-speaker turn is still theirs (kind).
  assert.equal(logHasWardTurn({ audienceTag: null, messages: [{ role: 'user', content: 'x' }] }, ''), true);
});

test("getRecentSessionMessages prefer:'ward' → falls back to the most-recent log when the ward has spoken in none", async () => {
  await withLogs([
    { name: 'room-a', log: { sessionId: 's-a', audienceTag: 'circle-x', location: { kind: 'guild', key: 'discord:guild:1:channel:2', label: 'a' }, messages: [ { role: 'user', content: 'x', speaker: 'Alice', timestamp: iso(30) } ] } },
    { name: 'room-b', log: { sessionId: 's-b', audienceTag: 'circle-y', location: { kind: 'guild', key: 'discord:guild:3:channel:4', label: 'b' }, messages: [ { role: 'user', content: 'y', speaker: 'Bob', timestamp: iso(5) } ] } },
  ], async (dir) => {
    const ward = await getRecentSessionMessages({ logsDir: dir, prefer: 'ward' });
    assert.equal(ward.session.sessionId, 's-b', 'no ward turn anywhere → most-recent log');
    assert.equal(ward.session.hasWardTurn, false, 'and the slice is honestly flagged as not theirs');
  });
});

// ── §2.4 the receipt: source on the reach-out log ───────────────────────────

test('recordReachOut + formatReachOutBlock: source is stored and rendered', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ro-log-'));
  try {
    await recordReachOut({
      message: 'I was thinking about the question in the kitchen',
      channel: 'ward-banner',
      source: { sessionId: 's-room', kind: 'group', roster: ['Alice', 'Bob'], hasWardTurn: false },
      tomesDir: dir, now: NOW,
    });
    const items = await recentReachOuts({ tomesDir: dir, now: NOW });
    assert.equal(items.length, 1);
    assert.equal(items[0].source.kind, 'group');
    assert.equal(items[0].source.sessionId, 's-room');
    const block = formatReachOutBlock(items, { now: NOW });
    assert.match(block, /where this came from: group \(session s-room\), speakers: Alice, Bob/);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('recordReachOut: legacy entry with no source renders as before (optional field)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ro-log-'));
  try {
    await recordReachOut({ message: 'thinking of you', tomesDir: dir, now: NOW });
    const items = await recentReachOuts({ tomesDir: dir, now: NOW });
    assert.equal(items[0].source, undefined);
    const block = formatReachOutBlock(items, { now: NOW });
    assert.doesNotMatch(block, /where this came from/);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

// ── PIPELINE: fixture group log (no ward turn) → real slice → real prompt
//    assembly (the exact functions reach-out uses) carries the honest lines;
//    and the loop threads `source` from the decision to the ward knock. ──────

test('PIPELINE: a group-room slice assembles a prompt that names the room and flags the no-ward slice', async () => {
  await withLogs([
    { name: 'live-room', log: {
      sessionId: 's-room', audienceTag: 'circle-friends',
      location: { kind: 'guild', key: 'discord:guild:1:channel:2', label: 'the kitchen' },
      messages: [
        { role: 'user', content: 'do you two want to come over?', speaker: 'Alice', timestamp: iso(20) },
        { role: 'user', content: 'sounds good', speaker: 'Bob', timestamp: iso(18) },
      ],
    } },
  ], async (dir) => {
    // The real slice, the real helpers, assembled in reach-out's exact order.
    const turns = await getRecentSessionMessages({ logsDir: dir });
    const provenance = formatSliceProvenanceLines(turns.session, { wardLastSeenPhrase: '2 days ago' });
    const lines = formatRecentMessagesForContext(turns, NOW);
    const intro = provenance || 'The last things my human and I talked about (so anything I reach out about connects to our actual life, not nothing):';
    const sessionBlock = lines ? `\n${intro}\n${lines}` : '';

    assert.match(sessionBlock, /from the group room "the kitchen"; speakers: Alice, Bob/);
    assert.match(sessionBlock, /None of the messages below are from my human/);
    assert.doesNotMatch(sessionBlock, /my human and I talked about/, 'the false "we talked" framing is replaced for a no-ward room');

    // The receipt the loop would stamp.
    const source = { sessionId: turns.session.sessionId, kind: turns.session.kind, roster: turns.session.roster, hasWardTurn: turns.session.hasWardTurn };
    assert.equal(source.kind, 'group');
    assert.equal(source.hasWardTurn, false);
  });
});

test('PIPELINE: the reach-out loop threads decision.source to the ward knock', async () => {
  const captured = {};
  const res = await runOneReachoutTick({
    now: () => NOW,
    getThreat: async () => ({ tier: 'calm', disabled: false }),
    getLastActivity: async () => ({ ms: NOW - 3 * 86400_000 }),   // 3 days quiet → past the active gate
    getPendingTells: async () => [],
    getWarmVillagers: async () => [],
    isQuietHours: async () => false,
    recordWaitFn: async () => {},
    recordProactiveFn: async () => {},
    getWaitStreakFn: () => ({ count: 0 }),
    decideReachout: async () => ({
      action: 'reach_out', target: 'ward', message: 'about the kitchen question',
      source: { sessionId: 's-room', kind: 'group', roster: ['Alice'], hasWardTurn: false },
    }),
    deliverWardKnock: async (args) => { Object.assign(captured, args); return { ok: true }; },
    deliverVillagerReach: async () => ({ ok: true }),
  });
  assert.equal(res.acted, true);
  assert.ok(captured.source, 'source reached deliverWardKnock');
  assert.equal(captured.source.kind, 'group');
  assert.equal(captured.source.hasWardTurn, false);
});
