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
import { startActiveSpeakerPoller } from "./activeSpeaker.js";
import type { ActiveSpeakerHandle } from "./activeSpeaker.js";
import { scrapeRoster } from "./peoplePanel.js";
import { dumpMeetDom } from "./debug.js";
import { waitForCallEnd } from "./endDetect.js";
import { selectors } from "./selectors.js";
import { createRedis, pushActiveSpeaker, pushCaption, setRoster, startHeartbeat } from "./state.js";

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
  let activeSpeaker: ActiveSpeakerHandle | null = null;

  // Read Meet's participant count via the "people" button's aria-label.
  // Returns the total participant count (including the bot) or null if the
  // button isn't reachable. Worker subtracts 1 for the bot itself.
  async function readParticipantCount(): Promise<number | null> {
    if (!joined) return null;
    const handles = await joined.page
      .locator(selectors.peoplePanelButton)
      .elementHandles()
      .catch(() => []);
    try {
      for (const h of handles) {
        if (!(await h.isVisible().catch(() => false))) continue;
        const aria = ((await h.getAttribute("aria-label").catch(() => null)) ?? "").trim();
        const m = aria.match(/(\d+)/);
        if (m) return Number(m[1]);
        const txt = ((await h.textContent().catch(() => null)) ?? "").trim();
        const tm = txt.match(/(\d+)/);
        if (tm) return Number(tm[1]);
      }
      return null;
    } finally {
      for (const h of handles) await h.dispose().catch(() => {});
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

  // Wait for every transcribe-chunk job we've pushed to reach a terminal
  // state (completed or failed). Without this, the tail chunks race against
  // finalize and get dropped from the transcript.
  const drainTranscribeQueue = async (deadlineMs: number): Promise<void> => {
    const deadline = Date.now() + deadlineMs;
    const sessionPrefix = `${cfg.SESSION_ID}-chunk-`;
    while (Date.now() < deadline) {
      const [waiting, active, delayed] = await Promise.all([
        transcribeQueue.getWaiting(0, -1).catch(() => []),
        transcribeQueue.getActive(0, -1).catch(() => []),
        transcribeQueue.getDelayed(0, -1).catch(() => []),
      ]);
      const pending = [...waiting, ...active, ...delayed].filter((j) =>
        typeof j.id === "string" && j.id.startsWith(sessionPrefix)
      );
      if (pending.length === 0) {
        log.info("transcribe queue drained for session");
        return;
      }
      log.info({ pending: pending.length }, "waiting for transcribe-chunk jobs");
      await new Promise((r) => setTimeout(r, 1_000));
    }
    log.warn({ deadlineMs }, "transcribe-queue drain deadline hit; continuing anyway");
  };

  const shutdown = async (sig: string, code = 0, endSignal?: string) => {
    log.info({ sig, endSignal }, "bot: shutting down");
    heartbeat.stop();
    const rosterTimer = (globalThis as { __renateRosterTimer?: ReturnType<typeof setInterval> })
      .__renateRosterTimer;
    if (rosterTimer) clearInterval(rosterTimer);
    // Flush ffmpeg + upload tail chunks BEFORE touching finalize so no audio
    // gets orphaned. captions + active-speaker observers stop in parallel —
    // they're cheap.
    const captionsStop = captions
      ? captions.stop().catch((err) => log.error({ err }, "captions stop"))
      : Promise.resolve();
    const activeSpeakerStop = activeSpeaker
      ? activeSpeaker.stop().catch((err) => log.error({ err }, "active-speaker stop"))
      : Promise.resolve();
    if (audio) await audio.stop().catch((err) => log.error({ err }, "audio stop"));
    await captionsStop;
    await activeSpeakerStop;
    // Wait for tail transcribe-chunk jobs to finish so finalize sees
    // transcript_segments for every chunk we uploaded.
    if (joined) await drainTranscribeQueue(45_000);
    // Now safe to finalize.
    if (joined && !finalizeEnqueued) {
      await enqueueFinalize(endSignal ?? `shutdown:${sig}`);
    }
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

    activeSpeaker = await startActiveSpeakerPoller(joined.page, (ev) =>
      pushActiveSpeaker(redis, cfg.SESSION_ID!, ev).catch((err) =>
        log.error({ err }, "pushActiveSpeaker failed")
      )
    );

    // Periodic roster scrape. If the bot joined before any humans, the
    // People panel is empty at t+8s. Re-scrape every 30s for the duration
    // of the call; persist whenever we get a non-empty list. The roster
    // grows over the call as more people join — finalize uses the latest
    // value. First attempt runs at t+8s.
    let rosterPersisted = false;
    const rosterTimer = setInterval(() => {
      void scrapeRoster(joined!.page, cfg.DISPLAY_NAME)
        .then((names) => {
          if (names.length === 0) {
            if (!rosterPersisted) log.warn("roster scrape returned no names; will retry");
            return;
          }
          log.info({ names, persistedBefore: rosterPersisted }, "roster scraped");
          rosterPersisted = true;
          return setRoster(redis, cfg.SESSION_ID!, names);
        })
        .catch((err) => log.error({ err }, "roster scrape failed"));
    }, 30_000);
    (globalThis as { __renateRosterTimer?: ReturnType<typeof setInterval> })
      .__renateRosterTimer = rosterTimer;

    setTimeout(() => {
      void scrapeRoster(joined!.page, cfg.DISPLAY_NAME)
        .then((names) => {
          if (names.length === 0) {
            log.warn("roster scrape returned no names; will retry");
            return;
          }
          log.info({ names }, "roster scraped");
          rosterPersisted = true;
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
    await shutdown("END_SIGNAL", 0, endSignal);
  } catch (err) {
    log.error({ err }, "bot: fatal during boot");
    await shutdown("ERROR", 1);
  }
}

main().catch((err) => {
  log.error({ err }, "bot: fatal");
  process.exit(1);
});
