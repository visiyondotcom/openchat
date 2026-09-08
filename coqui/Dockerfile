# Coqui XTTS-v2 (https://github.com/coqui-ai/TTS) — open-source,
# multilingual, voice-cloning-capable TTS. Much more natural-sounding than
# Piper, but heavier: a GPU is strongly recommended (CPU inference works
# but is slow enough to hurt real-time conversation). Runs fully local,
# no API key.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential git ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir flask coqui-tts

# Accept the XTTS-v2 non-commercial license non-interactively — same
# license acceptance CoquiTTS itself prompts for on first run. Review the
# license (https://coqui.ai/cpml) before enabling this in production if
# you plan to use it commercially.
ENV COQUI_TOS_AGREED=1

# Optional: mount your own reference WAVs (6-10s of clean speech) into
# /speakers for voice cloning — name them to match the "voice" value sent
# from Admin > Settings > Voice, e.g. /speakers/jean.wav for voice="jean".
RUN mkdir -p /speakers

COPY server.py /app/server.py
WORKDIR /app

EXPOSE 5002
CMD ["python", "server.py"]
