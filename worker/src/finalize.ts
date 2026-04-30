import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { S3Client } from "@aws-sdk/client-s3";
import pino from "pino";
import { getAudioChunk, putAudioChunk } from "./s3.js";
import {
  resolveClusterNames,
  type DomCaptionRecord,
  type NameEvent,
  type PyannoteTurn,
} from "./reconcile.js";
import {
  insertSpeakerTurns,
  persistDomCaptions,
  updateSessionStatus,
  writeFinalTranscript,
} from "./persist.js";
import { alignWordsToTurns, type Word } from "./turnAlign.js";
import { renderTranscript, type FinalRow } from "./renderTranscript.js";
import { summarize } from "./summarize.js";

const log = pino({ name: "worker.finalize", level: process.env.LOG_LEVEL ?? "info" });

export interface FinalizeInput {
  sessionId: string;
  pg: Pool;
  redis: Redis;
  s3: S3Client;
  bucket: string;
  diarizeUrl: string;
  openaiApiKey: string;
  /** Total participants in the call as reported by the bot (includes bot itself). */
  participantCount?: number | null;
}

export async function finalizeSession(input: FinalizeInput): Promise<void> {
  const { sessionId, pg, redis, s3, bucket, diarizeUrl, openaiApiKey } = input;

  await updateSessionStatus(pg, sessionId, "finalizing");

  // 1) Drain the Redis caption stream → these are our primary name signal.
  // Persist them to Postgres for audit/UI regardless of reconciliation.
  const captions = await drainCaptionStream(redis, sessionId);
  if (captions.length) await persistDomCaptions(pg, sessionId, captions);

  // 1b) Drain the active-speaker tile stream. Fires during spans Meet's own
  // captions don't (Hindi monologue, mumbled speech, cross-talk).
  const tileEvents = await drainActiveSpeakerStream(redis, sessionId);

  // Roster precedence: sessions.metadata.expectedSpeakers (caller override)
  // Metadata wins if present — it's the caller's explicit authority.
  const roster = await readRoster(redis, pg, sessionId);

  // T0 in wall-clock ms. Captions + tile events use Date.now(); pyannote
  // turns are call-relative seconds, so we need an anchor to put them in
  // the same coordinate system. sessions.started_at is set when the bot
  // transitions to 'joining' — audio capture starts shortly after, so this
  // is a few seconds off at worst (tolerable given turn durations of 2-10s).
  const startedAtMs = await readSessionStartedAt(pg, sessionId);

  log.info(
    {
      sessionId,
      captions: captions.length,
      tileEvents: tileEvents.length,
      rosterNames: roster.names,
      rosterSource: roster.source,
      startedAtMs,
    },
    "name sources drained"
  );

  // 1a) Resolve a speaker-count hint for the diarizer. Priority:
  //   (i)   distinct speaker names from captions (most reliable)
  //   (ii)  participant count reported by bot minus 1 (bot itself)
  //   (iii) roster length (captions may have been blocked but names are known)
  //   (iv)  safe range band 2..6 so the diarizer can still estimate
  const distinctCaptionNames = new Set(
    captions.map((c) => c.speakerName).filter((n) => n && n !== "Unknown")
  );
  let numSpeakers: number | undefined;
  let minSpeakers: number | undefined;
  let maxSpeakers: number | undefined;
  if (distinctCaptionNames.size >= 2) {
    numSpeakers = distinctCaptionNames.size;
  } else if (
    typeof input.participantCount === "number" &&
    input.participantCount >= 2
  ) {
    const humans = Math.max(1, input.participantCount - 1); // subtract the bot
    if (humans >= 2) numSpeakers = humans;
    else {
      minSpeakers = 2;
      maxSpeakers = 6;
    }
  } else if (roster.names.length >= 2) {
    numSpeakers = roster.names.length;
  } else {
    minSpeakers = 2;
    maxSpeakers = 6;
  }
  log.info(
    {
      sessionId,
      distinctCaptionNames: distinctCaptionNames.size,
      botReportedCount: input.participantCount ?? null,
      numSpeakers,
      minSpeakers,
      maxSpeakers,
    },
    "speaker-count hint resolved"
  );

  // 2) Assemble the session WAV. We concatenate chunk_*.wav objects from S3
  // using ffmpeg's concat demuxer via a single pass. For Phase 1 of finalize
  // we use a simpler approach: read all chunk buffers and run ffmpeg locally.
  const fullKey = `sessions/${sessionId}/full.wav`;
  const assembled = await assembleSessionWav(s3, bucket, sessionId, fullKey);
  log.info({ sessionId, assembled }, "session wav assembled");

  // 3) Ask the diarize sidecar to produce speaker turns.
  let turns: PyannoteTurn[] = [];
  try {
    turns = await callDiarize(diarizeUrl, sessionId, fullKey, {
      numSpeakers,
      minSpeakers,
      maxSpeakers,
    });
    log.info({ sessionId, turns: turns.length }, "diarization complete");
  } catch (err) {
    log.error({ err, sessionId }, "diarize failed; falling back to DOM-only speakers");
  }

  // 4) Fuse caption + tile events against diarization turns. Captions are
  // weighted 2×, tile hits 1×; winners canonicalize against the roster.
  // Clusters with no evidence take the next unused roster entry, else
  // "Speaker N".
  const nameEvents: NameEvent[] = [
    ...captions.map((c) => ({
      tSec: toCallRelSec((c.startTs + c.endTs) / 2, startedAtMs),
      name: c.speakerName,
      source: "caption" as const,
    })),
    ...tileEvents.map((e) => ({
      tSec: toCallRelSec(e.tMs, startedAtMs),
      name: e.name,
      source: "tile" as const,
    })),
  ];

  const { clusterToName: speakerMap, resolution, weightMatrix } = resolveClusterNames(
    turns,
    nameEvents,
    roster.names
  );
  const numClusters = Object.keys(speakerMap).length;
  const numAssignedNames = Object.values(resolution).filter(
    (r) => r === "caption" || r === "tile"
  ).length;
  const numFallbackNames = Object.values(resolution).filter(
    (r) => r === "fallback"
  ).length;
  log.info(
    {
      sessionId,
      speakerMap,
      resolution,
      rosterSource: roster.source,
      numClusters,
      numAssignedNames,
      numFallbackNames,
      weightMatrix,
    },
    "speaker map"
  );

  // Persist speaker turns with resolved names attached.
  await insertSpeakerTurns(
    pg,
    sessionId,
    turns.map((t) => ({
      startTs: t.startTs,
      endTs: t.endTs,
      cluster: t.cluster,
      resolvedName: speakerMap[t.cluster],
    }))
  );

  // 5) Pull transcript_segments + word timings, then build transcript_final
  // ROW-PER-DIARIZE-TURN. This preserves rapid back-and-forth: a one-word
  // interjection that cuts another speaker off lands as its own row,
  // because diarize already produced an A→B→A turn list.
  const { segments: segs, words } = await loadSegmentsAndWords(pg, sessionId);
  log.info(
    { sessionId, segs: segs.length, words: words.length },
    "segments + words loaded"
  );

  let finalRows: Array<{
    startTs: number;
    endTs: number;
    speakerName: string;
    text: string;
    cluster: string | null;
  }>;
  if (turns.length && words.length) {
    const aligned = alignWordsToTurns(words, turns);
    finalRows = aligned.map((r) => ({
      startTs: r.startTs,
      endTs: r.endTs,
      speakerName: speakerMap[r.cluster] ?? r.cluster,
      text: r.text,
      cluster: r.cluster,
    }));
  } else if (turns.length) {
    // Sarvam returned no per-word timings — degrade to per-segment overlap
    // with diarize turns. Still one row per segment, no merging.
    finalRows = segs.map((s) => {
      const best = pickBestTurnOverlap(s.startTs, s.endTs, turns);
      return {
        startTs: s.startTs,
        endTs: s.endTs,
        speakerName: best ? speakerMap[best.cluster] ?? best.cluster : "Unknown",
        text: s.text,
        cluster: best?.cluster ?? null,
      };
    });
  } else {
    // No diarization at all → attribute each Sarvam segment to the caption
    // row whose interval overlaps it most.
    finalRows = segs.map((s) => {
      const best = pickOverlap(s.startTs, s.endTs, captions);
      return {
        startTs: s.startTs,
        endTs: s.endTs,
        speakerName: best?.speakerName ?? "Unknown",
        text: s.text,
        cluster: null,
      };
    });
  }
  await writeFinalTranscript(pg, sessionId, finalRows);

  // 6) Render transcript in user-spec format and feed to OpenAI.
  const startedAtDate = startedAtMs ? new Date(startedAtMs) : null;
  const renderRows: FinalRow[] = finalRows.map((r) => ({
    startTs: r.startTs,
    endTs: r.endTs,
    speakerName: r.speakerName,
    text: r.text,
  }));
  const transcriptText = renderTranscript(renderRows, startedAtDate);
  let summaryMd: string | undefined;
  try {
    summaryMd = await summarize({
      sessionId,
      transcriptMarkdown: transcriptText,
      apiKey: openaiApiKey,
    });
  } catch (err) {
    log.error({ err, sessionId }, "summarize failed; session will ship without summary");
  }

  // 7) Mark complete and drop Redis session state.
  const endedAt = new Date();
  await updateSessionStatus(pg, sessionId, "complete", {
    endedAt,
    summaryMd,
  });
  await redis.del(
    `captions:${sessionId}`,
    `active_speaker:${sessionId}`,
    `session:${sessionId}:alive`,
    `session:${sessionId}:roster`
  );
  log.info({ sessionId }, "session complete");
}

