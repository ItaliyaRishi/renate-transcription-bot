-- 0003: drop workspace_credentials
--
-- The Meet REST API integration was removed. Speaker attribution now runs
-- entirely on in-call DOM signals (caption badges, active-speaker tile) plus
-- diarization. No Google OAuth refresh tokens are stored anywhere.

DROP TRIGGER IF EXISTS workspace_credentials_updated_at ON workspace_credentials;
DROP TABLE IF EXISTS workspace_credentials;
