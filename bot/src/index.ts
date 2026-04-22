import { Queue } from "bullmq";
import { S3Client } from "@aws-sdk/client-s3";
import pino from "pino";
import { loadConfig } from "./config.js";
import { joinMeetWithRetry, leaveMeet } from "./join.js";
import type { JoinResult } from "./join.js";
import { startAudioCapture } from "./audio.js";
import type { AudioCaptureHandle } from "./audio.js";
import { attachCaptionObserver } from "./captions.js";
import type { CaptionObserverHandle } from "./captions.js";
import { scrapeRoster } from "./peoplePanel.js";
import { dumpMeetDom } from "./debug.js";
import { waitForCallEnd } from "./endDetect.js";
import { selectors } from "./selectors.js";
import { createRedis, pushCaption, setRoster, startHeartbeat } from "./state.js";

const log = pino({ name: "bot", level: process.env.LOG_LEVEL ?? "info" });

async function main() {
  const cfg = loadConfig();

  if (!cfg.SESSION_ID || !cfg.MEET_URL) {
    log.error(
      { sessionId: cfg.SESSION_ID, meetUrl: cfg.MEET_URL },
      "SESSION_ID and MEET_URL are required"
    );
    process.exit(2);
  }

  log.info({ sessionId: cfg.SESSION_ID, meetUrl: cfg.MEET_URL }, "bot: boot");

  const redis = createRedis(cfg.REDIS_URL);
  const transcribeQueue = new Queue("transcribe-chunk", { connection: redis });

  const s3 = new S3Client({
    endpoint: cfg.S3_ENDPOINT,
    region: cfg.S3_REGION,
    credentials: { accessKeyId: cfg.S3_ACCESS_KEY, secretAccessKey: cfg.S3_SECRET_KEY },
    forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
  });

  const heartbeat = startHeartbeat(redis, cfg.SESSION_ID, {
    intervalMs: cfg.HEARTBEAT_INTERVAL_MS,
    ttlSeconds: cfg.HEARTBEAT_TTL_SECONDS,
  });

  let joined: JoinResult | null = null;
  let audio: AudioCaptureHandle | null = null;
  let captions: CaptionObserverHandle | null = null;

  // Read Meet's participant count via the "people" button's aria-label.
  // Returns the total participant count (including the bot) or null if the
  // button isn't reachable. Worker subtracts 1 for the bot itself.
  async function readParticipantCount(): Promise<number | null> {
    if (!joined) return null;
    try {
      const btn = joined.page.locator(selectors.participantCountButton).first();
      if (!(await btn.isVisible().catch(() => false))) return null;
      const aria = (await btn.getAttribute("aria-label").catch(() => "")) ?? "";
      const m = aria.match(/(\d+)/);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }

  let finalizeEnqueued = false;
  const enqueueFinalize = async (endSignal: string) => {
    if (finalizeEnqueued) return;
    finalizeEnqueued = true;
    const participantCount = await readParticipantCount();
    try {
      const { Queue } = await import("bullmq");
      const q = new Queue("finalize", { connection: redis });
      await q.add(
        "finalize",
        { sessionId: cfg.SESSION_ID, endSignal, participantCount },
        {
          jobId: `${cfg.SESSION_ID}-finalize`,
          removeOnComplete: 1000,
          removeOnFail: 5000,
          attempts: 2,
          backoff: { type: "exponential", delay: 5_000 },
        }
      );
      await q.close();
      log.info({ endSignal, participantCount }, "finalize enqueued");
    } catch (err) {
      log.error({ err }, "finalize enqueue failed");
    }
  };

  const shutdown = async (sig: string, code = 0) => {
    log.info({ sig }, "bot: shutting down");
    // If we got a signal while in a call, still enqueue finalize so audio
    // chunks we already pushed don't orphan.
    if (joined && !finalizeEnqueued) {
      await enqueueFinalize(`shutdown:${sig}`);
    }
    heartbeat.stop();
    if (captions) await captions.stop().catch((err) => log.error({ err }, "captions stop"));
    if (audio) await audio.stop().catch((err) => log.error({ err }, "audio stop"));
    if (joined) await leaveMeet(joined).catch((err) => log.error({ err }, "leave"));
    await transcribeQueue.close().catch(() => {});
    await redis.quit().catch(() => {});
    process.exit(code);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  try {
    joined = await joinMeetWithRetry({
      meetUrl: cfg.MEET_URL,
      authProfile: cfg.AUTH_PROFILE,
      displayName: cfg.DISPLAY_NAME,
    });
    log.info({ joinedAt: joined.joinedAt }, "bot: joined");

    audio = await startAudioCapture({
      sessionId: cfg.SESSION_ID,
      chunkDir: cfg.AUDIO_CHUNK_DIR,
      chunkSeconds: cfg.AUDIO_CHUNK_SECONDS,
      sampleRate: cfg.AUDIO_SAMPLE_RATE,
      pulseSource: cfg.PULSE_SOURCE,
      s3: { client: s3, bucket: cfg.S3_BUCKET_AUDIO },
      transcribeQueue,
    });

    captions = await attachCaptionObserver(joined.page, (c) =>
      pushCaption(redis, cfg.SESSION_ID!, c).catch((err) =>
        log.error({ err }, "pushCaption failed")
      )
    );

    // t+8s: scrape the People panel for the human roster, and dump a DOM
    // diagnostic in parallel. Both run once, tolerate failure, and never
    // block call watching. Output at /chunks/debug_dom.json — `docker cp`
    // it out of the bot container after the call to inspect.
    setTimeout(() => {
      void scrapeRoster(joined!.page, cfg.DISPLAY_NAME)
        .then((names) => {
          if (names.length === 0) {
            log.warn("roster scrape returned no names");
            return;
          }
          log.info({ names }, "roster scraped");
          return setRoster(redis, cfg.SESSION_ID!, names);
        })
        .catch((err) => log.error({ err }, "roster scrape failed"));

      void dumpMeetDom(joined!.page).catch((err) =>
        log.error({ err }, "debug dump failed")
      );
    }, 8_000);

    log.info("bot: audio + captions live; watching for call end");

    const endSignal = await waitForCallEnd(joined.page, {
      hardTimeoutMs: cfg.CALL_HARD_TIMEOUT_MS,
    });
    log.info({ endSignal }, "bot: call ended");
    await enqueueFinalize(endSignal);
    await shutdown("END_SIGNAL");
  } catch (err) {
    log.error({ err }, "bot: fatal during boot");
    await shutdown("ERROR", 1);
  }
}

main().catch((err) => {
  log.error({ err }, "bot: fatal");
  process.exit(1);
});
