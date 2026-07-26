#!/usr/bin/env python3
"""The speaking worker, on Kyutai's own implementation.

Answers the same ops on the same framed protocol as `audio-worker.mjs`, so the
Node supervisor treats it identically. What it buys is one thing the ONNX port
cannot do at all.

── Why this exists ─────────────────────────────────────────────────────
sherpa-onnx opens every utterance with `model_->GetLmMainInitState()`. The LM
state is RESET per utterance, so each one is a fresh trajectory that conditions
on the voice once and then drifts. My human heard the whole progression: first
every sentence a different person, then — once utterances were merged — every
paragraph. Merging reduced the number of resets; it could never remove them,
because the port has no way to continue a trajectory across a call.

Upstream does:

    model.generate_audio(state, text, copy_state=False)

`copy_state=False` carries the KV cache forward, which is how the project can
claim "can handle infinitely long text inputs". One state, threaded through
every chunk of a message, is one continuous trajectory — no resets, and so no
seam for the voice to drift at.

It also runs `english_2026-04`, upstream's current English model. The only
sherpa export is `2026-01`, an older checkpoint.

── What it costs ───────────────────────────────────────────────────────
Torch. ~395 MB of downloads on Windows (torch 122, scipy 37, numpy 12, the
model 219), around 600 MB installed. That is real money against a project whose
whole premise is running on hardware people already own, which is why this is
opt-in and why the footprint is reported rather than buried.

── The state cache is the trick ────────────────────────────────────────
A per-message trajectory needs a FRESH copy of the voice state each time —
`copy_state=False` mutates what it is given, so a message must not inherit the
last one's tail. Re-deriving from audio is slow. Exporting the state once to
safetensors and reloading per message is, in upstream's words, "quite fast as
it's just reading the kvcache from disk".
"""

from __future__ import annotations

import os
import struct
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from voicebox.frames import FrameReader, KIND_JSON, send, send_pcm

# Thread caps come from the supervisor, exactly as the Node worker's do, so the
# numbers live with the supervision rather than being buried in the child.
_THREADS = int(os.environ.get("PF_AUDIO_THREADS_TTS", "2"))

_TEMPERATURE = float(os.environ.get("PF_TTS_TEMPERATURE", "0.7"))
_DECODE_STEPS = int(os.environ.get("PF_TTS_NUM_STEPS", "4"))
_EOS_THRESHOLD = float(os.environ.get("PF_TTS_EOS_THRESHOLD", "-4.0"))

# Matches voice-generation.js. A generation that keeps producing audio well past
# what the words could account for is stopped — the containment half of the
# runaway guard, mirrored here because this worker streams the same way.
_CHARS_PER_SECOND = 18.6
_RUNAWAY_FACTOR = 2
_RUNAWAY_FLOOR_SECONDS = 3

_model = None
_model_error: str | None = None
_voice_states: dict[str, Path] = {}   # reference wav -> exported safetensors
_state_dir: Path | None = None


def _ensure_model() -> tuple[bool, str | None]:
    """Import and load once. A missing torch is reported, never raised."""
    global _model, _model_error
    if _model is not None:
        return True, None
    if _model_error is not None:
        return False, _model_error

    try:
        import torch

        torch.set_num_threads(_THREADS)
        from pocket_tts import TTSModel

        _model = TTSModel.load_model(
            temp=_TEMPERATURE,
            lsd_decode_steps=_DECODE_STEPS,
            eos_threshold=_EOS_THRESHOLD,
        )
        return True, None
    except Exception as exc:
        _model_error = f"the speaking engine is not usable ({type(exc).__name__}: {exc})"
        return False, _model_error


def _runaway_sample_limit(text: str, sample_rate: int, speed: float = 1.0) -> int:
    rate = _CHARS_PER_SECOND * (speed if speed and speed > 0 else 1.0)
    seconds = max(_RUNAWAY_FLOOR_SECONDS, (len(text) / rate) * _RUNAWAY_FACTOR)
    return int(seconds * sample_rate)


def _voice_state_file(reference_wav: str) -> Path:
    """Derive the voice state once, keep it on disk, reload it per message.

    Deriving from audio is the slow part and it does not change between
    messages. Reloading is a kvcache read.
    """
    global _state_dir
    cached = _voice_states.get(reference_wav)
    if cached and cached.exists():
        return cached

    if _state_dir is None:
        _state_dir = Path(tempfile.mkdtemp(prefix="voicebox-"))

    from pocket_tts import export_model_state

    state = _model.get_state_for_audio_prompt(reference_wav)
    dest = _state_dir / f"voice-{abs(hash(reference_wav)):x}.safetensors"
    export_model_state(state, str(dest))
    _voice_states[reference_wav] = dest
    return dest


