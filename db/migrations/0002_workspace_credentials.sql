-- Workspace OAuth credentials for Google Meet REST API access.
-- Stores a long-lived refresh token per recruiter Google account;
-- access token is refreshed on-demand by the worker.

CREATE TABLE IF NOT EXISTS workspace_credentials (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    google_account_email     TEXT NOT NULL UNIQUE,
    refresh_token            TEXT NOT NULL,
    access_token             TEXT,
    access_token_expires_at  TIMESTAMPTZ,
    scopes                   TEXT[] NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS workspace_credentials_updated_at ON workspace_credentials;
CREATE TRIGGER workspace_credentials_updated_at
    BEFORE UPDATE ON workspace_credentials
    FOR EACH ROW EXECUTE FUNCTION trg_sessions_updated_at();
