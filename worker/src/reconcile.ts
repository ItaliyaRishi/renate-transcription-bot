export interface PyannoteTurn {
  startTs: number;
  endTs: number;
  cluster: string;
}

export interface DomCaptionRecord {
  startTs: number;
  endTs: number;
  speakerName: string;
  text: string;
}

export interface TranscriptWord {
  startTs: number;
  endTs: number;
  text: string;
}

export interface ReconciledSpeakerMap {
  [pyannoteCluster: string]: string;
}

/**
 * Pair each pyannote cluster with the DOM-caption speaker name it
 * temporally overlaps most. DOM wins on conflict — it's authoritative for
 * human-readable names.
 */
export function reconcileSpeakers(
  turns: PyannoteTurn[],
  captions: DomCaptionRecord[]
): ReconciledSpeakerMap {
  // cluster -> name -> total overlap seconds
  const overlap = new Map<string, Map<string, number>>();

  for (const t of turns) {
    let perName = overlap.get(t.cluster);
    if (!perName) {
      perName = new Map();
      overlap.set(t.cluster, perName);
    }
    for (const c of captions) {
      const o = overlapSeconds(t.startTs, t.endTs, c.startTs / 1000, c.endTs / 1000);
      if (o > 0) {
        perName.set(c.speakerName, (perName.get(c.speakerName) ?? 0) + o);
      }
    }
  }

  const result: ReconciledSpeakerMap = {};
  for (const [cluster, names] of overlap.entries()) {
    let best: { name: string; seconds: number } | null = null;
    for (const [name, seconds] of names.entries()) {
      if (!best || seconds > best.seconds) best = { name, seconds };
    }
    if (best) result[cluster] = best.name;
  }
  return result;
}

function overlapSeconds(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const s = Math.max(aStart, bStart);
  const e = Math.min(aEnd, bEnd);
  return Math.max(0, e - s);
}

/**
 * Merge transcript_segments (Sarvam words / utterances) with diarization
 * turns to produce final (speaker, text) rows. For each segment, assign
 * the speaker whose turn overlaps it most; fall back to "Unknown".
 */
export function mergeSegmentsWithSpeakers(
  segments: Array<{ startTs: number; endTs: number; text: string }>,
  turns: PyannoteTurn[],
  speakerMap: ReconciledSpeakerMap
): Array<{ startTs: number; endTs: number; speakerName: string; text: string }> {
  const out: Array<{ startTs: number; endTs: number; speakerName: string; text: string }> = [];

  for (const seg of segments) {
    const best = pickBestOverlap(seg.startTs, seg.endTs, turns);
    const name = best ? speakerMap[best.cluster] ?? best.cluster : "Unknown";
    const last = out[out.length - 1];
    if (last && last.speakerName === name && seg.startTs - last.endTs < 1.5) {
      last.text = `${last.text} ${seg.text}`.trim();
      last.endTs = seg.endTs;
    } else {
      out.push({
        startTs: seg.startTs,
        endTs: seg.endTs,
        speakerName: name,
        text: seg.text,
      });
    }
  }
  return out;
}

function pickBestOverlap(
  segStart: number,
  segEnd: number,
  turns: PyannoteTurn[]
): PyannoteTurn | null {
  let best: { turn: PyannoteTurn; o: number } | null = null;
  for (const t of turns) {
    const o = overlapSeconds(segStart, segEnd, t.startTs, t.endTs);
    if (o > 0 && (!best || o > best.o)) best = { turn: t, o };
  }
  return best?.turn ?? null;
}
