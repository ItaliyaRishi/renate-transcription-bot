-- Persist Sarvam word-level timestamps so finalize can re-cut text at
-- diarize turn boundaries instead of merging by speaker_name only.
ALTER TABLE transcript_segments
    ADD COLUMN IF NOT EXISTS words JSONB;
