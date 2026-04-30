# Fix: live roster + turn-accurate diarized transcript

## Context

Two real defects observed on session `225bc5ed-cb74-45ec-b611-1318aeee306f` (~26 min Hindi+English call, 3 humans):

**Issue 1 — speaker names not fully fetched.**
Bot already polls the People panel every 30 s (`bot/src/index.ts:200-214`) and persists to `session:<sid>:roster` in Redis. But (a) the panel is opened-and-closed each cycle, so anyone who joins between ticks is invisible until the next 30 s; (b) the roster scrape only captured the 3 people present at boot — `Shikhar Neogi` joined ~minute 2 and was never in `roster.names` at finalize time, only seen because Meet's CC engine attributed his speech in the captions stream. Non-speakers would never be captured. We need a continuous, open-panel observer that catches joiners *and* leavers in real time, including silent participants.

**Issue 2 — transcript collapsed to one speaker, no turn structure.**
`transcript_final` ended up with **2 rows for 243 diarize turns** (one 1228 s "Shikhar Neogi" mega-row + one 88 s "Unknown"). Two compounding bugs:

1. **Cluster→name resolver has no one-to-one constraint** (`worker/src/reconcile.ts:88-102`). It picks the highest-weighted name per cluster independently, so when one speaker dominates the captions stream all 3 clusters end up assigned to the same person. There is no Hungarian-style assignment, no "name already used" guard.
2. **Active-speaker tile selectors broke** (`bot/src/selectors.ts:90`). `[data-participant-id], [data-self-name], [data-requested-participant-id], [class*="participant-tile"]` matched 0 tiles for the entire call (we have the `sampleTiles: []` log). With tile evidence empty, the resolver had only captions, which are biased to whoever Meet's CC happened to attribute most.
3. **Merge key is `(speaker_name)` only** (`worker/src/reconcile.ts:174-176`), with a 2.5 s gap window. After bug 1 collapsed all clusters to one name, every consecutive segment got coalesced into that single mega-row.
4. **Turn granularity isn't enforced.** Sarvam already returns word-level timestamps (`worker/src/sarvam.ts:42` sets `with_timestamps=true`), but `transcript_final` is assembled from coarse 28 s chunk-segments rather than from word→turn alignment. Even after a perfect resolver, a one-word interjection inside a 28 s chunk dominated by another speaker would still be silently merged into the dominant utterance.

Goal: every participant captured the moment they join (talking or not); every diarize turn surfaces as its own transcript row labeled with the correct human, even if it is a one-word interjection that cuts another speaker off.

---

## Plan

### Part A — live roster (open-panel MutationObserver)

**File: `bot/src/peoplePanel.ts`** — replace the click→scrape→close pattern with an open-once observer.

1. After join, open the People panel **once** and leave it open. Use existing `openPanel()` (lines 25-51).
2. Inside `page.evaluate`, attach a `MutationObserver({childList:true, subtree:true})` to the panel container `[aria-label="Participants"]` (confirmed by Vexa + meetingbot 2026 reference bots — see Sources).
3. On every mutation, enumerate `panel.querySelectorAll('[data-participant-id]')`. For each row read:
   - `data-participant-id` → stable per-call ID
   - `aria-label` → display name (the existing 3-tier extractor in `peoplePanel.ts:53-154` is kept as fallback for rows without aria-label)
4. Expose a new Playwright binding `__renatePushRoster(names: string[])` (mirrors the captions / active-speaker pattern at `bot/src/captions.ts:28-37`, `bot/src/activeSpeaker.ts:39-48`). The observer calls it on every change.
5. Node-side handler in `bot/src/index.ts` writes the new roster to Redis (`session:<sid>:roster`, `state.ts:33`) and increments a sequence counter so finalize can see it was live-tracked.
6. **Final scrape on shutdown.** Before `shutdown()` enqueues finalize (`bot/src/index.ts:152-154`), force one synchronous read of the panel via the existing observer state. Adds ~50 ms; eliminates the "stale snapshot at SIGTERM" risk.
7. **Drop the 30 s `setInterval`** at `bot/src/index.ts:200-214` — replaced by the live observer.

**Edge cases handled:**
- Panel briefly closed by the user → observer detaches; we re-open and re-attach. Add a 2 s watchdog that re-opens if `[aria-label="Participants"]` disappears.
- Bot's own name (`Renate Transcription`) is filtered (already done at `peoplePanel.ts` extractor).
- Late joiner who never speaks → still captured, because they appear in `data-participant-id` rows the moment Meet pushes a roster update.

### Part B — fix active-speaker tile detection

**File: `bot/src/selectors.ts:81-95` + `bot/src/activeSpeaker.ts`.**

