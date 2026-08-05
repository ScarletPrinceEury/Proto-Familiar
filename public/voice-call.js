/*
 * voice-call.js — the browser end of a live voice call (Pass 2b, web adapter).
 *
 * ⚠️ ON-HARDWARE / UNVERIFIED-IN-CLOUD. This drives a microphone and Web Audio
 * playback against the server's WS endpoint (/api/voice/call). None of it can
 * run in CI (no mic), so it is written carefully and verified by my human
 * making a real call on the reference laptop.
 *
 * Flow: "Start call" opens the socket and asks for the mic once (the click is
 * the gesture that unlocks capture + the AudioContext). "Hold to talk" is
 * push-to-talk — while held, downsampled 16 kHz mono s16le PCM streams up; the
 * release finalises the utterance. The Familiar's reply arrives as one PCM
 * chunk (server buffers a whole reply so PocketTTS keeps one voice) framed by
 * speak-start / speak-end and plays back through the AudioContext.
 *
 * Plain script (matches app.js/graph-map.js): no imports, one IIFE, no globals
 * beyond the DOM ids it owns.
 */
(function () {
  'use strict';

  const TARGET_RATE = 16000; // the recogniser's rate
  const $ = (id) => document.getElementById(id);

  let ws = null;
  let ctx = null;
  let micStream = null;
  let sourceNode = null;
  let procNode = null;
  let talking = false;
  let playHead = 0;       // AudioContext time the next reply chunk should start at
  let live = false;

  function setState(msg) { const el = $('voice-call-state'); if (el) el.textContent = msg || ''; }
  function setLive(on) {
    live = on;
    const start = $('voice-call-btn');
    const talk = $('voice-call-talk');
    if (start) start.textContent = on ? '⏹ End call' : '📞 Start voice call';
    if (talk) talk.hidden = !on;
  }

  // ── Capture: ctx-rate Float32 → 16 kHz mono s16le ──────────────────────
  function floatTo16kS16(input, inRate) {
    const ratio = inRate / TARGET_RATE;
    const outLen = Math.floor(input.length / ratio);
    const buf = new ArrayBuffer(outLen * 2);
    const view = new DataView(buf);
    for (let i = 0; i < outLen; i++) {
      // Linear interpolation between the two nearest input samples.
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s = (input[i0] ?? 0) * (1 - frac) + (input[i0 + 1] ?? input[i0] ?? 0) * frac;
      const clamped = Math.max(-1, Math.min(1, s));
      view.setInt16(i * 2, Math.round(clamped * 32767), true);
    }
    return buf;
  }

  function onAudioProcess(e) {
    if (!talking || !ws || ws.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    try { ws.send(floatTo16kS16(input, ctx.sampleRate)); } catch { /* socket went away */ }
  }

  // ── Playback: s16le at the reply's rate → queued AudioBuffer ───────────
  function playPcm(arrayBuffer, sampleRate) {
    if (!ctx) return;
    const pcm = new DataView(arrayBuffer);
    const n = Math.floor(arrayBuffer.byteLength / 2);
    if (n === 0) return;
    const audio = ctx.createBuffer(1, n, sampleRate || 24000);
    const ch = audio.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = pcm.getInt16(i * 2, true) / 32768;
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, playHead);
    src.start(startAt);
    playHead = startAt + audio.duration;
  }

  // ── Socket lifecycle ───────────────────────────────────────────────────
  let replyRate = 24000;

  async function startCall() {
    if (live) { endCall(); return; }
    setState('Connecting…');
    // The mic API only exists in a secure context (https:// or localhost). Over
    // Tailscale on plain http:// the whole `navigator.mediaDevices` is absent —
    // say so plainly instead of throwing "undefined is not an object".
    if (!navigator.mediaDevices?.getUserMedia) {
      setState(window.isSecureContext === false
        ? 'A voice call needs a secure connection. Open http://localhost:8742 on this machine, or serve over HTTPS (e.g. `tailscale serve`) to call from your phone.'
        : 'This browser did not expose a microphone. Use a current browser on https:// or localhost.');
      return;
    }
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume();
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      setState(`Couldn't open the microphone: ${err && err.message ? err.message : err}`);
      return;
    }

    sourceNode = ctx.createMediaStreamSource(micStream);
    // ScriptProcessorNode is deprecated but universally supported and enough for
    // push-to-talk; an AudioWorklet is a later refinement.
    procNode = ctx.createScriptProcessor(4096, 1, 1);
    procNode.onaudioprocess = onAudioProcess;
    sourceNode.connect(procNode);
    procNode.connect(ctx.destination); // required for the node to pull; it sends nothing while !talking

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/voice/call`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => setState('Connected. Hold the button to talk.');
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'ready') { setLive(true); setState('On a call. Hold to talk.'); }
        else if (m.t === 'speak-start') { replyRate = Number(m.sampleRate) || replyRate; playHead = ctx.currentTime; setState('…'); }
        else if (m.t === 'speak-end') { setState('On a call. Hold to talk.'); }
        else if (m.t === 'stop') { playHead = ctx.currentTime; }
        else if (m.t === 'error') { setState(`Call ended: ${m.reason || 'error'}${m.detail ? ` — ${m.detail}` : ''}`); endCall(); }
        return;
      }
      playPcm(ev.data, replyRate); // binary → TTS PCM
    };
    ws.onclose = () => { if (live) setState('Call ended.'); teardown(); };
    ws.onerror = () => setState('Connection error.');
  }

  function pressTalk() {
    if (!live || !ws || ws.readyState !== WebSocket.OPEN) return;
    talking = true;
    setState('Listening…');
  }
  function releaseTalk() {
    if (!talking) return;
    talking = false;
    try { ws.send(JSON.stringify({ t: 'release' })); } catch { /* */ }
    setState('Thinking…');
  }

  function teardown() {
    try { if (procNode) { procNode.disconnect(); procNode.onaudioprocess = null; } } catch { /* */ }
    try { if (sourceNode) sourceNode.disconnect(); } catch { /* */ }
    try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    procNode = sourceNode = micStream = null;
    talking = false;
    setLive(false);
  }

  function endCall() {
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch { /* */ }
    ws = null;
    teardown();
    setState('Call ended.');
  }

  // ── Wire the buttons once the DOM is ready ─────────────────────────────
  function init() {
    const start = $('voice-call-btn');
    const talk = $('voice-call-talk');
    if (!start) return;
    start.addEventListener('click', startCall);
    if (talk) {
      // Hold-to-talk has to survive the browser's gesture handling. On a
      // touchscreen (and a trackpad long-press) a plain held button is read as
      // a scroll/long-press gesture, which fires `pointercancel` almost at
      // once — releasing the hold instantly, so it behaves like a tap and never
      // captures speech. Two things stop that:
      //   1. CAPTURE the pointer on down, so every later move/up/cancel targets
      //      this button even if the finger drifts off it, and the browser does
      //      not hand the gesture to a scroller.
      //   2. `touch-action: none` (in CSS) so the hold is never claimed as a pan.
      const press = (e) => {
        e.preventDefault();
        try { talk.setPointerCapture(e.pointerId); } catch { /* some pointers can't be captured */ }
        pressTalk();
      };
      const release = (e) => {
        try { if (e?.pointerId != null) talk.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
        releaseTalk();
      };
      talk.addEventListener('pointerdown', press);
      talk.addEventListener('pointerup', release);
      talk.addEventListener('pointercancel', release);
      // A window-level pointerup is the fallback for the rare case capture did
      // not take and the finger lifted off the button — releaseTalk is
      // idempotent, so a double release is harmless.
      window.addEventListener('pointerup', releaseTalk);
      // A long-press must not raise the context menu or selection callout: both
      // steal the gesture and end the hold early — the reported "only a click".
      talk.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
