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
  // Sarvam model. `saaras:v3` is the current flagship — supports more
  // languages + a `mode` param (codemix, translate, verbatim, ...).
  // Valid alternatives: saarika:v2.5, saaras:v3-realtime, saarika:flash.
  SARVAM_MODEL: z.string().default("saaras:v3"),
  // `unknown` auto-detects whatever supported language is spoken; mixed
  // with mode=translate below this gives us English-regardless-of-input.
  SARVAM_LANGUAGE_CODE: z.string().default("unknown"),
  // Sarvam `mode` (Saaras family only). `translate` → English output for
  // any supported input language. Keeps transcript + summary mono-lingual
  // regardless of what the participants speak.
  SARVAM_MODE: z.string().default("translate"),
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
