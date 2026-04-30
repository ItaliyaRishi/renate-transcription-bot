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

export interface ResolveOptions {
  /** Caption weight per overlapping event (default 2). */
  captionWeight?: number;
  /** Tile weight per overlapping event (default 3, since tile is per-cluster
   *  separating evidence; captions are biased to whoever Meet's CC names. */
  tileWeight?: number;
}

/**
 * Fuse caption + active-speaker-tile observations with diarization turns
 * to produce a cluster→displayName map under a one-to-one constraint.
 *
 * Two clusters never get the same name. The previous implementation
 * picked the highest-weighted name per cluster INDEPENDENTLY — when one
 * speaker dominated the captions stream all clusters would resolve to
 * the same human, then the merge step downstream collapsed everything
 * into a single mega-row. We now solve the assignment globally:
 *
 *   1. Build a `K × M` weight matrix W[c, n] = captionWeight × captionVotes
 *      + tileWeight × tileVotes for every (cluster, candidate-name) pair.
 *   2. Walk in descending weight order; greedily assign the next-best
 *      (cluster, name) only when neither is already taken.
 *   3. Clusters with no positive evidence fall through to roster-fill in
 *      first-appearance order, skipping names already used.
 *   4. Anything still unresolved becomes "Speaker N".
 *
 * Greedy with a strict tie-break (cluster first-appearance time) is
 * sufficient for the K ≤ 8 / M ≤ 16 sizes we see in practice and avoids
 * pulling in a Hungarian library.
 */
export function resolveClusterNames(
  turns: PyannoteTurn[],
  nameEvents: NameEvent[],
  roster: string[],
  opts: ResolveOptions = {}
): {
  clusterToName: Record<string, string>;
  resolution: Record<string, "caption" | "tile" | "roster" | "fallback">;
  weightMatrix: Record<string, Record<string, number>>;
} {
  const captionWeight = opts.captionWeight ?? 2;
  const tileWeight = opts.tileWeight ?? 3;

  const clusterToName: Record<string, string> = {};
  const resolution: Record<string, "caption" | "tile" | "roster" | "fallback"> = {};
  const weightMatrix: Record<string, Record<string, number>> = {};
  if (!turns.length) return { clusterToName, resolution, weightMatrix };

  // Cluster first-appearance order — used both for stable greedy tie-breaks
  // and for roster fallback.
  const firstAppearance: string[] = [];
  const seen = new Set<string>();
  for (const t of [...turns].sort((a, b) => a.startTs - b.startTs)) {
    if (seen.has(t.cluster)) continue;
    seen.add(t.cluster);
    firstAppearance.push(t.cluster);
  }
  const clusterOrder = new Map<string, number>();
  firstAppearance.forEach((c, i) => clusterOrder.set(c, i));

  const turnsByCluster = new Map<string, PyannoteTurn[]>();
  for (const t of turns) {
    const arr = turnsByCluster.get(t.cluster) ?? [];
    arr.push(t);
    turnsByCluster.set(t.cluster, arr);
  }

  // Tally per-cluster, per-name caption + tile votes.
  type Tally = { caption: number; tile: number };
  const scores = new Map<string, Map<string, Tally>>();
  for (const c of firstAppearance) scores.set(c, new Map());

  for (const ev of nameEvents) {
    const name = canonicalNameKey(ev.name);
    if (!name) continue;
    for (const [cluster, clusterTurns] of turnsByCluster.entries()) {
      if (!clusterTurns.some((t) => ev.tSec >= t.startTs && ev.tSec <= t.endTs)) continue;
      const perName = scores.get(cluster)!;
      const s = perName.get(name) ?? { caption: 0, tile: 0 };
      if (ev.source === "caption") s.caption++;
      else s.tile++;
      perName.set(name, s);
      break;
    }
  }

  // Flatten into a (cluster, name, weight, source) candidate list. Walk
  // descending; assign greedily when both row and column are still free.
  interface Cand {
    cluster: string;
    name: string;
    weight: number;
    source: "caption" | "tile";
  }
  const cands: Cand[] = [];
  for (const [cluster, perName] of scores.entries()) {
    const wRow: Record<string, number> = {};
    for (const [name, s] of perName.entries()) {
      const weight = s.caption * captionWeight + s.tile * tileWeight;
      if (weight <= 0) continue;
      wRow[name] = weight;
      cands.push({
        cluster,
        name,
        weight,
        source: s.tile * tileWeight >= s.caption * captionWeight ? "tile" : "caption",
      });
    }
    weightMatrix[cluster] = wRow;
  }
  cands.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return (clusterOrder.get(a.cluster) ?? 0) - (clusterOrder.get(b.cluster) ?? 0);
  });

  const usedNamesLower = new Set<string>();
  for (const c of cands) {
    if (clusterToName[c.cluster]) continue;
    const canon = canonicalizeAgainstRoster(c.name, roster) ?? c.name;
    const lower = canon.toLowerCase();
    if (usedNamesLower.has(lower)) continue;
    clusterToName[c.cluster] = canon;
    resolution[c.cluster] = c.source;
    usedNamesLower.add(lower);
  }

  // Roster fill for clusters with no evidence (or whose only candidate
  // names were already taken). First-appearance order keeps assignment
  // deterministic across reruns.
  const availableRoster = roster.filter((n) => !usedNamesLower.has(n.toLowerCase()));
  let fallbackCounter = 1;
  for (const cluster of firstAppearance) {
    if (clusterToName[cluster]) continue;
    const next = availableRoster.shift();
    if (next) {
      clusterToName[cluster] = next;
      resolution[cluster] = "roster";
      usedNamesLower.add(next.toLowerCase());
    } else {
      clusterToName[cluster] = `Speaker ${fallbackCounter++}`;
      resolution[cluster] = "fallback";
    }
  }

  return { clusterToName, resolution, weightMatrix };
}

function canonicalNameKey(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (/^(you|me|unknown)$/i.test(t)) return "";
  return t;
}

function canonicalizeAgainstRoster(raw: string, roster: string[]): string | null {
  if (!raw || raw.length < 3) return null;
  const rawLow = raw.toLowerCase();
  const matches: string[] = [];
  for (const r of roster) {
    const rLow = r.toLowerCase();
    if (rLow === rawLow) {
      matches.push(r);
      continue;
    }
    const tokens = rLow.split(/\s+/);
    if (tokens.some((t) => t.length >= 3 && (t === rawLow || t.startsWith(rawLow)))) {
      matches.push(r);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
