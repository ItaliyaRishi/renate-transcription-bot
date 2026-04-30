// Smoke test for the resolver + turn-aligner.
//
// Runs the same exact functions finalize uses, against synthetic inputs
// that reproduce the broken-225bc5ed shape: 3 diarize clusters, captions
// dominated by ONE speaker, but tile evidence saying clusters belong to
// three different humans. Asserts the resolver assigns three distinct
// names — the regression that produced the 1228-second mega-row.
//
// Run with: cd worker && npx tsx scripts/smoke-finalize.ts

import { resolveClusterNames, type NameEvent, type PyannoteTurn } from "../src/reconcile.js";
import { alignWordsToTurns, type Turn, type Word } from "../src/turnAlign.js";
import { renderTranscript, type FinalRow } from "../src/renderTranscript.js";

let failed = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

console.log("== resolver: 3 clusters, dominant captioner, tile evidence per cluster ==");
{
  const turns: PyannoteTurn[] = [
    { startTs: 0, endTs: 200, cluster: "SPEAKER_00" },
    { startTs: 200, endTs: 400, cluster: "SPEAKER_01" },
    { startTs: 400, endTs: 600, cluster: "SPEAKER_02" },
  ];
  // Captions: Shikhar dominates. This is the broken-225bc5ed shape.
  const captionEvents: NameEvent[] = [];
  for (let i = 5; i < 600; i += 10) {
    captionEvents.push({ tSec: i, name: "Shikhar Neogi", source: "caption" });
  }
  // Tile evidence: per-cluster, three different humans. Sparser than
  // captions, but with the higher per-event weight it should outvote.
  const tileEvents: NameEvent[] = [
    { tSec: 30, name: "Shikhar Neogi", source: "tile" },
    { tSec: 60, name: "Shikhar Neogi", source: "tile" },
    { tSec: 90, name: "Shikhar Neogi", source: "tile" },
    { tSec: 230, name: "Vighnesh Nama", source: "tile" },
    { tSec: 260, name: "Vighnesh Nama", source: "tile" },
    { tSec: 290, name: "Vighnesh Nama", source: "tile" },
    { tSec: 430, name: "Raj Jadhav", source: "tile" },
    { tSec: 460, name: "Raj Jadhav", source: "tile" },
    { tSec: 490, name: "Raj Jadhav", source: "tile" },
  ];
  const roster = ["Shikhar Neogi", "Vighnesh Nama", "Raj Jadhav"];

  const { clusterToName, resolution, weightMatrix } = resolveClusterNames(
    turns,
    [...captionEvents, ...tileEvents],
    roster
  );

  console.log("    map:", clusterToName);
  console.log("    resolution:", resolution);
  console.log("    weights:", JSON.stringify(weightMatrix));

  const distinct = new Set(Object.values(clusterToName));
  check("3 distinct names assigned", distinct.size === 3, Array.from(distinct));
  check("SPEAKER_00 → Shikhar", clusterToName["SPEAKER_00"] === "Shikhar Neogi");
  check("SPEAKER_01 → Vighnesh", clusterToName["SPEAKER_01"] === "Vighnesh Nama");
  check("SPEAKER_02 → Raj", clusterToName["SPEAKER_02"] === "Raj Jadhav");
}

console.log("");
console.log("== resolver: zero tile evidence (captions only, ambiguous) ==");
{
  const turns: PyannoteTurn[] = [
    { startTs: 0, endTs: 100, cluster: "C0" },
    { startTs: 100, endTs: 200, cluster: "C1" },
  ];
  // Captions all attribute to "Alice". Without tile evidence the resolver
  // should still NOT collapse — Alice goes to whichever cluster wins,
  // and the second cluster falls back to the next roster name.
  const captions: NameEvent[] = [
    { tSec: 50, name: "Alice", source: "caption" },
    { tSec: 150, name: "Alice", source: "caption" },
  ];
  const { clusterToName } = resolveClusterNames(turns, captions, ["Alice", "Bob"]);
  console.log("    map:", clusterToName);
  const distinct = new Set(Object.values(clusterToName));
  check("no name collision when only captions exist", distinct.size === 2, Array.from(distinct));
  check("Alice was used exactly once", Object.values(clusterToName).filter((n) => n === "Alice").length === 1);
  check("Bob was assigned via roster fallback", Object.values(clusterToName).includes("Bob"));
}

console.log("");
console.log("== aligner: A → B (1-word interjection) → A ==");
{
  // Three turns, with B saying just "right" between two A blocks.
  const turns: Turn[] = [
    { startTs: 0, endTs: 5, cluster: "A" },
    { startTs: 5, endTs: 6, cluster: "B" },
    { startTs: 6, endTs: 12, cluster: "A" },
  ];
  const words: Word[] = [
    { startTs: 0, endTs: 0.5, text: "Hello" },
    { startTs: 0.6, endTs: 1.1, text: "everyone" },
    { startTs: 1.2, endTs: 4.9, text: "good morning" },
    { startTs: 5.2, endTs: 5.7, text: "right" },
    { startTs: 6.1, endTs: 7.0, text: "let's" },
    { startTs: 7.1, endTs: 11.5, text: "review the timeline" },
  ];
  const aligned = alignWordsToTurns(words, turns);
  console.log("    rows:", aligned);
  check("3 rows produced", aligned.length === 3, aligned.length);
  check("row 0 is A", aligned[0]?.cluster === "A");
  check("row 1 is B and contains 'right'", aligned[1]?.cluster === "B" && /right/i.test(aligned[1]?.text ?? ""));
  check("row 2 is A and contains 'review'", aligned[2]?.cluster === "A" && /review/i.test(aligned[2]?.text ?? ""));
}

console.log("");
console.log("== renderer: format spec ==");
{
  const startedAt = new Date("2026-04-29T03:30:00.000Z"); // 09:00 IST
  const rows: FinalRow[] = [
    { startTs: 0, endTs: 4, speakerName: "John Doe", text: "Good morning everyone, let's get started." },
    { startTs: 60, endTs: 65, speakerName: "Jane Smith", text: "Hi John, can you hear me okay?" },
  ];
  const text = renderTranscript(rows, startedAt, "Asia/Kolkata");
  console.log("    output:\n" + text.split("\n").map((l) => "    " + l).join("\n"));
  const lines = text.split("\n");
  check("two lines emitted", lines.length === 2);
  check("first line wall-clock at 09:00 AM", lines[0].startsWith("[09:00 AM] "));
  check("second line wall-clock at 09:01 AM", lines[1].startsWith("[09:01 AM] "));
  check("speaker name + colon present", /\] John Doe: /.test(lines[0]));
  check("no trailing space after colon", !/: $/.test(lines[0]));
  check("no seconds in stamp", !/\d{2}:\d{2}:\d{2}/.test(lines[0]));
}

console.log("");
if (failed) {
  console.error(`FAILED: ${failed} assertion(s).`);
  process.exit(1);
}
console.log("ALL SMOKE TESTS PASSED.");
