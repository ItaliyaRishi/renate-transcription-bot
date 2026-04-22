from __future__ import annotations

import logging
import os
import tempfile
from dataclasses import asdict
from typing import Optional

import boto3
from botocore.client import Config as BotoConfig
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .config import load_settings
from .pyannote_runner import DiarizeAuthError, load_pipeline, run_diarization

settings = load_settings()
logging.basicConfig(level=settings.log_level.upper())
log = logging.getLogger("diarize")

app = FastAPI(title="renate-diarize", version="0.2.0")


class DiarizeRequest(BaseModel):
    session_id: str
    s3_key: str
    num_speakers: Optional[int] = None
    min_speakers: Optional[int] = None
    max_speakers: Optional[int] = None


class SpeakerTurnModel(BaseModel):
    start_ts: float
    end_ts: float
    cluster: str


class DiarizeResponse(BaseModel):
    session_id: str
    turns: list[SpeakerTurnModel]


def _s3_client():
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        region_name=settings.s3_region,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        config=BotoConfig(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


@app.get("/healthz")
async def healthz() -> dict[str, object]:
    return {
        "ok": True,
        "pipeline_loaded": getattr(app.state, "pipeline", None) is not None,
        "pipeline_error": getattr(app.state, "pipeline_error", None),
    }


@app.post("/diarize", response_model=DiarizeResponse)
async def diarize(req: DiarizeRequest) -> DiarizeResponse:
    log.info("diarize request: session=%s key=%s", req.session_id, req.s3_key)

    pipeline = getattr(app.state, "pipeline", None)
    if pipeline is None:
        # Startup load failed; try once more on-demand (maybe HF_TOKEN was
        # swapped in after boot via `docker compose restart`).
        try:
            pipeline = load_pipeline(settings.hf_token)
            app.state.pipeline = pipeline
            app.state.pipeline_error = None
        except DiarizeAuthError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"pipeline load failed: {e}")

    s3 = _s3_client()
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        local_path = tmp.name
    try:
        log.info(
            "downloading s3://%s/%s -> %s",
            settings.s3_bucket_audio, req.s3_key, local_path,
        )
        s3.download_file(settings.s3_bucket_audio, req.s3_key, local_path)
        turns = run_diarization(
            local_path,
            pipeline,
            num_speakers=req.num_speakers,
            min_speakers=req.min_speakers,
            max_speakers=req.max_speakers,
        )
    finally:
        try:
            os.unlink(local_path)
        except OSError:
            pass

    return DiarizeResponse(
        session_id=req.session_id,
        turns=[SpeakerTurnModel(**asdict(t)) for t in turns],
    )


@app.on_event("startup")
async def on_startup() -> None:
    log.info("diarize: boot")
    app.state.pipeline = None
    app.state.pipeline_error = None
    try:
        app.state.pipeline = load_pipeline(settings.hf_token)
        log.info("diarize: pipeline pre-warmed")
    except DiarizeAuthError as e:
        app.state.pipeline_error = str(e)
        log.warning("diarize: pipeline load failed at startup: %s", e)
    except Exception as e:
        app.state.pipeline_error = f"{type(e).__name__}: {e}"
        log.exception("diarize: unexpected error loading pipeline")
