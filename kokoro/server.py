import io
import os
import wave

from flask import Flask, request, send_file, jsonify

app = Flask(__name__)

# Lazy-loaded on first request, same reasoning as coqui/server.py — keep
# container start/health checks instant.
_pipeline = None
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
DEFAULT_LANG_CODE = os.environ.get("KOKORO_LANG_CODE", "a")  # "a" = American English


def get_pipeline(lang_code: str):
    global _pipeline
    if _pipeline is None or _pipeline_lang() != lang_code:
        from kokoro import KPipeline

        _pipeline = KPipeline(lang_code=lang_code)
        _pipeline._lang_code = lang_code
    return _pipeline


def _pipeline_lang():
    return getattr(_pipeline, "_lang_code", None)


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.post("/speak")
def speak():
    body = request.get_json(force=True) or {}
    text = (body.get("text") or "").strip()
    voice = body.get("voice") or DEFAULT_VOICE
    lang_code = body.get("language") or DEFAULT_LANG_CODE
    if not text:
        return jsonify({"error": "text is required"}), 400

    try:
        pipeline = get_pipeline(lang_code)
        chunks = []
        for _, _, audio in pipeline(text, voice=voice):
            chunks.append(audio)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500

    import numpy as np

    full = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    pcm16 = (np.clip(full, -1.0, 1.0) * 32767).astype("<i2").tobytes()

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(24000)  # Kokoro's native output rate
        wf.writeframes(pcm16)
    buf.seek(0)
    return send_file(buf, mimetype="audio/wav")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5003)
