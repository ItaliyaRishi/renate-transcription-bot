import OpenAI from "openai";
import pino from "pino";

const log = pino({ name: "worker.summarize", level: process.env.LOG_LEVEL ?? "info" });

export interface SummarizeInput {
  sessionId: string;
  transcriptMarkdown: string;
  apiKey: string;
  model?: string;
}

const SYSTEM_PROMPT = `You write crisp meeting summaries. Given a transcript of a
Google Meet call, produce Markdown with these sections:

## Summary
One paragraph, 3–5 sentences.

## Key Points
Bulleted; concrete decisions, numbers, names.

## Action Items
Bulleted, each as "- [ ] <owner>: <task>" where owner is the speaker name.
Skip the section if none.

Only use information present in the transcript. Be concise. Do not invent.
`;

export async function summarize(input: SummarizeInput): Promise<string> {
  if (!input.apiKey) throw new Error("OPENAI_API_KEY missing");
  const client = new OpenAI({ apiKey: input.apiKey });

  const model = input.model ?? "gpt-4.1-mini";
  log.info({ sessionId: input.sessionId, model }, "summarize");

  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: input.transcriptMarkdown },
    ],
    temperature: 0.2,
  });

  const md = res.choices[0]?.message?.content?.trim() ?? "";
  if (!md) throw new Error("empty summary from openai");
  return md;
}
