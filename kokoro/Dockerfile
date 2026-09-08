# Kokoro-TTS (https://github.com/hexgrad/kokoro) — open-source, small
# (~80M params) TTS model. Sits between Piper and XTTS-v2: noticeably more
# natural than Piper, and fast enough to run acceptably on CPU (still
# faster with a GPU). Runs fully local, no API key.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      espeak-ng git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir flask kokoro numpy soundfile

COPY server.py /app/server.py
WORKDIR /app

EXPOSE 5003
CMD ["python", "server.py"]
