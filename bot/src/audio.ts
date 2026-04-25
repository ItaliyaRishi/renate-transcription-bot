import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readdir, readFile, unlink, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Queue } from "bullmq";
import { PutObjectCommand, S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import pino from "pino";

const log = pino({ name: "bot.audio", level: process.env.LOG_LEVEL ?? "info" });

export interface StartAudioCaptureOptions {
  sessionId: string;
  chunkDir: string;
  chunkSeconds: number;
  sampleRate: number;
  pulseSource: string;
  s3: {
    client: S3Client;
    bucket: string;
  };
  transcribeQueue: Queue;
}

export interface AudioCaptureHandle {
  stop(): Promise<void>;
  chunksProduced(): number;
}

export async function startAudioCapture(
  opts: StartAudioCaptureOptions
): Promise<AudioCaptureHandle> {
  await mkdir(opts.chunkDir, { recursive: true });
  await ensureBucket(opts.s3.client, opts.s3.bucket);

  const outputPattern = join(opts.chunkDir, "chunk_%05d.wav");

  let producedCount = 0;
  let lastSeenChunk = -1;
  let stopping = false;
  // Sizes of the last two uploaded chunks. Used by the watchdog to detect a
  // stalled PulseAudio monitor: when Chromium backgrounds the renderer the
  // null-sink stops pushing frames and segments shrink to near-empty WAV
  // headers (< 50 KB). See session fc7b1ae1 post-mortem.
  const recentSizes: number[] = [];

  function buildFfmpegArgs(startNumber: number): string[] {
    return [
      "-hide_banner",
      "-loglevel", "warning",
      // Wall-clock timestamps survive PulseAudio monitor hiccups — without
      // this, a starved input can freeze the segment muxer's clock.
      "-use_wallclock_as_timestamps", "1",
      "-fflags", "+nobuffer",
      "-f", "pulse",
      "-i", opts.pulseSource,
      "-ac", "1",
      "-ar", String(opts.sampleRate),
      "-c:a", "pcm_s16le",
      "-f", "segment",
      "-segment_time", String(opts.chunkSeconds),
      "-segment_start_number", String(startNumber),
      "-reset_timestamps", "1",
      outputPattern,
    ];
  }

  function spawnFfmpeg(startNumber: number): ChildProcess {
    const args = buildFfmpegArgs(startNumber);
    log.info({ args: args.join(" "), startNumber }, "spawning ffmpeg");
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout?.on("data", (d) => log.debug({ out: d.toString().trim() }, "ffmpeg stdout"));
    proc.stderr?.on("data", (d) => {
      const s = d.toString().trim();
      if (s) log.debug({ err: s }, "ffmpeg stderr");
    });
    return proc;
  }

  let ff = spawnFfmpeg(0);

  // Poll the chunk dir every second: ffmpeg's segment muxer writes file N
  // atomically (it appears in readdir once ready), so the highest-indexed
  // file whose size is stable is the newest complete chunk.
  const poller = setInterval(async () => {
    if (stopping) return;
    try {
      const files = (await readdir(opts.chunkDir))
        .filter((f) => f.startsWith("chunk_") && f.endsWith(".wav"))
        .sort();

      for (const f of files) {
        const idx = parseInt(f.slice(6, 11), 10);
        if (isNaN(idx) || idx <= lastSeenChunk) continue;

        // A chunk is "complete" once ffmpeg has moved on to the next one.
        // The current file (highest idx) is still being written; skip it.
        const isCurrent = idx === Math.max(...files.map((x) => parseInt(x.slice(6, 11), 10)));
        if (isCurrent) continue;

        lastSeenChunk = idx;
        const size = await handleChunk(opts, f, idx).catch((err) => {
          log.error({ err, file: f }, "chunk handling failed");
          return 0;
        });
        recentSizes.push(size);
        if (recentSizes.length > 2) recentSizes.shift();
        producedCount++;
      }
    } catch (err) {
      log.error({ err }, "poll error");
    }
  }, 1000);

  // Watchdog: if the last two uploaded chunks were both near-empty the
  // PulseAudio monitor is starved. Kill ffmpeg and respawn from the next
  // segment number — the poller will pick up from there transparently.
  const watchdog = setInterval(() => {
    if (stopping) return;
    if (recentSizes.length < 2) return;
    if (recentSizes[0] >= 50_000 || recentSizes[1] >= 50_000) return;
    log.warn({ recentSizes, lastSeenChunk }, "watchdog: near-empty chunks, restarting ffmpeg");
    try { ff.kill("SIGKILL"); } catch { /* proc may already be gone */ }
    recentSizes.length = 0;
    ff = spawnFfmpeg(lastSeenChunk + 1);
  }, 60_000);

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(poller);
    clearInterval(watchdog);

    log.info("stopping ffmpeg (SIGINT for graceful flush)");
    ff.kill("SIGINT");

    // Give ffmpeg a moment to finalize the last WAV header.
    await Promise.race([
      new Promise<void>((resolve) => ff.once("exit", () => resolve())),
      new Promise<void>((r) => setTimeout(r, 5_000)),
    ]);
    if (!ff.killed) ff.kill("SIGKILL");

    // Flush any remaining chunks.
    await flushRemaining(opts, lastSeenChunk);
    log.info({ producedCount }, "audio capture stopped");
  };

  return {
    stop,
    chunksProduced: () => producedCount,
  };
}

