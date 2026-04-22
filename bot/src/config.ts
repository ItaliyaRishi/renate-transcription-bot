import { z } from "zod";

const schema = z.object({
  SESSION_ID: z.string().min(1).optional(),
  MEET_URL: z.string().url().optional(),
  AUTH_PROFILE: z.string().default("/auth/auth.json"),
  REDIS_URL: z.string().default("redis://redis:6379"),
  S3_ENDPOINT: z.string().default("http://minio:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().default("minioadmin"),
  S3_SECRET_KEY: z.string().default("minioadmin"),
  S3_BUCKET_AUDIO: z.string().default("renate-audio"),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  AUDIO_CHUNK_SECONDS: z.coerce.number().default(28),
  AUDIO_SAMPLE_RATE: z.coerce.number().default(16_000),
  AUDIO_CHUNK_DIR: z.string().default("/chunks"),
  PULSE_SOURCE: z.string().default("meet_sink.monitor"),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().default(10_000),
  HEARTBEAT_TTL_SECONDS: z.coerce.number().default(30),
  CALL_HARD_TIMEOUT_MS: z.coerce.number().default(120 * 60 * 1000),
  DISPLAY_NAME: z.string().default("Renate"),
  LOG_LEVEL: z.string().default("info"),
});

export type BotConfig = z.infer<typeof schema>;

export function loadConfig(): BotConfig {
  return schema.parse(process.env);
}
