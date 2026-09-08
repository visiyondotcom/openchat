# Piper (https://github.com/rhasspy/piper) is MIT-licensed, fully local
# text-to-speech — no cloud call, no API key. This wraps its CLI in a tiny
# Flask server so the backend can call it over HTTP like any other service.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends wget tar && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir flask piper-tts

# Default voice: a small, permissively-licensed English voice from the
# official Piper voice collection. Override PIPER_VOICE / mount your own
# .onnx + .onnx.json into /voices to use a different one (incl. Dutch,
# e.g. nl_NL-mls-medium).
RUN mkdir -p /voices && \
    wget -q -O /voices/en_US-lessac-medium.onnx \
      https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx && \
    wget -q -O /voices/en_US-lessac-medium.onnx.json \
      https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json

COPY server.py /app/server.py
WORKDIR /app

EXPOSE 5001
CMD ["python", "server.py"]
