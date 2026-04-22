import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
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
  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-f", "pulse",
    "-i", opts.pulseSource,
    "-ac", "1",
    "-ar", String(opts.sampleRate),
    "-c:a", "pcm_s16le",
    "-f", "segment",
    "-segment_time", String(opts.chunkSeconds),
    "-reset_timestamps", "1",
    outputPattern,
  ];

  log.info({ args: args.join(" ") }, "spawning ffmpeg");
  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  ff.stdout.on("data", (d) => log.debug({ out: d.toString().trim() }, "ffmpeg stdout"));
  ff.stderr.on("data", (d) => {
    const s = d.toString().trim();
    if (s) log.debug({ err: s }, "ffmpeg stderr");
  });

  let producedCount = 0;
  let lastSeenChunk = -1;
  let stopping = false;

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
        await handleChunk(opts, f, idx).catch((err) => {
          log.error({ err, file: f }, "chunk handling failed");
        });
        producedCount++;
      }
    } catch (err) {
      log.error({ err }, "poll error");
    }
  }, 1000);

  const exited = new Promise<void>((resolve) => {
    ff.once("exit", (code, signal) => {
      log.info({ code, signal }, "ffmpeg exited");
      resolve();
    });
  });

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(poller);

    log.info("stopping ffmpeg (SIGINT for graceful flush)");
    ff.kill("SIGINT");

    // Give ffmpeg a moment to finalize the last WAV header.
    await Promise.race([
      exited,
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
): Promise<void> {
  const path = join(opts.chunkDir, fileName);
  const s3Key = `sessions/${opts.sessionId}/chunks/${fileName}`;

  const body = await readFile(path);
  const size = body.length;
  if (size < 100) {
    log.warn({ fileName, size }, "chunk too small; skipping");
    await unlink(path).catch(() => {});
    return;
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
