# Critical Gaps — Testing Scope Only

**Date:** 2026-04-23
**Scope:** Get a reliable END-TO-END test run: bot joins → captures full audio → produces full transcript with real speaker names → GPT summary → bot auto-leaves when alone. Nothing else. No deployment concerns (webhooks, retention, calendar, ATS, consent, metrics) in this pass.
**Keep:** current 3-signal attribution stack (captions → roster → `metadata.expectedSpeakers`).
**Target artifact on approval:** `/Users/italiyarishi/renate-transcription-bot/CRITICAL_GAPS.md` (copy of this file).

---

## What's proven working (don't touch)
- Join flow (Playwright + Xvfb + PulseAudio null-sink).
- Audio capture via ffmpeg chunking + S3/MinIO upload.
- FoxNoseTech diarize sidecar (ONNX CPU).
- GPT-4.1-mini summarization quality.
- Temporal-overlap reconciliation of diarizer clusters with DOM name events.
- Metadata override path (`expectedSpeakers`) — proven in session `f9bc6a3c`.

## What broke in the 2026-04-22 test run
Evidence from session `f9bc6a3c-fe68-4e4b-8fec-f929fb17de9c`:
- Bot stayed 5 min past call end; had to SIGTERM manually.
- SIGTERM killed the process before `finalize` was enqueued → required manual BullMQ push.
- Last audio chunk (13 of 14) was uploaded but never transcribed → ~30s lost.
- 9 of 14 chunks returned 0 Sarvam segments → large transcript gaps.
- Caption toggle never found → primary name signal unused.
- Roster scrape returned `"keep_outlinePin Rishi Italiya to your main screen…Rishi Italiya Rishi Italiya devices"` — only worked because metadata override masked the noise.
- `transcript_final` collapsed 28 diarized turns into 2 rows (one per speaker) → lost conversational structure.

---

## The 7 critical gaps, grouped by pipeline stage

### Stage A — Name signal (speaker attribution)

**G1. Caption enablement fails silently.** `bot/src/captions.ts::enableCaptions`.
Today's run: "captions toggle button not found" ×3 → hard error → primary signal dead.
Likely cause: Meet toolbar hides the CC button until mouse hover in just-joined state. Current code already retries 3× with post-click verification, but it never hovers or scrolls to make the control reachable.
Fix direction: before locating the toggle, move mouse into the meeting canvas (or `page.mouse.move` to the bottom toolbar area) to reveal controls. If still missing, try `document.querySelector('[jsname="r8qRAd"]')` existence as proxy for captions-off vs toggle-hidden.
Why it matters: captions are the ONLY signal that ties a name to a spoken utterance at a specific timestamp; roster + metadata are per-call lists without timestamps.

**G2. Roster extractor is noisy.** `bot/src/peoplePanel.ts::extractNames`.
aria-label on `[role="listitem"]` concatenates menu-button text. Current extraction grabs the whole aria-label, which on today's Meet UI produces `"keep_outlinePin <name> to your main screen…<name> <name> devices"`.
Fix direction: don't read the listitem aria-label. Instead, find the inner name element (Meet renders names inside a specific `<span>` child — pull it via `querySelector` inside `extractNames`). Fallback: if aria-label contains the name ≥2× as a substring, extract the longest shared token run.
Why it matters: without metadata override, roster is the ONLY fallback between caption-fail and "Speaker N". Today we lean on metadata as a crutch.

### Stage B — Audio → transcript completeness

