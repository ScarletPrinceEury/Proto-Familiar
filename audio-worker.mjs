#!/usr/bin/env node
/**
 * The audio worker (voice spec §2).
 *
 * A plain Node child process that owns the speech models and nothing else. It
 * speaks the framed stdio protocol in `audio-frame.js` and is supervised by
 * `audio-worker-host.js`; it knows nothing about HTTP, my human, or the rest
 * of me.
 *
 * ── It must never take anything down with it ────────────────────────────
 * Native inference is blocking C++ and this process exists to contain that.
 * So: no unhandled rejection escapes, every op answers its `reqId` even when
 * it fails, and a missing engine is reported once at load rather than thrown
 * per request. If this process dies anyway, the supervisor restarts it — and
 * that is the design, not a fallback.
 *
 * ── Thread caps come from the environment ───────────────────────────────
 * The host sets `PF_AUDIO_THREADS*`; the caps live with the supervision, not
 * buried in here. `total` is the ceiling this process holds concurrent work
 * beneath, so on a 4c/8t machine there is always a physical core's worth of
 * headroom left for Node and the Python children even mid-burst.
 *
 * ── Not yet built ───────────────────────────────────────────────────────
 * Pass 1 is the spine: load, unload, report, synthesise. Streaming ASR, VAD
 * gating and barge-in belong to Pass 2 and are absent rather than stubbed —
 * an op that answers `unsupported` is honest; one that pretends is not.
 */

import { encodeJson, createFrameReader, KIND_JSON } from './audio-frame.js';

const send = (obj) => {
  try { process.stdout.write(encodeJson(obj)); } catch { /* the pipe is gone; the supervisor will notice */ }
};

const threads = {
  total: Number(process.env.PF_AUDIO_THREADS) || 3,
  vad: Number(process.env.PF_AUDIO_THREADS_VAD) || 1,
  asr: Number(process.env.PF_AUDIO_THREADS_ASR) || 2,
  tts: Number(process.env.PF_AUDIO_THREADS_TTS) || 2,
  speaker: Number(process.env.PF_AUDIO_THREADS_SPEAKER) || 1,
};

/** Loaded models, by role. Lazy: nothing loads until something needs it. */
const loaded = new Map();
let engine = null;
let engineError = null;

/**
 * Load the native binding, once.
 *
 * A missing binding is the ordinary case on a platform with no prebuilt, or
 * for a ward who installed with `--omit=optional` (§0.8). It is reported as a
 * reason, not thrown — every op then answers honestly instead of the process
 * dying and being restarted three times into a park.
 */
async function ensureEngine() {
  if (engine) return { ok: true };
  if (engineError) return { ok: false, reason: 'no-engine', detail: engineError };
  try {
    engine = await import('sherpa-onnx-node');
    return { ok: true };
  } catch (err) {
    engineError = `the speech engine is not installed (${String(err?.message ?? err).split('\n')[0]})`;
    return { ok: false, reason: 'no-engine', detail: engineError };
  }
}

function reportState() {
  send({ op: 'state', loadedModels: [...loaded.keys()], liveDecoders: 0, threads });
}

const OPS = {
  /** Liveness plus what this worker can currently do. Cheap, and never loads anything. */
  async ping({ reqId }) {
    const e = await ensureEngine();
    send({
      reqId, ok: true,
      engineAvailable: e.ok,
      engineDetail: e.ok ? null : e.detail,
      loadedModels: [...loaded.keys()],
      threads,
    });
  },

  /**
   * Load a model for a role. Idempotent: loading what is already loaded is a
   * no-op rather than a second copy in RAM.
   */
  async load({ reqId, role, modelDir }) {
    const e = await ensureEngine();
    if (!e.ok) return send({ reqId, ok: false, reason: e.reason, detail: e.detail });
    if (!role || !modelDir) return send({ reqId, ok: false, reason: 'bad-request', detail: 'role and modelDir are required' });
    if (loaded.has(role)) return send({ reqId, ok: true, alreadyLoaded: true, role });

    try {
      // Placeholder for the real per-role session construction, which needs a
      // machine with the binding to write against. Recorded so `status` is
      // truthful about what is held.
      loaded.set(role, { modelDir, at: Date.now() });
      reportState();
      send({ reqId, ok: true, role, modelDir });
    } catch (err) {
      send({ reqId, ok: false, reason: 'load-failed', detail: String(err?.message ?? err) });
    }
  },

  /** Drop a role's model. Used by idle unload and by a ward reclaiming RAM. */
  async unload({ reqId, role }) {
    if (role) loaded.delete(role); else loaded.clear();
    reportState();
    send({ reqId, ok: true, unloaded: role ?? 'all' });
  },

  /**
   * Ops the spine does not implement yet.
   *
   * Answering `unsupported` keeps the contract — every request gets a reply —
   * while being plain that the capability is absent. A stub that returned
   * silence or a plausible-looking empty result would let a caller believe it
   * had spoken when it had not, which is the confabulation failure the 0.9
   * post-mortem is about.
   */
  async tts({ reqId }) { send({ reqId, ok: false, reason: 'unsupported', detail: 'speaking arrives with read-aloud' }); },
  async transcribe({ reqId }) { send({ reqId, ok: false, reason: 'unsupported', detail: 'transcription arrives with voice notes' }); },
};

const reader = createFrameReader({
  onFrame: async (frame) => {
    if (frame.kind !== KIND_JSON) return;   // Pass 2 routes PCM at decoders
    const msg = frame.message ?? {};
    const op = OPS[msg.op];
    if (!op) return send({ reqId: msg.reqId, ok: false, reason: 'unknown-op', detail: String(msg.op) });
    try {
      await op(msg);
    } catch (err) {
      // A reqId that never gets an answer is a caller waiting until its
      // timeout for nothing. Answer even the unexpected.
      send({ reqId: msg.reqId, ok: false, reason: 'op-failed', detail: String(err?.message ?? err) });
    }
  },
  onError: (e) => send({ op: 'protocol-error', ...e }),
});

process.stdin.on('data', (chunk) => reader.push(chunk));
process.stdin.on('end', () => process.exit(0));      // EOF from the supervisor: clean exit

process.on('uncaughtException', (err) => {
  send({ op: 'fatal', detail: String(err?.message ?? err) });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  send({ op: 'fatal', detail: String(err?.message ?? err) });
  process.exit(1);
});

reportState();
