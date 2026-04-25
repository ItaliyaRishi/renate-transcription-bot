import { Queue, Worker } from "bullmq";
import { Redis as IORedis } from "ioredis";
import { Pool } from "pg";
import pino from "pino";
import { loadConfig } from "./config.js";
import { transcribeChunk } from "./sarvam.js";
import { insertTranscriptSegments } from "./persist.js";
import { createS3Client, ensureBucket, getAudioChunk } from "./s3.js";
import { finalizeSession } from "./finalize.js";
import { spawnBot } from "./spawnBot.js";

const log = pino({ name: "worker", level: process.env.LOG_LEVEL ?? "info" });

async function main() {
  const cfg = loadConfig();
  log.info("worker: boot");

  const connection = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  const pg = new Pool({ connectionString: cfg.DATABASE_URL });
  const s3 = createS3Client({
    endpoint: cfg.S3_ENDPOINT,
    region: cfg.S3_REGION,
    accessKeyId: cfg.S3_ACCESS_KEY,
    secretAccessKey: cfg.S3_SECRET_KEY,
    forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
  });
  await ensureBucket(s3, cfg.S3_BUCKET_AUDIO);

  const finalizeQueue = new Queue("finalize", { connection });

  const workers = [
    new Worker(
      "spawn-bot",
      async (job) => {
        const { sessionId, meetUrl, botAccountId } = job.data as {
          sessionId: string;
          meetUrl: string;
          botAccountId?: string;
        };
        const jobLog = log.child({ jobId: job.id, sessionId, queue: "spawn-bot" });
        jobLog.info("start");
        await spawnBot({
          sessionId,
          meetUrl,
          botAccountId,
          image: cfg.BOT_IMAGE,
          network: cfg.BOT_NETWORK,
          authHostPath: cfg.AUTH_HOST_PATH,
          pg,
          env: {
            REDIS_URL: cfg.REDIS_URL,
            S3_ENDPOINT: cfg.S3_ENDPOINT,
            S3_REGION: cfg.S3_REGION,
            S3_ACCESS_KEY: cfg.S3_ACCESS_KEY,
            S3_SECRET_KEY: cfg.S3_SECRET_KEY,
            S3_BUCKET_AUDIO: cfg.S3_BUCKET_AUDIO,
            S3_FORCE_PATH_STYLE: String(cfg.S3_FORCE_PATH_STYLE),
            LOG_LEVEL: cfg.LOG_LEVEL,
          },
        });
      },
      { connection, concurrency: 4 }
    ),
    new Worker(
      "transcribe-chunk",
      async (job) => {
        const { sessionId, chunkIdx, s3Key } = job.data as {
          sessionId: string;
          chunkIdx: number;
          s3Key: string;
        };
        const jobLog = log.child({
          jobId: job.id,
          sessionId,
          chunkIdx,
          queue: "transcribe-chunk",
        });
        jobLog.info("start");
        const wav = await getAudioChunk(s3, cfg.S3_BUCKET_AUDIO, s3Key);
        const segments = await transcribeChunk({
          sessionId,
          chunkIdx,
          s3Key,
          wavBuffer: wav,
          apiKey: cfg.SARVAM_API_KEY,
          model: cfg.SARVAM_MODEL,
          language: cfg.SARVAM_LANGUAGE_CODE,
          mode: cfg.SARVAM_MODE,
        });
        await insertTranscriptSegments(pg, sessionId, chunkIdx, segments);
        jobLog.info(
          { segments: segments.length, model: cfg.SARVAM_MODEL, mode: cfg.SARVAM_MODE },
          "done"
        );
      },
      { connection, concurrency: 3 }
    ),
    new Worker(
      "finalize",
      async (job) => {
        const { sessionId, participantCount } = job.data as {
          sessionId: string;
          participantCount?: number | null;
        };
        const jobLog = log.child({ jobId: job.id, sessionId, queue: "finalize" });
        jobLog.info({ participantCount }, "start");
        await finalizeSession({
          sessionId,
          participantCount,
          pg,
          redis: connection,
          s3,
          bucket: cfg.S3_BUCKET_AUDIO,
          diarizeUrl: cfg.DIARIZE_URL,
          openaiApiKey: cfg.OPENAI_API_KEY,
        });
      },
      { connection, concurrency: 1 }
    ),
  ];

  for (const w of workers) {
    w.on("ready", () => log.info({ queue: w.name }, "worker: ready"));
    w.on("failed", (job, err) =>
      log.error({ queue: w.name, jobId: job?.id, err: err?.message }, "job failed")
    );
    w.on("error", (err) => log.error({ queue: w.name, err }, "worker: error"));
  }

  const shutdown = async (sig: string) => {
    log.info({ sig }, "worker: shutdown");
    await Promise.all(workers.map((w) => w.close()));
    await finalizeQueue.close();
    await connection.quit();
    await pg.end();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error({ err }, "worker: fatal");
  process.exit(1);
});
