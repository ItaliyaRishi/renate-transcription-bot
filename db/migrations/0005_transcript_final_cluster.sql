-- Add cluster column to transcript_final so two diarize clusters
-- accidentally resolved to the same display name still produce two rows.
ALTER TABLE transcript_final
    ADD COLUMN IF NOT EXISTS cluster TEXT;
