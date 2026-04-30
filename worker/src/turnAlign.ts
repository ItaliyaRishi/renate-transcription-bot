// Word→turn alignment.
//
// Given Sarvam word-level timestamps and diarize speaker turns, emit one
// row per turn with the words whose midpoints fall inside the turn window.
// This preserves rapid back-and-forth: if speaker A is cut off mid-sentence
// by a one-word interjection from B, diarize already produced A→B→A turns
// and we emit three rows, not one merged paragraph.

export interface Word {
  startTs: number;
  endTs: number;
  text: string;
}

export interface Turn {
  startTs: number;
  endTs: number;
  cluster: string;
}

export interface AlignedRow {
  startTs: number;
  endTs: number;
  cluster: string;
  text: string;
}

/**
 * Drop all words whose midpoint lies inside each turn's [startTs, endTs].
 * Rows with no overlapping words are skipped — a turn that diarize detected
 * but Sarvam didn't transcribe (silent / non-speech) shouldn't pollute the
 * output. Rows are returned in turn-order (sorted by startTs).
 */
export function alignWordsToTurns(words: Word[], turns: Turn[]): AlignedRow[] {
  if (!turns.length) return [];
  const sortedTurns = [...turns].sort((a, b) => a.startTs - b.startTs);
  const sortedWords = [...words].sort((a, b) => a.startTs - b.startTs);

  // Walk both lists in time order; for each turn, collect words whose
  // midpoint is inside the window. O(N+M) under the assumption that turns
  // are non-overlapping (which diarize guarantees).
  const out: AlignedRow[] = [];
  let wIdx = 0;
  for (const t of sortedTurns) {
    const bucket: string[] = [];
    let firstStart: number | null = null;
    let lastEnd: number | null = null;
    while (wIdx < sortedWords.length) {
      const w = sortedWords[wIdx];
      const mid = (w.startTs + w.endTs) / 2;
      if (mid < t.startTs) {
        // Word ended before this turn started — drop it (would land between
        // turns, which means diarize considered it non-speech).
        wIdx++;
        continue;
      }
      if (mid > t.endTs) break; // word belongs to a later turn
      bucket.push(w.text.trim());
      if (firstStart === null) firstStart = w.startTs;
      lastEnd = w.endTs;
      wIdx++;
    }
    const text = bucket.join(" ").replace(/\s+([,.!?;:])/g, "$1").trim();
    if (!text) continue;
    out.push({
      startTs: firstStart ?? t.startTs,
      endTs: lastEnd ?? t.endTs,
      cluster: t.cluster,
      text,
    });
  }
  return out;
}