async function handleChunk(
  opts: StartAudioCaptureOptions,
  fileName: string,
  idx: number
): Promise<number> {
  const path = join(opts.chunkDir, fileName);
  const s3Key = `sessions/${opts.sessionId}/chunks/${fileName}`;

  const body = await readFile(path);
  const size = body.length;
  if (size < 100) {
    log.warn({ fileName, size }, "chunk too small; skipping");
    await unlink(path).catch(() => {});
    return size;
  }

  await opts.s3.client.send(
    new PutObjectCommand({
      Bucket: opts.s3.bucket,
      Key: s3Key,
      Body: body,
      ContentType: "audio/wav",
    })
  );

  await opts.transcribeQueue.add(
    "transcribe-chunk",
    {
      sessionId: opts.sessionId,
      chunkIdx: idx,
      s3Key,
      sampleRate: opts.sampleRate,
    },
    {
      jobId: `${opts.sessionId}-chunk-${idx}`,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
    }
  );

  await unlink(path).catch(() => {});
  log.info({ idx, s3Key, size }, "chunk uploaded + enqueued");
  return size;
}

async function flushRemaining(
  opts: StartAudioCaptureOptions,
  alreadyHandled: number
): Promise<void> {
  const files = (await readdir(opts.chunkDir).catch(() => []))
    .filter((f) => f.startsWith("chunk_") && f.endsWith(".wav"))
    .sort();

  for (const f of files) {
    const idx = parseInt(f.slice(6, 11), 10);
    if (isNaN(idx) || idx <= alreadyHandled) continue;

    // Don't upload a zero-byte tail left behind by SIGINT.
    const s = await stat(join(opts.chunkDir, f)).catch(() => null);
    if (!s || s.size < 100) {
      await unlink(join(opts.chunkDir, f)).catch(() => {});
      continue;
    }
    await handleChunk(opts, f, idx).catch((err) =>
      log.error({ err, f }, "flush chunk failed")
    );
  }
}

async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    log.info({ bucket }, "bucket created");
  } catch (err) {
    const code = (err as { name?: string; Code?: string }).name
      ?? (err as { Code?: string }).Code;
    if (code === "BucketAlreadyOwnedByYou" || code === "BucketAlreadyExists") return;
    // MinIO returns 409 without an AWS-standard code; swallow it and trust
    // the next PutObject to reveal a real problem.
    log.warn({ err }, "createBucket returned non-fatal error; continuing");
  }
}
