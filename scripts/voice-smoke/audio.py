"""Local PCM fixture preparation and decoding of synthetic WebRTC output."""
import array
import base64
import ctypes
import ctypes.util
import json
import math
import sys
import wave
from pathlib import Path


def opus_library():
    name = ctypes.util.find_library("opus")
    if not name:
        raise RuntimeError("libopus is required")
    return ctypes.CDLL(name)


def prepare(source, destination):
    opus_library()
    with wave.open(source, "rb") as audio:
        params = audio.getparams()
        if params.sampwidth != 2 or params.comptype != "NONE":
            raise ValueError("Expected a PCM16 fixture")
        frames = audio.readframes(params.nframes)
    # Pace silence through the input file itself; ffmpeg -re does not pace apad.
    frames += bytes(max(0, params.framerate * 70 - params.nframes) * params.nchannels * 2)
    with wave.open(destination, "wb") as audio:
        audio.setparams(params)
        audio.writeframes(frames)


def decode(source, destination, start_ms, end_ms):
    packets = json.loads(Path(source).read_text())
    lib = opus_library()
    lib.opus_decoder_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
    lib.opus_decoder_create.restype = ctypes.c_void_p
    lib.opus_decode.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_int16), ctypes.c_int, ctypes.c_int]
    lib.opus_decoder_destroy.argtypes = [ctypes.c_void_p]
    error = ctypes.c_int()
    decoder = lib.opus_decoder_create(48000, 2, ctypes.byref(error))
    if not decoder or error.value:
        raise RuntimeError("Could not create the Opus decoder")
    buffer = (ctypes.c_int16 * (5760 * 2))()
    decoded_frames = 0
    window = bytearray()
    errors = []
    non_dtx = 0
    seen = set()
    first_timestamp = packets[0]["timestamp"] if packets else 0
    try:
        for packet in sorted(packets, key=lambda p: (p["timestamp"] - first_timestamp) & 0xFFFFFFFF):
            if packet["timestamp"] in seen:
                continue
            seen.add(packet["timestamp"])
            payload = base64.b64decode(packet["payload"], validate=True)
            size = lib.opus_decode(decoder, payload, len(payload), buffer, 5760, 0)
            if size < 0:
                errors.append(size)
                continue
            frames = ctypes.string_at(buffer, size * 4)
            decoded_frames += size
            if start_ms <= packet["receivedAtMs"] <= end_ms:
                window.extend(frames)
                non_dtx += len(payload) > 3
    finally:
        lib.opus_decoder_destroy(decoder)
    with wave.open(destination, "wb") as audio:
        audio.setnchannels(2)
        audio.setsampwidth(2)
        audio.setframerate(48000)
        audio.writeframes(window)
    samples = array.array("h", window)
    if sys.byteorder != "little":
        samples.byteswap()
    return {
        "decodedPackets": len(seen),
        "decodeErrors": errors,
        "decodedSeconds": decoded_frames / 48000,
        "responseSeconds": len(window) / 192000,
        "windowNonDtxPackets": non_dtx,
        "windowPeak": max(map(abs, samples), default=0),
        "windowRms": round(math.sqrt(sum(x * x for x in samples) / max(1, len(samples))), 2),
    }


if __name__ == "__main__":
    try:
        if sys.argv[1] == "prepare":
            prepare(sys.argv[2], sys.argv[3])
        elif sys.argv[1] == "decode":
            print(json.dumps(decode(sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5]))))
        else:
            raise ValueError("Unknown operation")
    except Exception:
        # Do not echo upstream audio or environment details into maintenance logs.
        print("Local audio preparation or decoding failed; check PCM fixture and system libopus.", file=sys.stderr)
        sys.exit(2)