**G3. Sarvam sparsity — 64% of chunks return 0 segments.** `worker/src/sarvam.ts`.
Saarika v2.5 defaults to `language_code="unknown"` in our code. Per Sarvam docs, `unknown` auto-detects but is the most lossy mode for multi-speaker / code-switched audio. Saarika v2.5 is also a **legacy model** — Sarvam recommends migrating to Saaras v3.
Fix directions (in order of impact):
  1. Set `language_code` per session via `sessions.metadata.language` (default `"hi-IN"` for Indian recruiter calls; `"en-IN"` or `"unknown"` overrideable).
  2. Migrate the ASR call to Saaras v3 (Sarvam's current flagship).
  3. Consider Sarvam Batch API for the post-call pass: submits a single audio file up to 1h, returns full diarized transcript. Use this as a FALLBACK when the per-chunk real-time path produces <50% coverage.
Why it matters: no amount of speaker-name work helps if the text content itself is missing.

**G4. Final audio chunk orphaned by SIGTERM.** `bot/src/audio.ts` shutdown path + `worker/src/index.ts` transcribe-chunk consumer.
ffmpeg rotates chunks every ~15s; last chunk may be uploaded but its `transcribe-chunk` job not yet drained when the bot receives SIGTERM.
Fix direction: in the bot shutdown handler, after `audio.stop()`, wait for the last `transcribe-chunk` job to reach `completed` (poll BullMQ with 30s deadline) BEFORE enqueueing `finalize`. Already fits the existing shutdown flow.
Why it matters: without this, transcripts are always tail-truncated by ~15–30s.

**G5. Transcript over-merging.** `worker/src/reconcile.ts::mergeSegmentsWithSpeakers`.
Current behavior groups ALL same-speaker segments regardless of gap → 28 diarized turns → 2 rows in `transcript_final`.
Fix direction: introduce a gap threshold (default 2.5s of silence). When the gap from the previous segment exceeds the threshold OR speaker changes, start a new row. Keep word-level timings intact.
Why it matters: a single-paragraph-per-speaker dump is unusable as a conversational transcript; the user wants to see turn-taking.

### Stage C — Finalization + auto-leave

**G6. SIGTERM → finalize race.** `bot/src/index.ts` shutdown handler.
Shutdown does `leaveMeet` + `audio.stop` + `transcribeQueue.close` before `enqueueFinalize` → Docker's 10s SIGTERM grace kills the process first. Today's session needed manual enqueue.
Fix direction: reorder shutdown — enqueue finalize IMMEDIATELY after audio.stop (before leaveMeet and queue closes). Also bump `docker-compose.yml` per-bot service `stop_grace_period: 60s`.
Why it matters: without this, every clean-exit and every force-stop ends with the session stuck in `joining`/`finalizing`.

**G7. End-detect never fires → no auto-leave.** `bot/src/endDetect.ts` + `bot/src/selectors.ts`.
Current selectors (`aloneBannerText`, `participantCountButton`) aren't triggering. Today the bot sat 5 min past the real end.
Fix direction: replace text-banner polling with two concrete checks on a 3s interval:
  1. Click the people-panel button once every 30s, count `[role="listitem"]` rows, close panel. If count ≤ 1 for two consecutive checks (≥60s sustained solitude), trigger shutdown.
  2. Listen for Meet's native "You're the only one here" banner via the `jsname` attribute (dump DOM once at t+30s to find the current jsname — the English text alone is locale-fragile).
  3. Fallback: if zero caption events received for 5 consecutive minutes AND roster size ≤1, assume alone.
Grace period: 30s after detection before leaving, to avoid false positives when participants rejoin briefly. (Recall.ai default: 2s `everyone_left.timeout` + 0s activate_after; we pick 30s for safety during testing.)
Why it matters: user wants full automation — no manual SIGTERM.

---

## Files to modify (complete list)

| File | Gap(s) | Change summary |
|---|---|---|
| `bot/src/captions.ts` | G1 | Hover toolbar before toggle lookup |
| `bot/src/peoplePanel.ts` | G2 | Extract name from inner span, not listitem aria-label |
| `worker/src/sarvam.ts` | G3 | `language_code` from session metadata; migrate model to Saaras v3 |
| `worker/src/index.ts` | G3 | Optional: Batch API fallback when chunk coverage <50% |
| `bot/src/audio.ts`, `bot/src/index.ts` | G4 | Wait for last transcribe-chunk job before finalize |
| `worker/src/reconcile.ts` | G5 | Gap-threshold turn-splitting in `mergeSegmentsWithSpeakers` |
| `bot/src/index.ts` | G6 | Enqueue finalize immediately after audio.stop |
| `docker-compose.yml` | G6 | `stop_grace_period: 60s` on per-bot service |
| `bot/src/endDetect.ts` | G7 | People-panel polling + banner jsname + no-captions fallback |
| `bot/src/selectors.ts` | G1, G7 | Add `aloneBanner` jsname (to be discovered from DOM dump) |

## Verification (single end-to-end test)

1. Start stack: `docker compose up -d`.
2. `POST /sessions` with `meetingUrl` + `expectedSpeakers: ["Rishi", "Vignesh"]` + `language: "hi-IN"`.
3. Watch bot logs: must see `captions enabled (verified)` and `roster scraped { names: [real names] }`.
4. Speak for ~5 min mixed Hindi/English.
5. All participants leave. Bot should auto-leave within 60s (not require manual SIGTERM).
6. Poll `GET /sessions/:id` — status should reach `complete` without manual finalize.
7. Query `transcript_final` — expect one row per turn (not one row per speaker).
8. Query `speaker_turns` — speaker names should all be real (no "Speaker 1/2").
9. Check `summary_md` — should reference correct names.
10. Spot-check audio coverage: count chunks written → count diarized speech seconds. Target >80% coverage of non-silent audio.

## Deferred (not in this pass)
R3 (debug.ts bundling crash), R9 (heartbeat consumer), P1–P8 (API/webhooks/retention/idempotency), C1–C10 (calendar/consent/ATS/analytics), O1–O5 (metrics/Sentry/correlation IDs/alerting). These are deployment concerns; the user is testing locally.

## Sources
- [Sarvam Saarika docs — models](https://docs.sarvam.ai/api-reference-docs/getting-started/models/saarika)
- [Sarvam Batch STT API](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/batch-api)
- [Recall.ai — automatic leaving behavior](https://docs.recall.ai/docs/automatic-leaving-behavior)
- [Recall.ai — Meet transcript DOM scraping](https://www.recall.ai/blog/how-to-get-transcripts-from-google-meet-developer-edition)
- [Recall.ai — Meet caption transcription](https://docs.recall.ai/docs/meeting-caption-transcription)
- [Google Meet native alone-timeout](https://www.neowin.net/news/google-meet-will-automatically-remove-you-from-meetings-if-you039re-the-only-one-there/)