async function drainActiveSpeakerStream(
  redis: Redis,
  sessionId: string
): Promise<Array<{ tMs: number; name: string }>> {
  const key = `active_speaker:${sessionId}`;
  const entries = (await redis.xrange(key, "-", "+")) as Array<[string, string[]]>;
  const out: Array<{ tMs: number; name: string }> = [];
  for (const [, fields] of entries) {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
    if (!obj.name) continue;
    const tMs = Number(obj.tMs);
    if (!Number.isFinite(tMs)) continue;
    out.push({ tMs, name: obj.name });
  }
  return out;
}

async function readSessionStartedAt(pg: Pool, sessionId: string): Promise<number> {
  const { rows } = await pg.query<{ started_at: Date | null }>(
    `SELECT started_at FROM sessions WHERE id = $1`,
    [sessionId]
  );
  const ts = rows[0]?.started_at;
  if (ts instanceof Date) return ts.getTime();
  // Fallback: "now" — loses absolute alignment but still yields a sane,
  // monotonic coord system for events drained from the stream.
  return Date.now();
}

function toCallRelSec(tMs: number, startedAtMs: number): number {
  return (tMs - startedAtMs) / 1000;
}

async function drainCaptionStream(
  redis: Redis,
  sessionId: string
): Promise<DomCaptionRecord[]> {
  const key = `captions:${sessionId}`;
  const entries = (await redis.xrange(key, "-", "+")) as Array<[string, string[]]>;
  const out: DomCaptionRecord[] = [];
  for (const [, fields] of entries) {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
    if (!obj.text) continue;
    out.push({
      startTs: Number(obj.tStart),
      endTs: Number(obj.tEnd),
      speakerName: obj.speaker ?? "Unknown",
      text: obj.text,
    });
  }
  return out;
}

