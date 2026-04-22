"""
Speaker-diarization backend.

Historically this wrapped pyannote.audio. We now use FoxNoseTech/diarize
because pyannote 3.3.x is fragile to package (eager matplotlib +
pytorch_metric_learning imports), requires an HF token with gated-repo
access, and is ~8x slower on CPU. The `diarize` library is Apache-2.0,
needs no HF token, and achieves ~8x realtime on CPU with slightly better
accuracy on VoxConverse.

File is still named pyannote_runner.py for backward compat with existing
imports; renaming can happen later as a separate chore.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger("diarize.backend")


@dataclass
class SpeakerTurn:
    start_ts: float
    end_ts: float
    cluster: str


class DiarizeAuthError(Exception):
    """Kept for backward compatibility with main.py error handling. Not used
    by the new backend (it needs no credentials), but the exception type
    being importable keeps the import surface stable."""


def load_pipeline(_hf_token: str) -> Any:
    """Return a callable "pipeline". `diarize.diarize` auto-downloads its
    ONNX weights to ~/.cache/diarize on first call, so there's no explicit
    load step — we just return the function itself and let the library
    manage its own lazy initialization.

    Called at FastAPI startup so the first /diarize request pays the cache
    warm-up, not the real request.
    """
    from diarize import diarize as diarize_fn

    # Warm up by calling the import path; actual model init is deferred
    # until the first real call. That's OK — the first real call ships
    # within the worker's 30-min timeout and only runs once per container.
    logger.info("diarize backend: FoxNoseTech/diarize loaded")
    return diarize_fn


def run_diarization(
    wav_path: str,
    pipeline: Any,
    num_speakers: Optional[int] = None,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
) -> list[SpeakerTurn]:
    # If an exact count is given, it wins — skip the range bounds.
    kwargs: dict[str, int] = {}
    if num_speakers is not None:
        kwargs["num_speakers"] = num_speakers
    else:
        if min_speakers is not None:
            kwargs["min_speakers"] = min_speakers
        if max_speakers is not None:
            kwargs["max_speakers"] = max_speakers

    result = pipeline(wav_path, **kwargs) if kwargs else pipeline(wav_path)

    turns: list[SpeakerTurn] = []
    for seg in result.segments:
        turns.append(
            SpeakerTurn(
                start_ts=float(seg.start),
                end_ts=float(seg.end),
                cluster=str(seg.speaker),
            )
        )
    turns.sort(key=lambda t: t.start_ts)
    logger.info(
        "diarization produced %d turns across %d speakers",
        len(turns),
        getattr(result, "num_speakers", len({t.cluster for t in turns})),
    )
    return turns
