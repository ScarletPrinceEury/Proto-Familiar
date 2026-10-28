/**
 * What leaves my human's room (known-issues C1). A referral code that was my
 * human's legal name in handle form went to a group channel through
 * relay_message; nothing could catch a thing that was never stored as private.
 *
 * Covered: the tripwire on its own (outgoing-tripwire.js), the hold store and
 * my human's release (held-relays.js), the room gate (gateRoomReply), the
 * `!held`/`!send` parser, and a pipeline run through the real relay_message
 * executor into a held record and out again on my human's okay.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  protectedHits, redactProtected, normalizePrivateList, variantExamples,
  relayShapeHits, checkRelay, describeShapeHits,
} from '../src/village/outgoing-tripwire.js';
import { holdRelay, listHeldRelays, releaseHeldRelay, dropHeldRelay, HOLD_DAYS } from '../src/village/held-relays.js';
import { gateRoomReply, FILTER_SAFE_REFUSAL } from '../src/safety/outgoing-filter.js';
import { parseHeldCommand } from '../src/discord/discord-gateway.js';
import { TOOL_EXECUTORS, initCerebellumTools, formatItemForPush, BUILTIN_TOOLS } from '../cerebellum.js';

// A neutral stand-in; never a real person's name.
const LIST = ['Robin Smith'];

function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-held-'));
  return { file: path.join(dir, 'held.json'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── The keep-between-us list ─────────────────────────────────────────────────

test('a list entry catches the ways a name turns into a handle', () => {
  for (const s of ['code: Robin_Smith01', 'robin.smith', 'RobinSmith', 'Smith Robin', 'ROBIN-SMITH', 'robin smith42']) {
    assert.equal(protectedHits(s, LIST).length, 1, s);
  }
  for (const s of ['Robinson was here', 'Robin alone', 'Smithsonian', 'robins mith']) {
    assert.equal(protectedHits(s, LIST).length, 0, s);
  }
});

test('a match is swapped for [private], the rest of the sentence stays', () => {
  assert.equal(redactProtected('her referral code is Robin_Smith01, so', LIST).text, 'her referral code is [private], so');
  assert.equal(redactProtected('nothing here', LIST).text, 'nothing here');
});

test('the list drops entries too short to match safely, and duplicates', () => {
  assert.deepEqual(normalizePrivateList(['  Robin   Smith ', 'robin smith', 'Al', '', null, 'XK-29Q']), ['Robin Smith', 'XK-29Q']);
  assert.ok(variantExamples('Robin Smith').includes('Robin_Smith01'));
});

// ── The relay-only shape check ───────────────────────────────────────────────

test('shapes that hold a relay', () => {
  const kinds = (s, o) => relayShapeHits(s, o).map(h => h.kind);
  assert.deepEqual(kinds('use code Robin_Smith01 at checkout'), ['name-handle']);
  assert.deepEqual(kinds('it is robin_smith01'), ['name-handle']);
  assert.deepEqual(kinds('the code is REF-8842-KQ'), ['code']);
  assert.deepEqual(kinds('mail me at someone@example.org'), ['contact']);
  assert.deepEqual(kinds('call +49 151 2345 6789'), ['contact']);
  assert.deepEqual(kinds('join https://discord.gg/abcDEF'), ['link']);
  assert.deepEqual(kinds('https://shop.example/signup?ref=abc123'), ['link']);
  assert.deepEqual(kinds('ask for Sam42', { knownNames: ['Sam'] }), ['name-handle']);
});

test('ordinary messages pass the shape check', () => {
  for (const s of [
    "Hi Sam, running late, see you at 7!", 'Jean-Luc and I are in New-York', 'at 14:30 on 2026-10-28',
    'watching YouTube', 'the menu is at https://example.com/menu', 'Sam says hi',
  ]) {
    assert.deepEqual(relayShapeHits(s, { knownNames: ['Sam'] }), [], s);
  }
});

test('checkRelay: the list wins over the shape check, and names no match back', () => {
  assert.deepEqual(checkRelay('code Robin_Smith01', { privateList: LIST }), { hold: 'protected', hits: [] });
  assert.equal(checkRelay('code Robin_Smith01').hold, 'shape');
  assert.equal(checkRelay('see you at 7').hold, null);
  assert.match(describeShapeHits(relayShapeHits('Robin_Smith01')), /^"Robin_Smith01" looks like somebody's name turned into a handle$/);
});

// ── Held relays ──────────────────────────────────────────────────────────────

test('my human sends a held relay as written; it can\'t go twice', async () => {
  const t = tempStore();
  try {
    const rec = await holdRelay({ targetName: 'Sam', delivery: { channelId: 'c1' }, message: 'code Robin_Smith01', reason: 'shape', hits: [], file: t.file });
    assert.match(rec.id, /^held-sam-/);
    assert.equal((await listHeldRelays({ file: t.file })).length, 1);
    const sent = [], mirrored = [];
    const opts = { send: async (a) => { sent.push(a); return { ok: true }; }, mirror: async (m) => { mirrored.push(m); }, file: t.file };
    const r = await releaseHeldRelay(rec.id, opts);
    assert.equal(r.ok, true);
    assert.deepEqual(sent, [{ channelId: 'c1', message: 'code Robin_Smith01' }]);
    assert.match(mirrored[0].body, /Sent it to Sam as written/);
    assert.equal((await releaseHeldRelay(rec.id, opts)).code, 'not-held');
    assert.equal(sent.length, 1);
  } finally { t.done(); }
});

test('a protected hold never sends, and the list is checked again at release', async () => {
  const t = tempStore();
  try {
    const send = async () => { throw new Error('must not send'); };
    const prot = await holdRelay({ targetName: 'Sam', delivery: {}, message: 'x', reason: 'protected', file: t.file });
    assert.equal(prot.sendable, false);
    assert.equal((await releaseHeldRelay(prot.id, { send, file: t.file })).code, 'protected');
    // Held for its shape, but the name went on the list since.
    const shape = await holdRelay({ targetName: 'Sam', delivery: {}, message: 'code Robin_Smith01', reason: 'shape', file: t.file });
    assert.equal((await releaseHeldRelay(shape.id, { send, privateList: LIST, file: t.file })).code, 'protected');
  } finally { t.done(); }
});

test('a failed send stays held; drop and expiry settle it', async () => {
  const t = tempStore();
  try {
    const a = await holdRelay({ targetName: 'Sam', delivery: {}, message: 'm', reason: 'shape', file: t.file });
    const r = await releaseHeldRelay(a.id, { send: async () => ({ ok: false, error: 'offline' }), file: t.file });
    assert.equal(r.code, 'send-failed');
    assert.equal((await listHeldRelays({ file: t.file })).length, 1);
    assert.equal((await dropHeldRelay(a.id, { file: t.file })).ok, true);
    const old = await holdRelay({ targetName: 'Sam', delivery: {}, message: 'm', reason: 'shape', now: Date.now() - (HOLD_DAYS + 1) * 86_400_000, file: t.file });
    assert.equal((await listHeldRelays({ file: t.file })).length, 0);
    assert.equal((await releaseHeldRelay(old.id, { send: async () => ({ ok: true }), file: t.file })).code, 'not-held');
  } finally { t.done(); }
});

// ── The room gate ────────────────────────────────────────────────────────────

test('room replies get the [private] swap; my human\'s own room is never touched', async () => {
  const clean = async () => ({ hit: false });
  const ward = await gateRoomReply({ draftText: 'Robin Smith', audienceTag: 'ward-private', privateList: LIST, checkRestricted: clean });
  assert.equal(ward.text, 'Robin Smith');
  const room = await gateRoomReply({ draftText: 'that was Robin Smith', audienceTag: 'cat-friends', privateList: LIST, checkRestricted: clean });
  assert.equal(room.text, 'that was [private]');
  assert.equal(room.swapped, 1);
  // A filter error passes the draft through, and the swap still runs.
  const broken = await gateRoomReply({ draftText: 'that was Robin Smith', audienceTag: 'cat-friends', privateList: LIST,
    checkRestricted: async () => { throw new Error('search down'); }, log: { error() {}, log() {} } });
  assert.equal(broken.text, 'that was [private]');
  // A refusal goes out as the safe refusal.
  const blocked = await gateRoomReply({ draftText: 'secret', audienceTag: 'cat-friends', privateList: LIST,
    checkRestricted: async () => ({ hit: true }), callUpstream: async () => { throw new Error('no'); }, baseMessages: [] });
  assert.equal(blocked.text, FILTER_SAFE_REFUSAL);
});

// ── Discord commands + push ──────────────────────────────────────────────────

test('!held and !send parse; plain chat doesn\'t', () => {
  assert.deepEqual(parseHeldCommand('!send held-sam-x2'), { action: 'send', id: 'held-sam-x2' });
  assert.deepEqual(parseHeldCommand('!held'), { action: 'list' });
  assert.deepEqual(parseHeldCommand('!held drop held-sam-x2'), { action: 'drop', id: 'held-sam-x2' });
  assert.equal(parseHeldCommand('send it please'), null);
  assert.equal(parseHeldCommand('!sendall'), null);
});

test('the Discord push offers !send only for a sendable hold', () => {
  assert.match(formatItemForPush({ kind: 'relay_held', title: 'Held off on messaging Sam', body: 'b', meta: { heldRelayId: 'held-sam-x2', sendable: true } }), /Reply `!send held-sam-x2`/);
  assert.doesNotMatch(formatItemForPush({ kind: 'relay_held', title: 't', body: 'b', meta: { heldRelayId: 'h', sendable: false } }), /!send/);
});

// ── Pipeline: relay_message → held → my human's okay ────────────────────────

const relay = TOOL_EXECUTORS.relay_message;
const registry = {
  categories: [{ id: 'cat-friends', name: 'Friends', builtin: false, grants: {} }],
  villagers: [{ id: 'v-sam', name: 'Sam', categoryIds: ['cat-friends'], aliases: [{ platform: 'discord', id: '555' }] }],
  locations: [],
};

function wire({ file, list = [], sent, mirrored, readPrivateList }) {
  initCerebellumTools({
    getVillageRegistry: async () => registry,
    relayToDiscord:     async (a) => { sent.push(a); return { ok: true }; },
    searchRestricted:   async () => ({ hit: false }),
    mirrorToWard:       async (m) => { mirrored.push(m); return { id: 'm' }; },
    holdRelay:          (args) => holdRelay({ ...args, file }),
    readPrivateList:    readPrivateList ?? (() => list),
  });
}

afterEach(() => {
  initCerebellumTools({ holdRelay, readPrivateList: () => [], mirrorToWard: async () => ({}), relayToDiscord: async () => ({ ok: true }) });
});

test('pipeline: a handle-shaped name is held, and goes out only on my human\'s okay', async () => {
  const t = tempStore();
  try {
    const sent = [], mirrored = [];
    wire({ file: t.file, sent, mirrored });
    const out = await relay({ to: 'Sam', message: 'Her referral code is Robin_Smith01.' });
    assert.equal(out, 'Didn\'t send it yet. "Robin_Smith01" looks like somebody\'s name turned into a handle. I can send it without that bit, or {{user}} can okay it as it is — I\'ve asked them.');
    assert.equal(sent.length, 0, 'nothing went to Sam');
    assert.equal(mirrored[0].kind, 'relay_held');
    assert.equal(mirrored[0].meta.sendable, true);
    const id = mirrored[0].meta.heldRelayId;
    const r = await releaseHeldRelay(id, { send: async (a) => { sent.push(a); return { ok: true }; }, file: t.file });
    assert.equal(r.ok, true);
    assert.deepEqual(sent, [{ recipientUserId: '555', message: 'Her referral code is Robin_Smith01.' }]);
  } finally { t.done(); }
});

test('pipeline: something from the list is held for good, and never shown back', async () => {
  const t = tempStore();
  try {
    const sent = [], mirrored = [];
    wire({ file: t.file, list: LIST, sent, mirrored });
    const out = await relay({ to: 'Sam', message: 'Tell them it is robin.smith on the form.' });
    assert.match(out, /^Didn't send it\. Part of it is on \{\{user\}\}'s keep-between-us list, so it can't go to Sam\./);
    assert.doesNotMatch(out, /robin/i);
    assert.equal(sent.length, 0);
    assert.equal(mirrored[0].meta.sendable, false);
    assert.match(mirrored[0].body, /it is \[private\] on the form/);
    assert.doesNotMatch(mirrored[0].body, /robin/i);
  } finally { t.done(); }
});

test('pipeline: if the check itself fails, the relay is held, not sent', async () => {
  const t = tempStore();
  try {
    const sent = [], mirrored = [];
    wire({ file: t.file, sent, mirrored, readPrivateList: () => { throw new Error('settings unreadable'); } });
    const out = await relay({ to: 'Sam', message: 'see you at 7' });
    assert.equal(out, 'Didn\'t send it yet. The check on it didn\'t run, so it\'s waiting for {{user}} to okay it. I\'ve asked them.');
    assert.equal(sent.length, 0);
    assert.match(mirrored[0].body, /^The check on it didn't run, so I held it\. Want it sent as is\? Hit Send it, or Drop it\./);
    assert.doesNotMatch(mirrored[0].body, /that bit/);
  } finally { t.done(); }
});

test('pipeline: an ordinary relay still goes straight out', async () => {
  const t = tempStore();
  try {
    const sent = [], mirrored = [];
    wire({ file: t.file, list: LIST, sent, mirrored });
    assert.match(await relay({ to: 'Sam', message: 'Running late, see you at 7!' }), /^Sent to Sam/);
    assert.equal(sent.length, 1);
    assert.equal(mirrored[0].kind, 'relay');
  } finally { t.done(); }
});

test('relay_message tells me what to leave out, and uses a neutral example name', () => {
  const fn = BUILTIN_TOOLS.find(t => t.function.name === 'relay_message').function;
  assert.match(fn.parameters.properties.message.description, /No codes, ids, links, contact info or anyone's full real name/);
  assert.doesNotMatch(JSON.stringify(fn), /Chen/);
});
