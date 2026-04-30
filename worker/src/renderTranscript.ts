// Render `transcript_final` rows into the user-spec line format:
//   [HH:MM AM/PM] Speaker Name: text
// Wall-clock derives from sessions.started_at (UTC) + row.startTs (rel s).
// Default render TZ is Asia/Kolkata; override via env RENATE_RENDER_TZ.

export interface FinalRow {
  startTs: number;
  endTs: number;
  speakerName: string;
  text: string;
}

const DEFAULT_TZ = process.env.RENATE_RENDER_TZ || "Asia/Kolkata";

export function renderTranscript(
  rows: FinalRow[],
  sessionStartedAt: Date | null,
  tz: string = DEFAULT_TZ
): string {
  return rows
    .map((r) => `${stamp(r.startTs, sessionStartedAt, tz)} ${r.speakerName}: ${r.text.trim()}`)
    .join("\n");
}

function stamp(startTs: number, startedAt: Date | null, tz: string): string {
  if (!startedAt || Number.isNaN(startedAt.getTime())) {
    // Fallback: relative [mm:ss]. The view + log already announce this case.
    const m = Math.floor(startTs / 60);
    const s = Math.floor(startTs % 60);
    return `[${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}]`;
  }
  const wall = new Date(startedAt.getTime() + startTs * 1000);
  const hhmm = wall.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });
  return `[${hhmm}]`;
}
