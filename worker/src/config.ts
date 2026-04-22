import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string(),
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
  SARVAM_API_KEY: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_SUMMARY_MODEL: z.string().default("gpt-4.1-mini"),
  DIARIZE_URL: z.string().default("http://diarize:8000"),
  BOT_IMAGE: z.string().default("renate-bot:latest"),
  BOT_NETWORK: z.string().default("renate-transcription-bot_renate"),
  AUTH_HOST_PATH: z.string().default("/host-auth"),
  CALL_HARD_TIMEOUT_MIN: z.coerce.number().default(120),
  LOG_LEVEL: z.string().default("info"),
});

export type WorkerConfig = z.infer<typeof schema>;

export function loadConfig(): WorkerConfig {
  return schema.parse(process.env);
}
