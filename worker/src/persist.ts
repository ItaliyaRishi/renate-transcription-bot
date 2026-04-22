import type { Pool } from "pg";
import type { TranscribedSegment } from "./sarvam.js";

export async function insertTranscriptSegments(
  pool: Pool,
  sessionId: string,
  chunkIdx: number,
  segments: TranscribedSegment[]
): Promise<void> {
  if (!segments.length) return;
  const values: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const s of segments) {
    values.push(
      `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`
    );
    params.push(sessionId, chunkIdx, s.startTs, s.endTs, s.rawText, s.confidence, s.sarvamRequestId);
  }
  await pool.query(
    `INSERT INTO transcript_segments
       (session_id, chunk_idx, start_ts, end_ts, raw_text, confidence, sarvam_request_id)
     VALUES ${values.join(", ")}`,
    params
  );
}

export async function writeFinalTranscript(
  pool: Pool,
  sessionId: string,
  rows: Array<{ startTs: number; endTs: number; speakerName: string; text: string }>
): Promise<void> {
  if (!rows.length) return;
  const values: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const r of rows) {
    values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(sessionId, r.startTs, r.endTs, r.speakerName, r.text);
  }
  await pool.query(
    `INSERT INTO transcript_final
       (session_id, start_ts, end_ts, speaker_name, text)
     VALUES ${values.join(", ")}`,
    params
  );
}

export async function insertSpeakerTurns(
  pool: Pool,
  sessionId: string,
  turns: Array<{ startTs: number; endTs: number; cluster: string; resolvedName?: string }>
): Promise<void> {
  if (!turns.length) return;
  const values: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const t of turns) {
    values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(sessionId, t.startTs, t.endTs, t.cluster, t.resolvedName ?? null);
  }
  await pool.query(
    `INSERT INTO speaker_turns
       (session_id, start_ts, end_ts, pyannote_cluster, resolved_name)
     VALUES ${values.join(", ")}`,
    params
  );
}

export async function persistDomCaptions(
  pool: Pool,
  sessionId: string,
  rows: Array<{ startTs: number; endTs: number; speakerName: string; text: string }>
): Promise<void> {
  if (!rows.length) return;
  const values: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const r of rows) {
    values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(sessionId, r.startTs, r.endTs, r.speakerName, r.text);
  }
  await pool.query(
    `INSERT INTO dom_captions
       (session_id, start_ts, end_ts, speaker_name, text)
     VALUES ${values.join(", ")}`,
    params
  );
}

export async function updateSessionStatus(
  pool: Pool,
  sessionId: string,
  status: string,
  extra: { startedAt?: Date; endedAt?: Date; durationS?: number; summaryMd?: string } = {}
): Promise<void> {
  const sets: string[] = ["status = $2"];
  const params: unknown[] = [sessionId, status];
  let i = 3;
  if (extra.startedAt !== undefined) {
    sets.push(`started_at = $${i++}`);
    params.push(extra.startedAt);
  }
  if (extra.endedAt !== undefined) {
    sets.push(`ended_at = $${i++}`);
    params.push(extra.endedAt);
  }
  if (extra.durationS !== undefined) {
    sets.push(`duration_s = $${i++}`);
    params.push(extra.durationS);
  }
  if (extra.summaryMd !== undefined) {
    sets.push(`summary_md = $${i++}`);
    params.push(extra.summaryMd);
  }
  await pool.query(`UPDATE sessions SET ${sets.join(", ")} WHERE id = $1`, params);
}