1. Replace `activeTileCandidates` with the **semantic** signal `[data-audio-level]` (Vexa's confirmed selector — survives Meet's class rotation).
2. Add tile→participant join: each tile in the main grid carries `data-requested-participant-id`, the same ID as roster rows. So we map `audioLevel > 0` → tile → `data-requested-participant-id` → roster name (no DOM-text scraping needed).
3. Fall back to obfuscated speaking class tokens (`.Oaajhc, .HX2H7, .wEsLMd, .OgVli`) only if `data-audio-level` is absent — these rotate quarterly per the research.
4. Convert the 200 ms `setInterval` poller to a `MutationObserver` with `attributeFilter: ['data-audio-level']` per tile — fewer wake-ups, sub-100 ms latency, works while screenshare is active.
5. Push events to the existing `__renatePushActiveSpeaker` binding unchanged — downstream worker code stays the same.

### Part C — one-to-one cluster→name assignment

**File: `worker/src/reconcile.ts:50-128`.**

Replace the current "pick the highest-weighted name per cluster independently" loop with a **constrained assignment**:

1. Build a `K × M` weight matrix `W[c, n]` where `c` ranges over diarize clusters and `n` over candidate names (union of caption names ∪ tile names ∪ roster). `W[c, n] = 2 × captionVotes(c, n) + 1 × tileVotes(c, n)`. Voting kept at the per-event-overlap-with-cluster-window granularity already in `reconcile.ts:69-94`.
2. Solve the **rectangular assignment** maximising total weight under "each name used at most once" (rows: clusters; columns: names; allow column slack via dummy cells with weight 0). Implementation: Hungarian / `munkres` — it's K ≤ 8, M ≤ 16 so a 200-line greedy-with-backtrack works fine; bring in `munkres-js` if we want canonical.
3. Clusters whose assigned name has weight 0 (no evidence) fall through to the existing roster-fill logic at lines 104-125, but **with a "name already used" set** so the same human is never written into two clusters.
4. Tile-evidence weight goes UP from 1× to **3×** once Part B lands — it's the only signal that cleanly separates clusters when two speakers are equally chatty in captions.
5. Add a unit test fixture: 3 clusters, captions dominated 5:1 by speaker A, tile evidence shows A in cluster_0, B in cluster_1, C in cluster_2 → assert resolver returns A/B/C, not A/A/A.

### Part D — turn-accurate transcript assembly

**File: `worker/src/reconcile.ts:161-187` + a new helper `worker/src/turnAlign.ts`.**

Today the merge step concatenates Sarvam segments by `(speaker_name, gap < 2.5 s)`. We replace it with a word→turn aligner:

1. Sarvam already returns word-level timestamps (`worker/src/sarvam.ts:61-81`). Persist them to Postgres alongside `transcript_segments` — add column `words jsonb` (array of `{w, ts, te}`). Migration `db/migrations/0002_word_timestamps.sql`.
2. In finalize, after diarize returns turns and reconcile assigns names, build `transcript_final` row-by-row from the **diarize turn list** (not the segment list):
   - For each turn `(start_ts, end_ts, cluster)`:
     - Collect every word from `transcript_segments.words` whose `(ts + te)/2` falls inside `[start_ts, end_ts]`.
     - Concatenate words → row text. Trim leading/trailing whitespace, restore Sarvam punctuation.
     - Speaker name = `clusterToName[cluster]`.
     - One row per turn. **No coalescing** of consecutive same-name turns — preserves rapid back-and-forth.
