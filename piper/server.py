import io
import subprocess
from flask import Flask, request, send_file, jsonify

app = Flask(__name__)
VOICE_DIR = "/voices"


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.post("/speak")
def speak():
    body = request.get_json(force=True) or {}
    text = (body.get("text") or "").strip()
    voice = body.get("voice") or "en_US-lessac-medium"
    if not text:
        return jsonify({"error": "text is required"}), 400

    model_path = f"{VOICE_DIR}/{voice}.onnx"
    try:
        proc = subprocess.run(
            ["piper", "--model", model_path, "--output_file", "-"],
            input=text.encode("utf-8"),
            capture_output=True,
            timeout=60,
        )
    except FileNotFoundError:
        return jsonify({"error": f"voice '{voice}' not found in {VOICE_DIR}"}), 400
    except subprocess.TimeoutExpired:
        return jsonify({"error": "synthesis timed out"}), 504

    if proc.returncode != 0:
        return jsonify({"error": proc.stderr.decode("utf-8", "ignore")}), 500

    return send_file(io.BytesIO(proc.stdout), mimetype="audio/wav")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001)
