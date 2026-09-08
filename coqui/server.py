import io
import os
import wave

from flask import Flask, request, send_file, jsonify

app = Flask(__name__)

# Lazy-loaded on first request so `docker compose up` doesn't sit there
# loading a multi-GB model before the container even reports healthy —
# health checks hit /health, which doesn't touch the model at all.
_tts = None

SPEAKER_DIR = "/speakers"  # optional: drop a 6-10s WAV per voice here for cloning
DEFAULT_LANGUAGE = os.environ.get("XTTS_LANGUAGE", "en")
DEFAULT_SPEAKER_WAV = os.environ.get("XTTS_SPEAKER_WAV")  # e.g. /speakers/default.wav


def get_tts():
    global _tts
    if _tts is None:
        # Imported lazily too — keeps `python server.py --help`-style
        # sanity checks fast and avoids pulling in torch just to answer
        # /health.
        from TTS.api import TTS

        _tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(
            "cuda" if os.environ.get("XTTS_DEVICE", "cuda") == "cuda" else "cpu"
        )
    return _tts


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.post("/speak")
def speak():
    body = request.get_json(force=True) or {}
    text = (body.get("text") or "").strip()
    # "voice" doubles as a speaker-reference filename here (e.g. a value of
    # "jean" looks for /speakers/jean.wav) so different admin-picked voices
    # can map to different cloned speakers. Falls back to the bundled
    # default speaker/language if unset or not found.
    voice = body.get("voice") or ""
    language = body.get("language") or DEFAULT_LANGUAGE
    if not text:
        return jsonify({"error": "text is required"}), 400

    speaker_wav = None
    if voice:
        candidate = f"{SPEAKER_DIR}/{voice}.wav"
        if os.path.exists(candidate):
            speaker_wav = candidate
    if not speaker_wav:
        speaker_wav = DEFAULT_SPEAKER_WAV

    try:
        tts = get_tts()
        kwargs = {"text": text, "language": language}
        if speaker_wav:
            kwargs["speaker_wav"] = speaker_wav
        else:
            # XTTS-v2 needs *some* speaker reference; fall back to its
            # first bundled built-in speaker if no WAV was configured.
            kwargs["speaker"] = tts.speakers[0] if getattr(tts, "speakers", None) else None
        wav_array = tts.tts(**kwargs)
    except Exception as e:  # noqa: BLE001 — surface synth failures to the caller as JSON
        return jsonify({"error": str(e)}), 500

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(24000)  # XTTS-v2's native output rate
        pcm16 = (b"".join(int(max(-1.0, min(1.0, s)) * 32767).to_bytes(2, "little", signed=True) for s in wav_array))
        wf.writeframes(pcm16)
    buf.seek(0)
    return send_file(buf, mimetype="audio/wav")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5002)
