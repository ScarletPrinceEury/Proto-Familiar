import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWebCallAdapter } from '../voice-web-adapter.js';
import { createCallEngine } from '../call-engine.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'web-'));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** Records what the adapter pushed to the engine, and what it sent to the browser. */
function harness() {
  const rec = { audio: [], ended: [], sent: [] };
  const hooks = {
    pushAudio: (f) => rec.audio.push(f),
    endUtterance: (f) => rec.ended.push(f),
    rosterChanged: () => {},
  };
  const send = (d) => rec.sent.push(Buffer.isBuffer(d) ? { bin: d.length } : JSON.parse(d));
  return { rec, ...createWebCallAdapter({ hooks, send }) };
}

test('inbound binary is PCM for the ward; it is ignored until a call is joined', async () => {
  const { rec, adapter, onMessage } = harness();
  onMessage(Buffer.alloc(320), true);
  assert.equal(rec.audio.length, 0, 'no call yet → dropped');
  const { callId } = await adapter.joinCall();
  onMessage(Buffer.alloc(320), true);
  assert.equal(rec.audio.length, 1);
  assert.equal(rec.audio[0].callId, callId);
  assert.equal(rec.audio[0].speakerRef, 'ward');
  assert.equal(rec.audio[0].pcm.length, 320);
});

test('a release control frame finalises the utterance', async () => {
  const { rec, adapter, onMessage } = harness();
  await adapter.joinCall();
  onMessage(JSON.stringify({ t: 'release' }), false);
  assert.equal(rec.ended.length, 1);
  assert.equal(rec.ended[0].speakerRef, 'ward');
});

test('playAudio frames the reply with speak-start / PCM / speak-end', async () => {
  const { rec, adapter } = harness();
  await adapter.joinCall();
  async function* reply() { yield Buffer.alloc(100); yield Buffer.alloc(50); }
  await adapter.playAudio('web-1', reply());
  assert.deepEqual(rec.sent[0], { t: 'speak-start' });
  assert.deepEqual(rec.sent[1], { bin: 100 });
  assert.deepEqual(rec.sent[2], { bin: 50 });
  assert.deepEqual(rec.sent[3], { t: 'speak-end' });
});

test('playAudio(null) says nothing at all — a valid silent turn', async () => {
  const { rec, adapter } = harness();
  await adapter.joinCall();
  await adapter.playAudio('web-1', null);
  assert.equal(rec.sent.length, 0);
});

test('stopPlayback and a barge frame both signal stop', async () => {
  const { rec, adapter, onMessage } = harness();
  await adapter.joinCall();
  await adapter.stopPlayback();
  onMessage(JSON.stringify({ t: 'barge' }), false);
  assert.deepEqual(rec.sent, [{ t: 'stop' }, { t: 'stop' }]);
});

test('a malformed or unknown control frame is dropped, never thrown', async () => {
  const { rec, adapter, onMessage } = harness();
  await adapter.joinCall();
  onMessage('not json', false);
  onMessage(JSON.stringify({ t: 'who-knows' }), false);
  assert.equal(rec.ended.length, 0);
  assert.equal(rec.audio.length, 0);
});

test('a socket close mid-press flushes the utterance and drops the call', async () => {
  const { rec, adapter, onMessage, onClose } = harness();
  await adapter.joinCall();
  onMessage(Buffer.alloc(160), true);
  onClose();
  assert.equal(rec.ended.length, 1, 'the in-flight utterance was finalised on close');
  onMessage(Buffer.alloc(160), true); // after close → ignored
  assert.equal(rec.audio.length, 1, 'no audio routed after the call dropped');
});

// ── Integration: the web adapter plugged into the real call engine ───────

/** The same worker stub the call-engine test uses, with `emit` to inject frames. */
function fakeWorker() {
  let listener = null;
  const calls = { requests: [], pcm: [] };
  return {
    request: async (m) => { calls.requests.push(m); return { ok: true, ...m }; },
    sendPcm: async (streamId, pcm) => { calls.pcm.push({ streamId, len: pcm.length }); return { ok: true }; },
    on: (l) => { listener = l; return () => { listener = null; }; },
    emit: (message) => listener?.({ kind: 0, message }),
    calls,
  };
}

test('web adapter + call engine: a press/release round-trips audio in and a spoken reply out', async () => {
  const dir = await tmp();
  try {
    const sent = [];
    const worker = fakeWorker();
    const turns = [];
    const engine = createCallEngine({
      worker,
      onTurn: async (t) => {
        turns.push(t);
        return (async function* () { yield Buffer.alloc(200); yield Buffer.alloc(80); })();
      },
      tomesDir: dir,
    });
    let web;
    engine.registerCallAdapter((hooks) => {
      web = createWebCallAdapter({ hooks, send: (d) => sent.push(Buffer.isBuffer(d) ? { bin: d.length } : JSON.parse(d)) });
      return web.adapter;
    });

    const start = await engine.startCall('web');
    assert.equal(start.ok, true);

    // Browser streams a press, then releases. Engine routing is async
    // (fire-and-forget hooks), so let the microtasks drain before asserting.
    web.onMessage(Buffer.alloc(3200), true);
    await tick();
    assert.ok(worker.calls.requests.some((r) => r.op === 'asrStream'), 'engine opened a stream');
    assert.equal(worker.calls.pcm.length, 1, 'PCM was forwarded to the worker');
    web.onMessage(JSON.stringify({ t: 'release' }), false);
    await tick();
    assert.ok(worker.calls.requests.some((r) => r.op === 'asrStreamStop'), 'release finalised the utterance');

    // The worker reports the transcript → engine runs the turn → adapter speaks it.
    const streamId = worker.calls.requests.find((r) => r.op === 'asrStream').streamId;
    worker.emit({ op: 'asr-final', streamId, text: 'good morning' });
    await tick();

    assert.deepEqual(turns, ['good morning']);
    assert.deepEqual(sent[0], { t: 'speak-start' });
    assert.ok(sent.some((s) => s.bin === 200) && sent.some((s) => s.bin === 80), 'TTS PCM went to the browser');
    assert.deepEqual(sent[sent.length - 1], { t: 'speak-end' });

    await engine.endCall();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
