"""The framed stdio protocol, in Python.

The exact wire format `audio-frame.js` speaks, so this worker is a drop-in for
the sherpa one under the same supervisor:

    [4 bytes: payload length, big-endian][1 byte: kind][payload]

      kind 0 — JSON control frame, UTF-8
      kind 1 — PCM audio; payload is [2 bytes: stream id][16-bit LE samples]

Two implementations of one format is a thing that drifts, so the shape is
stated once here and the Node tests for `audio-frame.js` are the spec both
sides answer to. If this file and that one ever disagree, that one is right —
it is the older, and it is the one under test.

Reading is incremental because a pipe hands over whatever sized chunks it
likes: a frame split across ten reads and ten frames inside one read are the
same case, which is the entire point of length framing.
"""

from __future__ import annotations

import json
import struct
import sys
from typing import Any, Callable, Iterator

KIND_JSON = 0
KIND_PCM = 1

_HEADER = 5

# 8 MB. A second of 24 kHz 16-bit audio is 48 KB, so nothing legitimate comes
# near it — but a corrupted length prefix would otherwise ask us to buffer
# four gigabytes, and a cap turns that into a clean error a supervisor can act
# on.
MAX_FRAME_BYTES = 8 * 1024 * 1024


def encode_json(obj: Any) -> bytes:
    body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    return struct.pack(">IB", len(body), KIND_JSON) + body


def encode_pcm(stream_id: int, pcm: bytes) -> bytes:
    body = struct.pack(">H", int(stream_id) & 0xFFFF) + pcm
    return struct.pack(">IB", len(body), KIND_PCM) + body


def send(obj: Any) -> None:
    """Write a control frame. A dead pipe is the supervisor's problem, not ours."""
    try:
        sys.stdout.buffer.write(encode_json(obj))
        sys.stdout.buffer.flush()
    except (BrokenPipeError, ValueError, OSError):
        pass


def send_pcm(stream_id: int, pcm: bytes) -> bool:
    """Write an audio frame. Returns False once the pipe is gone, so a caller can stop generating."""
    try:
        sys.stdout.buffer.write(encode_pcm(stream_id, pcm))
        sys.stdout.buffer.flush()
        return True
    except (BrokenPipeError, ValueError, OSError):
        return False


class FrameReader:
    """Feed it bytes; it yields whole frames as they complete.

    On a lost length prefix it stops rather than guessing. A stream that has
    lost sync cannot be resynchronised by reading further — the bytes after it
    are audio being interpreted as headers — so the honest move is to report it
    and let supervision restart the process.
    """

    def __init__(self, on_error: Callable[[str, str], None] | None = None) -> None:
        self._buf = bytearray()
        self._broken = False
        self._on_error = on_error

    @property
    def broken(self) -> bool:
        return self._broken

    def _fail(self, reason: str, detail: str) -> None:
        self._broken = True
        self._buf.clear()
        if self._on_error:
            try:
                self._on_error(reason, detail)
            except Exception:
                pass  # a reporter must not break the reader

    def push(self, chunk: bytes) -> Iterator[dict]:
        if self._broken or not chunk:
            return
        self._buf.extend(chunk)

        while True:
            if len(self._buf) < _HEADER:
                return
            (length,) = struct.unpack(">I", self._buf[:4])
            if length > MAX_FRAME_BYTES:
                self._fail("frame-too-large", f"{length} bytes exceeds the {MAX_FRAME_BYTES}-byte limit")
                return
            if len(self._buf) < _HEADER + length:
                return  # the rest is still in flight

            kind = self._buf[4]
            body = bytes(self._buf[_HEADER:_HEADER + length])
            del self._buf[:_HEADER + length]

            if kind == KIND_JSON:
                try:
                    yield {"kind": KIND_JSON, "message": json.loads(body.decode("utf-8"))}
                except (ValueError, UnicodeDecodeError) as exc:
                    # One bad frame, not a lost stream: the length prefix told
                    # us exactly where it ended, so sync is intact.
                    if self._on_error:
                        self._on_error("bad-json", str(exc))
            elif kind == KIND_PCM:
                if len(body) < 2:
                    if self._on_error:
                        self._on_error("short-pcm", f"{len(body)} bytes")
                    continue
                (stream_id,) = struct.unpack(">H", body[:2])
                yield {"kind": KIND_PCM, "streamId": stream_id, "pcm": body[2:]}
            else:
                # Forward compatibility for free: framing held, so skip it.
                if self._on_error:
                    self._on_error("unknown-kind", str(kind))