3. Drop the `MAX_GAP_SEC=2.5` merge entirely. If a one-second interjection cuts speaker A off, diarize already produced two turns (A → B → A), and now we emit three rows.
4. Edge: a word straddling the turn boundary (rare with diarize's snap-to-VAD) → assign to the turn containing its midpoint. Document in the helper.
5. Add a `cluster` column to `transcript_final` (migration `0003_transcript_final_cluster.sql`) so a degenerate "two clusters got the same name" case still produces two rows. Belt-and-braces with the resolver fix.

### Part D2 — wall-clock rendering, one line per turn

**Required output format** (per user spec):

```
[09:00 AM] John Doe: Good morning everyone, let's get started.
[09:01 AM] Jane Smith: Hi John, can you hear me okay?
[09:01 AM] John Doe: Yes, loud and clear. Let's review the project timeline.
[09:03 AM] Mike Ross: I have updated the Q3 report, it is currently in the shared folder.
[09:05 AM] John Doe: Perfect. Action Item: Sarah to review the budget by Friday.
```

Strict rules: 12-hour clock with AM/PM, **no seconds**; one turn per line; `Speaker Name:` with a single space after the colon; no leading dash, no markdown bullets.

**Database keeps relative seconds** (`transcript_final.start_ts`) — wall-clock is render-only, so re-computable if a session is replayed in a different TZ.

**New helper: `worker/src/renderTranscript.ts`**

```ts
export function renderTranscript(rows, sessionStartedAt, tz = "Asia/Kolkata") {
  return rows.map(r => {
    const wall = new Date(sessionStartedAt.getTime() + r.start_ts * 1000);
    const hhmm = wall.toLocaleTimeString("en-US", {
      hour: "2-digit", minute: "2-digit", hour12: true, timeZone: tz,
    }); // "09:00 AM"
    return `[${hhmm}] ${r.speaker_name}: ${r.text.trim()}`;
  }).join("\n");
}
```

**Wire-up sites:**

| Surface | Current | New |
|---|---|---|
| File dump (TEST_COMMANDS step 4 awk script) | `[mm:ss]` rel time, padded columns | `[HH:MM AM/PM] Name: text` |
| API `GET /sessions/:id` | (no transcript field today) | add `transcript_text` rendered with the helper |
| OpenAI summary input (`worker/src/finalize.ts:471-477`) | `**Name** (HH:MM → HH:MM): text` | switch to the new line format — keeps summaries grounded in the same string the user sees |
| Postgres view `transcript_final_rendered` (new) | n/a | one-row-per-turn `text_line` column for ad-hoc `psql` reads |

**Timezone source of truth.** Default `Asia/Kolkata` (matches the operator). Override via env `RENATE_RENDER_TZ` so a future Workspace user in another region can flip it without code change. Stored as IANA name; never as fixed offset.

**Edge cases:**
- Session crossing midnight → 12-hour clock naturally handles it; date is omitted by user spec, so a `12:01 AM` row after `11:59 PM` is unambiguous in context.
- `sessions.started_at` missing (shouldn't happen post-finalize) → fall back to `[mm:ss]` rel-time and log a warning rather than emit a broken `[NaN:NaN]`.
- Speaker name still unresolved (`Speaker 1` fallback from Part C) → render as-is, no special casing.

### Part E — observability + verification

1. Log roster delta on every observer fire: `{added: [...], removed: [...], total: N}` so we can see joiners in real time.
2. At finalize, log `{numClusters, numAssignedNames, numFallbackNames, weightMatrix}` so a future broken call is debuggable from one log line.
3. New CLI smoke test (`scripts/smoke-finalize.ts`): replays the saved audio for the broken session through the new finalize path against a captured `dom_captions` + (synthetic) `active_speaker` stream, asserts ≥ 3 distinct rows in `transcript_final`.

---

## Critical files

| File | Change |
|---|---|
| `bot/src/peoplePanel.ts` | open-once + MutationObserver implementation |
| `bot/src/selectors.ts` (lines 79, 81-95) | `data-audio-level`-based active-speaker, `[aria-label="Participants"]` panel |
| `bot/src/activeSpeaker.ts` | switch to MutationObserver + tile→participant-id join |
| `bot/src/index.ts` (lines 200-232) | drop 30 s setInterval; add roster-binding handler; final scrape on shutdown |
| `worker/src/reconcile.ts` (lines 50-187) | Hungarian assignment; turn-driven row builder |
| `worker/src/sarvam.ts` | persist words to DB |
| `worker/src/turnAlign.ts` (new) | word→turn aligner |
| `worker/src/renderTranscript.ts` (new) | wall-clock `[HH:MM AM/PM] Name: text` formatter |
| `worker/src/finalize.ts:471-477` | feed renderer output to OpenAI summary input |
| `api/` route `GET /sessions/:id` | expose `transcript_text` in response body |
| `db/migrations/0002_word_timestamps.sql` (new) | `words jsonb` column on `transcript_segments` |
| `db/migrations/0003_transcript_final_cluster.sql` (new) | `cluster` column on `transcript_final` |
| `db/migrations/0004_transcript_final_rendered_view.sql` (new) | `text_line` view for `psql` reads |

## Reuse, don't rebuild

- `__renatePushCaption` binding pattern (`bot/src/captions.ts:28-37`) → mirror for roster + reuse for tile.
- 3-tier name extractor in `peoplePanel.ts:113-149` → keep as fallback when `aria-label` on a row is missing.
- Existing `participantCount` reader (`bot/src/index.ts:57-77`) reading the People-button aria-label is already a "live count" oracle — use it as a sanity check against observer state.
- `worker/src/reconcile.ts:130-142` token-prefix canonicaliser → keep, just call it inside the assignment loop instead of after.

## Verification

End-to-end test against a real call (TEST_COMMANDS.md flow):

1. Apply migrations, rebuild bot + worker images: `docker compose build bot worker && docker compose --profile bot build`.
2. Start a 5-min Meet with 3 humans + bot. Have one human join 90 s late and stay silent for 60 s after joining.
3. Live checks during the call:
   - `redis-cli GET session:<sid>:roster` → reflects all 4 names within 5 s of the late join (target: < 2 s).
   - `redis-cli XLEN active_speaker:<sid>` → > 0, growing as people speak.
4. After call ends + finalize completes:
   - `SELECT count(*) FROM transcript_final WHERE session_id=$1` → ≥ 1 row per diarize turn (typically 30+ for a 5-min 3-speaker call), not 2.
   - `SELECT count(DISTINCT speaker_name) FROM transcript_final WHERE session_id=$1` → 3 (or whatever distinct cluster count diarize reported).
   - `SELECT speaker_name, length(text) FROM transcript_final ORDER BY start_ts LIMIT 20` — visually scan: alternating speakers, short interjections preserved.
   - `curl /sessions/<sid> | jq -r .transcript_text | head -10` → output matches the `[HH:MM AM/PM] Name: text` spec exactly: AM/PM present, no seconds, single space after colon, one turn per line.
5. Replay the broken `225bc5ed` session via `scripts/smoke-finalize.ts` → asserts the same expectations on archived audio. Locks in the regression.