// Merge the People-panel roster (Redis) with sessions.metadata.expectedSpeakers
// (Postgres). If the caller supplied expectedSpeakers, those are authoritative
// and replace the scraped roster. Otherwise the scraped roster is used.
async function readRoster(
  redis: Redis,
  pg: Pool,
  sessionId: string
): Promise<{ names: string[]; source: "metadata" | "redis" | "none" }> {
  const { rows } = await pg.query<{ metadata: Record<string, unknown> | null }>(
    `SELECT metadata FROM sessions WHERE id = $1`,
    [sessionId]
  );
  const meta = rows[0]?.metadata ?? {};
  const expected = meta && typeof meta === "object" ? (meta as Record<string, unknown>)["expectedSpeakers"] : undefined;
  if (Array.isArray(expected)) {
    const names = expected.map(String).map((s) => s.trim()).filter(Boolean);
    if (names.length) return { names, source: "metadata" };
  }

  const raw = await redis.get(`session:${sessionId}:roster`).catch(() => null);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const names = parsed.map(String).map((s) => s.trim()).filter(Boolean);
        if (names.length) return { names, source: "redis" };
      }
    } catch {
      // fall through
    }
  }
  return { names: [], source: "none" };
}

async function assembleSessionWav(
  s3: S3Client,
  bucket: string,
  sessionId: string,
  outKey: string
): Promise<boolean> {
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const prefix = `sessions/${sessionId}/chunks/`;
  const list = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix })
  );
  const keys = (list.Contents ?? [])
    .map((o) => o.Key!)
    .filter((k) => k.endsWith(".wav"))
    .sort();
  if (!keys.length) {
    log.warn({ sessionId }, "no audio chunks found");
    return false;
  }

  // Download chunks to a temp dir and concat via ffmpeg's concat demuxer.
  // ffmpeg handles WAV header/LIST-chunk edge cases that naive byte-splicing
  // doesn't — critical because pyannote silently truncates a broken WAV.
  const workDir = await mkdtemp(join(tmpdir(), `renate-finalize-${sessionId}-`));
  try {
    const localPaths: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const buf = await getAudioChunk(s3, bucket, keys[i]);
      const p = join(workDir, `chunk_${String(i).padStart(5, "0")}.wav`);
      await writeFile(p, buf);
      localPaths.push(p);
    }

    const listFile = join(workDir, "concat.txt");
    await writeFile(
      listFile,
      localPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n"
    );
    const outFile = join(workDir, "full.wav");

    await runFfmpegConcat(listFile, outFile);

    const concatenated = await readFile(outFile);
    await putAudioChunk(s3, bucket, outKey, concatenated, "audio/wav");
    log.info({ sessionId, bytes: concatenated.length, chunks: keys.length }, "wav concat ok");
    return true;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfmpegConcat(listFile: string, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listFile,
      "-c", "copy",
      outFile,
    ];
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    p.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 500)}`));
    });
    p.once("error", reject);
  });
}

interface DiarizeHints {
  numSpeakers?: number;
  minSpeakers?: number;
  maxSpeakers?: number;
}

async function callDiarize(
  diarizeUrl: string,
  sessionId: string,
  s3Key: string,
  hints: DiarizeHints = {}
): Promise<PyannoteTurn[]> {
  // pyannote inference on CPU can run 2-3x real-time. For a 5-minute call
  // that's ~90-150s; the undici default headersTimeout (5 min) is tight.
  // Bump to 30 min for safety.
  const { Agent, fetch: undiciFetch } = await import("undici");
  const dispatcher = new Agent({
    headersTimeout: 30 * 60 * 1000,
    bodyTimeout: 30 * 60 * 1000,
  });

  const body: Record<string, unknown> = { session_id: sessionId, s3_key: s3Key };
  if (hints.numSpeakers !== undefined) body.num_speakers = hints.numSpeakers;
  if (hints.minSpeakers !== undefined) body.min_speakers = hints.minSpeakers;
  if (hints.maxSpeakers !== undefined) body.max_speakers = hints.maxSpeakers;

  const res = await undiciFetch(`${diarizeUrl.replace(/\/$/, "")}/diarize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    dispatcher,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`diarize ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    turns: Array<{ start_ts: number; end_ts: number; cluster: string }>;
  };
  return json.turns.map((t) => ({
    startTs: t.start_ts,
    endTs: t.end_ts,
    cluster: t.cluster,
  }));
}

async function loadSegmentsAndWords(
  pg: Pool,
  sessionId: string
): Promise<{
  segments: Array<{ startTs: number; endTs: number; text: string }>;
  words: Word[];
}> {
  const { rows } = await pg.query<{
    start_ts: string;
    end_ts: string;
    raw_text: string;
    words: unknown;
  }>(
    `SELECT start_ts, end_ts, raw_text, words
       FROM transcript_segments
      WHERE session_id = $1
      ORDER BY start_ts ASC`,
    [sessionId]
  );
  const segments = rows.map((r) => ({
    startTs: Number(r.start_ts),
    endTs: Number(r.end_ts),
    text: r.raw_text,
  }));
  const words: Word[] = [];
  for (const r of rows) {
    if (!Array.isArray(r.words)) continue;
    for (const w of r.words as Array<{ startTs?: number; endTs?: number; text?: string }>) {
      if (typeof w?.startTs !== "number" || typeof w?.endTs !== "number" || !w.text) continue;
      words.push({ startTs: w.startTs, endTs: w.endTs, text: String(w.text) });
    }
  }
  return { segments, words };
}

function pickBestTurnOverlap(
  segStart: number,
  segEnd: number,
  turns: PyannoteTurn[]
): PyannoteTurn | null {
  let best: { turn: PyannoteTurn; o: number } | null = null;
  for (const t of turns) {
    const s = Math.max(segStart, t.startTs);
    const e = Math.min(segEnd, t.endTs);
    const o = Math.max(0, e - s);
    if (o > 0 && (!best || o > best.o)) best = { turn: t, o };
  }
  return best?.turn ?? null;
}

function pickOverlap(
  segStart: number,
  segEnd: number,
  captions: DomCaptionRecord[]
): DomCaptionRecord | null {
  let best: { c: DomCaptionRecord; o: number } | null = null;
  for (const c of captions) {
    const s = Math.max(segStart, c.startTs / 1000);
    const e = Math.min(segEnd, c.endTs / 1000);
    const o = Math.max(0, e - s);
    if (o > 0 && (!best || o > best.o)) best = { c, o };
  }
  return best?.c ?? null;
}


