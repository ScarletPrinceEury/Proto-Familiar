"""The wire format, held to the same contract as audio-frame.js.

Two implementations of one protocol is a thing that drifts. These mirror the
Node tests deliberately — if a case here disagrees with tests/audio-frame.test.mjs,
that file is right: it is older and it is what the supervisor was written
against.
"""

from __future__ import annotations

import json
import struct

from voicebox.frames import (
    FrameReader, encode_json, encode_pcm, KIND_JSON, KIND_PCM, MAX_FRAME_BYTES,
)


def read_all(data: bytes, reader: FrameReader | None = None) -> list[dict]:
    return list((reader or FrameReader()).push(data))


def test_json_round_trip():
    frames = read_all(encode_json({"op": "tts", "reqId": "r1", "text": "hello"}))
    assert len(frames) == 1
    assert frames[0]["kind"] == KIND_JSON
    assert frames[0]["message"] == {"op": "tts", "reqId": "r1", "text": "hello"}


def test_pcm_keeps_its_stream_id_and_bytes():
    pcm = bytes([0, 1, 2, 3, 250, 251, 252, 253])
    frames = read_all(encode_pcm(7, pcm))
    assert frames[0]["kind"] == KIND_PCM
    assert frames[0]["streamId"] == 7
    assert frames[0]["pcm"] == pcm


def test_several_frames_in_one_chunk_arrive_in_order():
    data = encode_json({"n": 1}) + encode_pcm(2, bytes(16)) + encode_json({"n": 3})
    frames = read_all(data)
    assert [f.get("message", {}).get("n") for f in frames] == [1, None, 3]
    assert frames[1]["streamId"] == 2


def test_a_frame_split_at_every_byte_boundary_still_arrives_whole():
    # Not an edge case on a pipe — the normal case once buffers fill.
    encoded = encode_json({"op": "endpoint"}) + encode_pcm(4, bytes(64))
    for split in range(1, len(encoded)):
        reader = FrameReader()
        frames = list(reader.push(encoded[:split])) + list(reader.push(encoded[split:]))
        assert len(frames) == 2, f"split at {split} lost a frame"


def test_one_byte_at_a_time():
    reader = FrameReader()
    frames = []
    for b in encode_json({"text": "the quick brown fox"}):
        frames.extend(reader.push(bytes([b])))
    assert len(frames) == 1
    assert frames[0]["message"]["text"] == "the quick brown fox"


def test_empty_pcm_is_legal():
    frames = read_all(encode_pcm(3, b""))
    assert frames[0]["pcm"] == b""
    assert frames[0]["streamId"] == 3


def test_stream_ids_span_the_full_16_bit_range():
    data = b"".join(encode_pcm(i, b"\x01\x02") for i in (0, 1, 255, 256, 65535))
    assert [f["streamId"] for f in read_all(data)] == [0, 1, 255, 256, 65535]


def test_an_impossible_length_breaks_the_reader_rather_than_reading_audio_as_headers():
    errors = []
    reader = FrameReader(on_error=lambda r, d: errors.append(r))
    frames = list(reader.push(struct.pack(">IB", 0xFFFFFFFF, 0)))
    assert frames == []
    assert reader.broken is True
    assert errors == ["frame-too-large"]
    # and nothing further is emitted
    assert list(reader.push(encode_json({"op": "still-here"}))) == []


def test_malformed_json_loses_one_frame_not_the_stream():
    # The length prefix said exactly where it ended, so sync is intact.
    errors = []
    reader = FrameReader(on_error=lambda r, d: errors.append(r))
    body = b"{not json"
    bad = struct.pack(">IB", len(body), KIND_JSON) + body
    frames = list(reader.push(bad + encode_json({"op": "fine"})))
    assert errors == ["bad-json"]
    assert reader.broken is False
    assert len(frames) == 1
    assert frames[0]["message"]["op"] == "fine"


def test_unknown_kind_is_skipped_so_a_newer_peer_cannot_break_an_older_one():
    errors = []
    reader = FrameReader(on_error=lambda r, d: errors.append(r))
    body = b"whatever"
    future = struct.pack(">IB", len(body), 99) + body
    frames = list(reader.push(future + encode_json({"op": "fine"})))
    assert errors == ["unknown-kind"]
    assert reader.broken is False
    assert len(frames) == 1


def test_short_pcm_is_reported_not_routed_by_guess():
    errors = []
    reader = FrameReader(on_error=lambda r, d: errors.append(r))
    body = b"\x01"
    short = struct.pack(">IB", len(body), KIND_PCM) + body
    frames = list(reader.push(short))
    assert errors == ["short-pcm"]
    assert frames == [], "audio with no known destination is dropped, never guessed at"


def test_a_realistic_audio_burst_in_awkward_chunks():
    data = b"".join(encode_pcm(i % 2, bytes(640)) for i in range(100))
    reader = FrameReader()
    frames = []
    for i in range(0, len(data), 777):
        frames.extend(reader.push(data[i:i + 777]))
    assert len(frames) == 100
    assert len(frames[99]["pcm"]) == 640


def test_the_cap_is_the_same_number_node_uses():
    assert MAX_FRAME_BYTES == 8 * 1024 * 1024
