import Fastify from "fastify";
import { Queue } from "bullmq";
import { Redis as IORedis } from "ioredis";
import { Pool } from "pg";
import { z } from "zod";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const app = Fastify({ logger: { level: cfg.LOG_LEVEL, name: "api" } });

const redis = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
const spawnQueue = new Queue("spawn-bot", { connection: redis });
const pg = new Pool({ connectionString: cfg.DATABASE_URL });

app.get("/healthz", async () => ({ ok: true }));

const createSessionBody = z.object({
  meetUrl: z.string().url(),
  botAccountId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

app.post("/sessions", async (req, reply) => {
  const parsed = createSessionBody.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const { meetUrl, botAccountId, metadata } = parsed.data;
  const { rows } = await pg.query<{ id: string }>(
    `INSERT INTO sessions (meet_url, bot_account_id, status, metadata)
     VALUES ($1, $2, 'queued', $3::jsonb)
     RETURNING id`,
    [meetUrl, botAccountId ?? null, JSON.stringify(metadata ?? {})]
  );
  const sessionId = rows[0].id;

  await spawnQueue.add(
    "spawn-bot",
    { sessionId, meetUrl, botAccountId },
    {
      jobId: `spawn-${sessionId}`,
      removeOnComplete: 500,
      removeOnFail: 2000,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
    }
  );

  return reply.code(201).send({ sessionId, status: "queued" });
});

app.get<{ Params: { id: string } }>("/sessions/:id", async (req, reply) => {
  const { rows } = await pg.query(
    `SELECT id, meet_url, status, started_at, ended_at, duration_s, summary_md
       FROM sessions WHERE id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return reply.code(404).send({ error: "not_found" });
  return rows[0];
});

async function start() {
  try {
    await app.listen({ host: "0.0.0.0", port: cfg.API_PORT });
    app.log.info({ port: cfg.API_PORT }, "api: listening");
  } catch (err) {
    app.log.error({ err }, "api: failed to start");
    process.exit(1);
  }
}

const shutdown = async (sig: string) => {
  app.log.info({ sig }, "api: shutdown");
  await app.close();
  await spawnQueue.close();
  await redis.quit();
  await pg.end();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

start();
