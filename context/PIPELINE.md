# Pipeline & Architecture

## End-to-end data flow (per session)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ POST /sessions {meetUrl}                                                │
│   ↓ (api/src/index.ts)                                                  │
│ INSERT INTO sessions (…, status='queued') → enqueue spawn-bot           │
└─────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼  (BullMQ: spawn-bot queue)
┌─────────────────────────────────────────────────────────────────────────┐
│ worker/src/spawnBot.ts                                                  │
│   picks a bot_account (LRU) → docker run renate-bot:latest              │
│   bind-mounts auth/<email>.auth.json → /auth/auth.json                  │
│   container labels: renate.session_id=…, renate.bot_account=…           │
└─────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼  (docker daemon)
┌─────────────────────────────────────────────────────────────────────────┐
│ Per-session bot container (ephemeral, one per call)                     │
│                                                                         │
│   entrypoint.sh → Xvfb :99 → PulseAudio null-sink "meet_sink"           │
│   ▼                                                                     │
│   node dist/src/index.js (bot/src/index.ts)                             │
│   ├─ joinMeetWithRetry  — headful Chromium + storageState auth          │
│   │     mic/cam muted, join clicked, "Leave call" btn = ready signal    │
│   ├─ startAudioCapture — ffmpeg taps meet_sink.monitor →                │
│   │                       28s PCM WAV chunks → MinIO ('sessions/{sid}/  │
│   │                       chunks/chunk_NNNNN.wav') → enqueue            │
│   │                       transcribe-chunk                              │
│   ├─ attachCaptionObserver — MutationObserver on Meet captions          │
│   │                           (when visible) → Redis XADD               │
│   │                           captions:{sid}                            │
│   ├─ attachActiveSpeakerObserver — Web Audio AnalyserNode on every      │
│   │                                 <audio>/<video> in the page;        │
│   │                                 emits {name, tStart, tEnd} per      │
│   │                                 speaker-turn → Redis XADD           │
│   │                                 speakers:{sid}                      │
│   ├─ dumpMeetDom — one-shot DOM + a11y-tree dump at t+15s               │
│   │                to /chunks/debug_dom.json for selector tuning        │
│   ├─ startHeartbeat — SET session:{sid}:alive EX 30 every 10s           │
│   └─ waitForCallEnd — Promise.race: alone-banner, count=1,              │
│                       leave-btn missing, URL change, hard timeout       │
│                                                                         │
│   On end signal → enqueueFinalize(sid, endSignal, participantCount)     │
│                 → shutdown (stop observers, leaveMeet, exit)            │
└─────────────────────────────────────────────────────────────────────────┘
          │                          │                          │
          ▼                          ▼                          ▼
  chunks (WAV)               captions:{sid}              speakers:{sid}
  transcribe-chunk jobs       (Redis stream)              (Redis stream)
          │
          ▼  (worker consumes in parallel, N=3)
┌─────────────────────────────────────────────────────────────────────────┐
│ worker/src/sarvam.ts                                                    │
│   GET chunk from MinIO → POST to Sarvam saarika:v2.5 → word timings     │
│   → INSERT INTO transcript_segments                                     │
└─────────────────────────────────────────────────────────────────────────┘

 …audio chunks transcribed in parallel while call is live.

 When bot's finalize job is picked up by worker:
          │
          ▼  (BullMQ: finalize queue)
┌─────────────────────────────────────────────────────────────────────────┐
│ worker/src/finalize.ts                                                  │
│   1. status = 'finalizing'                                              │
│   2. drainCaptionStream + drainSpeakerStream → merged nameEvents        │
│      persistDomCaptions (captions only)                                 │
│   3. resolve speaker-count hint:                                        │
│        distinct names in nameEvents  → use as num_speakers              │
│        else participantCount - 1     → use as num_speakers              │
│        else (min=2, max=6)           → range band                       │
│   4. assembleSessionWav: list+download chunks from MinIO →              │
│      ffmpeg -f concat → upload sessions/{sid}/full.wav                  │
│   5. callDiarize(diarize/, fullKey, {numSpeakers | min/max})            │
│      ├─ diarize sidecar: FoxNoseTech/diarize (ONNX CPU, ~8x realtime)   │
│      └─ returns list of {startTs, endTs, cluster}                       │
│   6. reconcileSpeakers(turns, nameEvents)                               │
│      → cluster → name map by temporal overlap                           │
│      unresolved clusters get friendly "Speaker 1", "Speaker 2" labels   │
│   7. insertSpeakerTurns (with resolved_name attached)                   │
│   8. loadSegments → mergeSegmentsWithSpeakers → writeFinalTranscript    │
│   9. summarize via OpenAI gpt-4.1-mini → UPDATE sessions.summary_md     │
│   10. DEL captions:{sid}, speakers:{sid}, session:{sid}:alive           │
│   11. status = 'complete'                                               │
└─────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                   GET /sessions/:id → full session row
```

## Service responsibilities (docker-compose.yml)

| Service | Lifecycle | Image | Purpose |
|---|---|---|---|
| `postgres` | long-lived | `postgres:16-alpine` | sessions, transcript_segments, transcript_final, speaker_turns, dom_captions, bot_accounts |
| `redis` | long-lived | `redis:7-alpine` | BullMQ backend, caption + speaker streams, heartbeats |
| `minio` | long-lived | `minio/minio:latest` | S3-compatible object store for audio chunks + assembled full.wav |
| `api` | long-lived | `renate-transcription-bot-api` | Fastify: POST /sessions, GET /sessions/:id, /healthz |
| `worker` | long-lived | `renate-transcription-bot-worker` | BullMQ consumers: spawn-bot, transcribe-chunk, finalize. Has ffmpeg for WAV concat. |
| `diarize` | long-lived | `renate-transcription-bot-diarize` | FastAPI sidecar; FoxNoseTech/diarize lib; models cached in `diarize-cache` volume |
| `bot` | **ephemeral, per session** | `renate-bot:latest` | Playwright + Xvfb + PulseAudio + ffmpeg; joins one Meet, captures audio + DOM, exits |

`bot` is declared in compose with `profiles: ["bot"]` so `docker compose up` doesn't start it — the worker spawns one per session via the docker socket.

## File-by-file map

### Bot (`bot/src/`)

| File | Role |
|---|---|
| `index.ts` | Orchestrator: config → redis → joinMeet → startAudio → attachCaptions → attachActiveSpeaker → dumpDebugDom (t+15s) → waitForCallEnd → enqueueFinalize → shutdown |
| `config.ts` | Zod schema for all env vars incl. `SESSION_ID`, `MEET_URL`, `AUTH_PROFILE`, `DISPLAY_NAME` |
| `join.ts` | Playwright join/leave + stealth init scripts (`navigator.webdriver=false` etc.). Headful Chromium inside Xvfb. |
| `selectors.ts` | All Meet DOM selectors in one file. |
| `audio.ts` | Spawns ffmpeg with pulse source → 28s segmented WAV → MinIO → BullMQ enqueue per chunk |
| `captions.ts` | `page.exposeBinding` + in-page MutationObserver on caption DOM; emits to Redis via `pushCaption` |
| `activeSpeaker.ts` | **NEW (2026-04-21).** Per-tile Web Audio API AnalyserNode; voting/locking; emits via `pushSpeaker` |
| `debug.ts` | One-shot DOM + a11y-tree dump to `/chunks/debug_dom.json` for selector tuning |
| `endDetect.ts` | `Promise.race` on: alone-banner, count=1, leave-btn missing ≥5s, URL change, hard timeout |
| `state.ts` | Redis client + `pushCaption`, `pushSpeaker`, `startHeartbeat` |
| `scripts/generate-auth.ts` | One-time manual Google login → saves `storageState` to `auth/auth.json` |
| `docker/entrypoint.sh` | Bootstraps Xvfb :99 + PulseAudio daemon + null-sink `meet_sink`, then execs node |

### Worker (`worker/src/`)

| File | Role |
|---|---|
| `index.ts` | BullMQ Worker for spawn-bot, transcribe-chunk, finalize. Scoped child-loggers. |
| `config.ts` | Zod env schema (incl. DIARIZE_URL, BOT_IMAGE, BOT_NETWORK, AUTH_HOST_PATH) |
| `spawnBot.ts` | dockerode: picks LRU bot_account, `docker create` + start with per-session env + auth bind-mount |
| `sarvam.ts` | POST WAV to `api.sarvam.ai/speech-to-text` (model `saarika:v2.5`); word-grouped output |
| `finalize.ts` | The big one. drainCaption + drainSpeaker → speaker-count hint → assembleSessionWav (ffmpeg concat) → callDiarize → reconcile → writeFinalTranscript → summarize → complete |
| `reconcile.ts` | `reconcileSpeakers(turns, nameEvents)` temporal-overlap mapping; `mergeSegmentsWithSpeakers` groups same-speaker adjacent segments |
| `summarize.ts` | OpenAI `gpt-4.1-mini` with 3-section prompt (Summary / Key Points / Action Items) |
| `s3.ts` | MinIO client + `ensureBucket`, `putAudioChunk`, `getAudioChunk` |
| `persist.ts` | Postgres writes: insertTranscriptSegments, insertSpeakerTurns, persistDomCaptions, writeFinalTranscript, updateSessionStatus |

### API (`api/src/`)

| File | Role |
|---|---|
| `index.ts` | Fastify: `GET /healthz`, `POST /sessions` (inserts + enqueues), `GET /sessions/:id` |
| `config.ts` | Zod env schema |

### Diarize (`diarize/src/`)

| File | Role |
|---|---|
| `main.py` | FastAPI: `/healthz` reports `pipeline_loaded`, `/diarize` accepts `{session_id, s3_key, num_speakers, min/max_speakers}` |
| `pyannote_runner.py` | Kept filename for stability. Uses **`diarize.diarize`** from FoxNoseTech/diarize lib (NOT pyannote). ONNX + sklearn, auto-downloads models to `/root/.cache/diarize`. |
| `config.py` | pydantic-settings: HF_TOKEN (unused now), S3 creds, log level |

### Database (`db/migrations/`)

`0001_init.sql` — auto-loaded by postgres on first boot. Tables: `sessions`, `transcript_segments`, `dom_captions`, `speaker_turns`, `transcript_final`, `bot_accounts`. All have `session_id` FK with `ON DELETE CASCADE`.

## Queue/stream topology (Redis)

| Key | Producer | Consumer | Shape |
|---|---|---|---|
| `bull:spawn-bot:*` | `api` | `worker` | job `{sessionId, meetUrl, botAccountId?}` |
| `bull:transcribe-chunk:*` | `bot/audio.ts` | `worker` | job `{sessionId, chunkIdx, s3Key, sampleRate}` |
| `bull:finalize:*` | `bot/index.ts` (+ SIGTERM fallback) | `worker` | job `{sessionId, endSignal, participantCount?}` |
| `captions:{sid}` (XADD stream) | `bot/captions.ts` | `worker/finalize.ts:drainCaptionStream` | fields: speaker, text, tStart, tEnd |
| `speakers:{sid}` (XADD stream) | `bot/activeSpeaker.ts` | `worker/finalize.ts:drainSpeakerStream` | fields: name, tStart, tEnd |
| `session:{sid}:alive` (SET EX 30) | `bot/state.ts:startHeartbeat` | (health checks, unused atm) | epoch-ms string |

**Important:** BullMQ custom `jobId` must not contain `:` — all separators are `-`. Example: `spawn-${uuid}`, `${sid}-chunk-${idx}`, `${sid}-finalize`.
