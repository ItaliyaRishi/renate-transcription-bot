import { Buffer } from "node:buffer";
import pino from "pino";

const log = pino({ name: "worker.sarvam", level: process.env.LOG_LEVEL ?? "info" });

const SARVAM_ENDPOINT = "https://api.sarvam.ai/speech-to-text";

export interface TranscribeChunkInput {
  sessionId: string;
  chunkIdx: number;
  s3Key: string;
  wavBuffer: Buffer;
  apiKey: string;
  language?: string;
  model?: string;
  /** Only used for `saaras:*` models: transcribe | translate | codemix | verbatim | translit. */
  mode?: string;
}

export interface TranscribedSegment {
  startTs: number;
  endTs: number;
  rawText: string;
  confidence: number | null;
  sarvamRequestId: string;
}

export async function transcribeChunk(
  input: TranscribeChunkInput
): Promise<TranscribedSegment[]> {
  if (!input.apiKey) throw new Error("SARVAM_API_KEY missing");

  const form = new FormData();
  form.append(
    "file",
    new Blob([input.wavBuffer], { type: "audio/wav" }),
    `chunk_${String(input.chunkIdx).padStart(5, "0")}.wav`
  );
  const model = input.model ?? "saaras:v2.5";
  form.append("model", model);
  form.append("language_code", input.language ?? "unknown");
  form.append("with_timestamps", "true");
  // `mode` only applies to the saaras family. Quietly skip for saarika.
  if (input.mode && model.startsWith("saaras")) {
    form.append("mode", input.mode);
  }

  const res = await fetch(SARVAM_ENDPOINT, {
    method: "POST",
    headers: { "api-subscription-key": input.apiKey },
    body: form,
  });

  const requestId = res.headers.get("x-request-id") ?? "";

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`sarvam ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    transcript?: string;
    timestamps?: {
      words?: string[];
      start_time_seconds?: number[];
      end_time_seconds?: number[];
    };
    language_code?: string;
    request_id?: string;
  };

  const chunkOffsetSec = input.chunkIdx * 30; // keep consistent with bot's chunkSeconds

  const ts = json.timestamps;
  if (ts?.words?.length && ts.start_time_seconds?.length === ts.words.length) {
    const words = ts.words.map((w, i) => ({
      word: w,
      start_time: ts.start_time_seconds![i],
      end_time: ts.end_time_seconds?.[i] ?? ts.start_time_seconds![i],
    }));
    return groupWords(words, chunkOffsetSec, requestId || json.request_id || "");
  }

  const text = (json.transcript ?? "").trim();
  if (!text) return [];
  return [
    {
      startTs: chunkOffsetSec,
      endTs: chunkOffsetSec + 30,
      rawText: text,
      confidence: null,
      sarvamRequestId: requestId || json.request_id || "",
    },
  ];
}

function groupWords(
  words: Array<{ word: string; start_time?: number; end_time?: number }>,
  offset: number,
  reqId: string
): TranscribedSegment[] {
  const GROUP_MS = 1500;
  const out: TranscribedSegment[] = [];
  let cur: { words: string[]; start: number; end: number } | null = null;

  for (const w of words) {
    const start = (w.start_time ?? 0) + offset;
    const end = (w.end_time ?? start) + offset;
    if (!cur) {
      cur = { words: [w.word], start, end };
      continue;
    }
    if (end - cur.start > GROUP_MS / 1000) {
      out.push({
        startTs: cur.start,
        endTs: cur.end,
        rawText: cur.words.join(" ").trim(),
        confidence: null,
        sarvamRequestId: reqId,
      });
      cur = { words: [w.word], start, end };
    } else {
      cur.words.push(w.word);
      cur.end = end;
    }
  }
  if (cur && cur.words.length) {
    out.push({
      startTs: cur.start,
      endTs: cur.end,
      rawText: cur.words.join(" ").trim(),
      confidence: null,
      sarvamRequestId: reqId,
    });
  }
  log.debug({ segments: out.length, reqId }, "sarvam grouped");
  return out;
}
