-- Renate initial schema (Phase 4).
-- Loaded on first postgres boot via docker-entrypoint-initdb.d.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS bot_accounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           TEXT NOT NULL UNIQUE,
    auth_path       TEXT NOT NULL,
    last_used_at    TIMESTAMPTZ,
    cooldown_until  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meet_url        TEXT NOT NULL,
    bot_account_id  UUID REFERENCES bot_accounts(id),
    status          TEXT NOT NULL DEFAULT 'queued',
        -- queued, joining, live, finalizing, complete, failed
    started_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    duration_s      INTEGER,
    summary_md      TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);

CREATE TABLE IF NOT EXISTS transcript_segments (
    id                  BIGSERIAL PRIMARY KEY,
    session_id          UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    chunk_idx           INTEGER NOT NULL,
    start_ts            DOUBLE PRECISION NOT NULL,
    end_ts              DOUBLE PRECISION NOT NULL,
    raw_text            TEXT NOT NULL,
    confidence          REAL,
    sarvam_request_id   TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transcript_segments_session_idx
    ON transcript_segments(session_id, chunk_idx, start_ts);

CREATE TABLE IF NOT EXISTS dom_captions (
    id             BIGSERIAL PRIMARY KEY,
    session_id     UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    start_ts       DOUBLE PRECISION NOT NULL,
    end_ts         DOUBLE PRECISION NOT NULL,
    speaker_name   TEXT NOT NULL,
    text           TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dom_captions_session_idx
    ON dom_captions(session_id, start_ts);

CREATE TABLE IF NOT EXISTS speaker_turns (
    id                 BIGSERIAL PRIMARY KEY,
    session_id         UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    start_ts           DOUBLE PRECISION NOT NULL,
    end_ts             DOUBLE PRECISION NOT NULL,
    pyannote_cluster   TEXT NOT NULL,
    resolved_name      TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS speaker_turns_session_idx
    ON speaker_turns(session_id, start_ts);

CREATE TABLE IF NOT EXISTS transcript_final (
    id             BIGSERIAL PRIMARY KEY,
    session_id     UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    start_ts       DOUBLE PRECISION NOT NULL,
    end_ts         DOUBLE PRECISION NOT NULL,
    speaker_name   TEXT NOT NULL,
    text           TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transcript_final_session_idx
    ON transcript_final(session_id, start_ts);

CREATE OR REPLACE FUNCTION trg_sessions_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sessions_updated_at ON sessions;
CREATE TRIGGER sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION trg_sessions_updated_at();
