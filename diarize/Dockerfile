FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# `diarize` is a self-contained CPU-first speaker diarization library
# (ONNX Runtime + Silero VAD + WeSpeaker). It pins its own torch range
# and auto-downloads models on first run — no HF token required.
RUN pip install \
        "diarize==0.1.1" \
        "fastapi>=0.115.0" \
        "uvicorn[standard]>=0.32.0" \
        "pydantic>=2.9.0" \
        "pydantic-settings>=2.6.0" \
        "boto3>=1.35.0"

COPY src ./src

EXPOSE 8000
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