def _chunk_text(text: str, max_chars: int = 350) -> list[str]:
    """Split a message into utterances to generate one after another.

    ── Why this has to exist ───────────────────────────────────────────
    `generate_audio_stream` generates until EOS. It is built for ONE utterance,
    so handing it a whole message means it speaks the first part, reaches EOS,
    and stops — which is exactly what my human heard: it ended after the first
    paragraph. Upstream's "infinitely long text inputs" is chunking AND
    `copy_state=False` together; I built the second half and forgot the first.

    The chunks are NOT independent here, which is the whole difference from the
    ONNX path. Each one continues the same KV cache, so a boundary is a place
    the model breathes rather than a place it becomes someone else.

    Prefers paragraph breaks, then sentence ends, then clause marks — a seam
    where a listener already expects a pause.
    """
    text = (text or "").strip()
    if not text:
        return []

    # Sentence-ish units first, keeping their terminators.
    units: list[str] = []
    buf = ""
    for i, ch in enumerate(text):
        buf += ch
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if ch in ".!?" and (not nxt or nxt.isspace()):
            units.append(buf.strip())
            buf = ""
        elif ch == "\n" and nxt == "\n":
            units.append(buf.strip())
            buf = ""
    if buf.strip():
        units.append(buf.strip())

    # Pack them up to max_chars so short sentences do not become tiny
    # utterances — a very short one gives the model almost nothing to settle
    # into, which is the same shape as the runt fragment on the other backend.
    chunks: list[str] = []
    cur = ""
    for unit in units:
        if not unit:
            continue
        if len(unit) > max_chars:
            if cur:
                chunks.append(cur)
                cur = ""
            # Too long even alone: break at clause marks, then spaces.
            rest = unit
            while len(rest) > max_chars:
                window = rest[:max_chars]
                cut = max(window.rfind(", "), window.rfind("; "), window.rfind(": "))
                if cut < max_chars // 3:
                    cut = window.rfind(" ")
                if cut < max_chars // 3:
                    cut = max_chars
                chunks.append(rest[:cut + 1].strip())
                rest = rest[cut + 1:].strip()
            if rest:
                cur = rest
            continue
        candidate = f"{cur} {unit}".strip() if cur else unit
        if len(candidate) <= max_chars:
            cur = candidate
        else:
            chunks.append(cur)
            cur = unit
    if cur:
        chunks.append(cur)

    return [c for c in chunks if c]


def _to_pcm16(samples) -> bytes:
    """Torch float tensor to 16-bit LE, clamped.

    Clamping rather than wrapping: a sample slightly past full scale would
    otherwise wrap to the opposite rail and be heard as a crack, which is a
    startling failure on a surface people use because the screen is hard.
    """
    import torch

    clamped = torch.clamp(samples.detach().to(torch.float32), -1.0, 1.0)
    ints = (clamped * 32767.0).round().to(torch.int16)
    return ints.numpy().tobytes()


def op_ping(msg: dict) -> None:
    ok, err = _ensure_model()
    send({
        "reqId": msg.get("reqId"), "ok": True,
        "engineAvailable": ok,
        "engineDetail": None if ok else err,
        "loadedModels": ["tts"] if ok else [],
        "threads": {"tts": _THREADS},
        "backend": "pocket-tts",
    })


def op_load(msg: dict) -> None:
    ok, err = _ensure_model()
    if not ok:
        send({"reqId": msg.get("reqId"), "ok": False, "reason": "no-engine", "detail": err})
        return
    send({
        "reqId": msg.get("reqId"), "ok": True, "role": msg.get("role", "tts"),
        "sampleRate": int(_model.sample_rate),
        "backend": "pocket-tts",
    })


def op_unload(msg: dict) -> None:
    global _model
    _model = None
    _voice_states.clear()
    send({"reqId": msg.get("reqId"), "ok": True, "unloaded": msg.get("role") or "all"})


