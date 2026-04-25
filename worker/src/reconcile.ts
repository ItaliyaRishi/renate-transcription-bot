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
 * A single name-bearing observation from an in-call DOM signal. `tSec` is
 * call-relative seconds, in the same coordinate system as `PyannoteTurn.*Ts`
 * — the caller is responsible for converting wall-clock timestamps before
 * handing events to `resolveClusterNames`.
 */
export interface NameEvent {
  tSec: number;
  name: string;
  source: "caption" | "tile";
}

/**
 * Fuse caption + active-speaker-tile observations with diarization turns
 * to produce a cluster→displayName map.
 *
 * Weighting: a caption badge counts 2× a tile hit — captions are emitted
 * by Meet's own name resolution, tiles just by visual highlight.
 *
 * Canonicalization: a winning name that token-prefix-matches exactly one
 * roster entry is replaced by that roster entry (fixes truncated / first-
 * name-only caption badges like "Rishi" → "Rishi Italiya").
 *
 * Fill: clusters with no event evidence take the next unused roster entry
 * in first-appearance order; anything still unresolved becomes "Speaker N".
 */
export function resolveClusterNames(
  turns: PyannoteTurn[],
  nameEvents: NameEvent[],
  roster: string[]
): {
  clusterToName: Record<string, string>;
  resolution: Record<string, "caption" | "tile" | "roster" | "fallback">;
} {
  const clusterToName: Record<string, string> = {};
  const resolution: Record<string, "caption" | "tile" | "roster" | "fallback"> = {};
  if (!turns.length) return { clusterToName, resolution };

  const byCluster = new Map<string, PyannoteTurn[]>();
  for (const t of turns) {
    const arr = byCluster.get(t.cluster) ?? [];
    arr.push(t);
    byCluster.set(t.cluster, arr);
  }

  const scores = new Map<string, Map<string, { caption: number; tile: number }>>();
  for (const c of byCluster.keys()) scores.set(c, new Map());

  for (const ev of nameEvents) {
    const name = ev.name.trim();
    if (!name) continue;
    if (/^(you|me)$/i.test(name)) continue;
    for (const [cluster, clusterTurns] of byCluster.entries()) {
      if (!clusterTurns.some((t) => ev.tSec >= t.startTs && ev.tSec <= t.endTs)) continue;
      const perName = scores.get(cluster)!;
      const s = perName.get(name) ?? { caption: 0, tile: 0 };
      if (ev.source === "caption") s.caption++;
      else s.tile++;
      perName.set(name, s);
      break;
    }
  }

  const usedNames = new Set<string>();
  for (const [cluster, perName] of scores.entries()) {
    let winner: { name: string; weight: number; source: "caption" | "tile" } | null = null;
    for (const [name, s] of perName.entries()) {
      const weight = s.caption * 2 + s.tile;
      if (!winner || weight > winner.weight) {
        winner = { name, weight, source: s.caption >= s.tile ? "caption" : "tile" };
      }
    }
    if (!winner) continue;
    const canon = canonicalizeAgainstRoster(winner.name, roster);
    const finalName = canon ?? winner.name;
    clusterToName[cluster] = finalName;
    resolution[cluster] = winner.source;
    usedNames.add(finalName.toLowerCase());
  }

  // First-appearance cluster order, for stable roster fill.
  const firstAppearance: string[] = [];
  const seen = new Set<string>();
  for (const t of [...turns].sort((a, b) => a.startTs - b.startTs)) {
    if (seen.has(t.cluster)) continue;
    seen.add(t.cluster);
    firstAppearance.push(t.cluster);
  }
  const availableRoster = roster.filter((n) => !usedNames.has(n.toLowerCase()));
  let fallbackCounter = 1;
  for (const cluster of firstAppearance) {
    if (clusterToName[cluster]) continue;
    const next = availableRoster.shift();
    if (next) {
      clusterToName[cluster] = next;
      resolution[cluster] = "roster";
      usedNames.add(next.toLowerCase());
    } else {
      clusterToName[cluster] = `Speaker ${fallbackCounter++}`;
      resolution[cluster] = "fallback";
    }
  }

  return { clusterToName, resolution };
}

function canonicalizeAgainstRoster(raw: string, roster: string[]): string | null {
  if (!raw || raw.length < 3) return null;
  const rawLow = raw.toLowerCase();
  const matches: string[] = [];
  for (const r of roster) {
    const rLow = r.toLowerCase();
    if (rLow === rawLow) { matches.push(r); continue; }
    const tokens = rLow.split(/\s+/);
    if (tokens.some((t) => t.length >= 3 && (t === rawLow || t.startsWith(rawLow)))) {
      matches.push(r);
    }
  }
  return matches.length === 1 ? matches[0] : null;
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
 *
 * Turns are split when the speaker changes OR the gap since the previous
 * segment exceeds MAX_GAP_SEC. Without a gap threshold, a single long
 * call collapses to one-row-per-speaker and loses all conversational
 * structure.
 */
export function mergeSegmentsWithSpeakers(
  segments: Array<{ startTs: number; endTs: number; text: string }>,
  turns: PyannoteTurn[],
  speakerMap: ReconciledSpeakerMap
): Array<{ startTs: number; endTs: number; speakerName: string; text: string }> {
  const MAX_GAP_SEC = 2.5;
  const out: Array<{ startTs: number; endTs: number; speakerName: string; text: string }> = [];

  for (const seg of segments) {
    const best = pickBestOverlap(seg.startTs, seg.endTs, turns);
    const name = best ? speakerMap[best.cluster] ?? best.cluster : "Unknown";
    const last = out[out.length - 1];
    const gap = last ? seg.startTs - last.endTs : Infinity;
    if (last && last.speakerName === name && gap < MAX_GAP_SEC) {
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

