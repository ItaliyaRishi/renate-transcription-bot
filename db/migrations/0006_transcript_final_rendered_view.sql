-- View renders each transcript row as "[HH:MM AM/PM] Speaker: text" using
-- sessions.started_at + transcript_final.start_ts in Asia/Kolkata. Used by
-- ad-hoc psql reads (TEST_COMMANDS step 4) and as a sanity check against
-- the worker-side renderer.
CREATE OR REPLACE VIEW transcript_final_rendered AS
SELECT
    tf.session_id,
    tf.start_ts,
    tf.end_ts,
    tf.speaker_name,
    tf.text,
    tf.cluster,
    '[' || to_char(
        (s.started_at AT TIME ZONE 'Asia/Kolkata') + (tf.start_ts || ' seconds')::interval,
        'HH12:MI AM'
    ) || '] ' || tf.speaker_name || ': ' || tf.text AS text_line
  FROM transcript_final tf
  JOIN sessions s ON s.id = tf.session_id;