def op_tts_stream(msg: dict) -> None:
    """Speak a whole message as ONE continuous trajectory.

    Every chunk after the first runs with `copy_state=False`, so the KV cache
    carries forward instead of being re-initialised. That is the entire reason
    this worker exists.
    """
    req_id = msg.get("reqId")
    ok, err = _ensure_model()
    if not ok:
        send({"reqId": req_id, "ok": False, "reason": "no-engine", "detail": err})
        return

    text = msg.get("text")
    reference = msg.get("referenceWav")
    stream_id = msg.get("streamId")
    if not text or not isinstance(text, str):
        send({"reqId": req_id, "ok": False, "reason": "bad-request", "detail": "text is required"})
        return
    if not reference:
        send({"reqId": req_id, "ok": False, "reason": "no-voice",
              "detail": "a reference clip is required — PocketTTS has no built-in voice"})
        return
    if not isinstance(stream_id, int):
        send({"reqId": req_id, "ok": False, "reason": "bad-request", "detail": "streamId is required"})
        return

    try:
        state_file = _voice_state_file(reference)
        # A fresh copy per message: copy_state=False mutates, so a message must
        # not inherit the tail of the last one.
        state = _model.get_state_for_audio_prompt(str(state_file))

        sample_rate = int(_model.sample_rate)
        ceiling = _runaway_sample_limit(text, sample_rate, float(msg.get("speed") or 1.0))

        started = time.monotonic()
        sample_count = 0
        first_chunk_ms: float | None = None
        runaway = False

        pieces = _chunk_text(text)
        stopped = False

        for piece in pieces:
            if stopped:
                break
            # copy_state=False threads ONE state through every piece, so this
            # is one continuous trajectory rather than a fresh clone per
            # utterance. That is the entire reason this worker exists.
            for chunk in _model.generate_audio_stream(state, piece, copy_state=False):
                n = int(chunk.shape[-1])
                if n == 0:
                    continue
                if first_chunk_ms is None:
                    first_chunk_ms = round((time.monotonic() - started) * 1000)
                if sample_count + n > ceiling:
                    runaway = True
                    stopped = True
                    break
                sample_count += n
                if not send_pcm(stream_id, _to_pcm16(chunk)):
                    stopped = True   # the pipe is gone; stop generating into nothing
                    break

        elapsed_ms = round((time.monotonic() - started) * 1000)
        duration = sample_count / sample_rate if sample_rate else 0.0
        send({
            "reqId": req_id, "ok": True, "streamId": stream_id,
            "sampleRate": sample_rate,
            "sampleCount": sample_count,
            "durationSec": round(duration, 3),
            "elapsedMs": elapsed_ms,
            "firstChunkMs": first_chunk_ms,
            "runaway": runaway,
            "realTimeFactor": round(elapsed_ms / 1000 / duration, 3) if duration > 0 else None,
            "backend": "pocket-tts",
        })
    except Exception as exc:
        send({"reqId": req_id, "ok": False, "reason": "tts-failed", "detail": f"{type(exc).__name__}: {exc}"})


def op_transcribe(msg: dict) -> None:
    send({"reqId": msg.get("reqId"), "ok": False, "reason": "unsupported",
          "detail": "this worker speaks; listening stays with sherpa"})


_OPS = {
    "ping": op_ping,
    "load": op_load,
    "unload": op_unload,
    "ttsStream": op_tts_stream,
    "tts": op_tts_stream,   # same work; the caller keeps whichever name it knows
    "transcribe": op_transcribe,
}


def main() -> int:
    reader = FrameReader(on_error=lambda reason, detail: send({"op": "protocol-error", "reason": reason, "detail": detail}))
    send({"op": "state", "loadedModels": [], "liveDecoders": 0, "backend": "pocket-tts"})

    try:
        while True:
            chunk = sys.stdin.buffer.read1(65536)
            if not chunk:
                return 0   # EOF from the supervisor: clean exit
            for frame in reader.push(chunk):
                if frame["kind"] != KIND_JSON:
                    continue
                msg = frame.get("message") or {}
                handler = _OPS.get(msg.get("op"))
                if handler is None:
                    send({"reqId": msg.get("reqId"), "ok": False, "reason": "unknown-op", "detail": str(msg.get("op"))})
                    continue
                try:
                    handler(msg)
                except Exception as exc:
                    # A reqId that never gets an answer is a caller waiting for
                    # its whole timeout. Answer even the unexpected.
                    send({"reqId": msg.get("reqId"), "ok": False, "reason": "op-failed",
                          "detail": f"{type(exc).__name__}: {exc}"})
            if reader.broken:
                return 1   # framing lost; let supervision restart us
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        send({"op": "fatal", "detail": f"{type(exc).__name__}: {exc}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
