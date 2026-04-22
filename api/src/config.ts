import { z } from "zod";

const schema = z.object({
  API_PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://redis:6379"),
  LOG_LEVEL: z.string().default("info"),
});

export type ApiConfig = z.infer<typeof schema>;

export function loadConfig(): ApiConfig {
  return schema.parse(process.env);
}
