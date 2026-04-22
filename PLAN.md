# Renate — Google Meet Transcription Bot

Self-hosted bot that joins a Google Meet as a headless participant, captures audio + DOM captions in real time, transcribes with Sarvam, diarizes with pyannote (anchored on Meet's own speaker labels), and delivers a structured transcript + GPT-4.1-mini summary when the call ends.

**Status:** scaffolding not yet executed. This document is the approved blueprint — confirm/adjust before each phase starts.

---

## 1. Stack (confirmed 2026-04-20)

| Layer | Choice |
|---|---|
| Bot runtime | Node.js + Playwright (headless Chromium) |
| Audio capture | PulseAudio virtual sink → FFmpeg (30s PCM/WAV chunks) |
| Transcription | Sarvam (chunked batch for v1, streaming later if needed) |
| Diarization | pyannote.audio (Python sidecar, FastAPI) |
| Caption scrape | Playwright `MutationObserver` on Meet's DOM caption container |
| Live buffer | Redis (BullMQ + caption stream + bot heartbeat) |
| Final store | Postgres (sessions, segments, reconciled transcript) |
| Raw audio | S3-compatible (MinIO in dev) |
| Summarization | OpenAI `gpt-4.1-mini` |
| Orchestration | BullMQ; **one Docker container per bot session** |
| Dev/run | `docker-compose` v0, cloud port later |

---

## 2. Confirmed architectural decisions

1. **Hybrid audio + DOM transcript.** Sarvam on audio is the authoritative transcript; DOM caption MutationObserver provides speaker-tagged anchors for diarization. Rejected pure-DOM (Recall's OSS pattern) because we want raw audio + Sarvam language flexibility. Rejected audio-only because pyannote alone is noisy on mixed meeting audio.
2. **Multi-signal call-end detection** (`Promise.race`): participant count = 1, "You're the only one here" banner, "Leave call" button missing, hard timeout. Every new signal is *added* to the race, never replaces an existing one. Hard timeout is the floor, never removed.
3. **Chunked batch Sarvam (v1).** ~30s chunks, parallel batch calls. Simpler than streaming, cheaper, near-real-time enough. Upgrade path to streaming only if a live-transcript UI is later required.
4. **Local docker-compose first.** Per-session container model already matches the production shape; cloud port = lift-and-shift.

---

## 3. Component topology

```
                        ┌─────────────────────────────────────────┐
                        │          docker-compose (dev)            │
                        └─────────────────────────────────────────┘
      POST /sessions
      ──────────────▶ ┌────────┐
                      │  api   │  (thin Node control plane)
                      └────┬───┘
                           │ enqueue spawn-bot
                           ▼
                      ┌────────┐        ┌──────────────┐
                      │ redis  │◀──────▶│    worker    │  (Node + BullMQ)
                      │(BullMQ)│        │  long-lived  │
                      └────┬───┘        └──┬────────┬──┘
                           │               │        │
                           │  spawn-bot    │        │  transcribe-chunk
                           │  (docker run) │        ▼
                           ▼               │   ┌─────────┐
                 ┌────────────────────┐    │   │ Sarvam  │ (batch ASR)
                 │  bot (per-session) │    │   └─────────┘
                 │  ephemeral         │    │
                 │                    │    │  finalize
                 │  ┌──────────────┐  │    ▼
                 │  │ Playwright   │  │  ┌──────────┐    ┌────────────┐
                 │  │ Chromium     │──┼─▶│ diarize  │──▶│   OpenAI   │
                 │  │ (auth.json)  │  │  │ FastAPI  │    │ gpt-4.1-mini│
                 │  └───────┬──────┘  │  │ pyannote │    └────────────┘
                 │          │ webrtc  │  └────┬─────┘
                 │          ▼ audio   │       │
                 │  ┌──────────────┐  │       ▼
                 │  │ PulseAudio   │  │  ┌──────────┐
                 │  │ virtual sink │  │  │ postgres │ ← final truth
                 │  └───────┬──────┘  │  └──────────┘
                 │          │         │       ▲
                 │          ▼         │       │
                 │  ┌──────────────┐  │       │
                 │  │  ffmpeg      │──┼───┐   │
                 │  │  30s WAV     │  │   │   │
                 │  │  chunker     │  │   ▼   │
                 │  └──────────────┘  │  ┌─────────┐
                 │                    │  │  minio  │ (raw WAV archive, S3 API)
                 │  MutationObserver──┼─▶│ captions│
                 │  (DOM captions)    │  └─────────┘
                 └────────────────────┘
                           │ writes → redis streams (captions, heartbeat)
```

---

## 4. Service responsibilities

| Service | Lifecycle | Job |
|---|---|---|
| `api` | long-lived | `POST /sessions` creates row, enqueues `spawn-bot` |
| `worker` | long-lived | Consumes BullMQ: spawns bot containers, runs Sarvam chunks, runs finalize |
| `bot` | **ephemeral, one per call** | Playwright join/leave, audio capture, DOM caption scrape, end-signal race |
| `diarize` | long-lived | FastAPI: `POST /diarize` with S3 WAV key → pyannote speaker turns |
| `postgres` | long-lived | Source of truth (sessions, segments, final transcript, bot accounts) |
| `redis` | long-lived | BullMQ backing + live caption stream + bot heartbeat |
| `minio` | long-lived | S3-compatible raw audio archive |

---

## 5. End-to-end pipeline

1. **Session create** — `POST /sessions {meetUrl, botAccountId?, metadata}` → `sessions` row (status=`queued`) → enqueue `spawn-bot`.
2. **Bot spawn** — Worker `docker run`s a fresh bot container with `SESSION_ID`, `MEET_URL`, `AUTH_PROFILE` mounted; PulseAudio + Playwright boot inside.
3. **Join** — Load `auth.json`, navigate to Meet URL, mic/cam off, click join, wait for "Leave call" button. Fail path: exit non-zero → BullMQ retry with next bot account.
4. **Parallel capture (lifetime of call):**
   - **Audio:** FFmpeg taps PulseAudio monitor → 30-second WAV chunks → upload to MinIO → enqueue `transcribe-chunk` per chunk.
   - **Captions:** `page.evaluate` injects MutationObserver on caption container → `exposeBinding` pushes `{speaker, text, tStart, tEnd}` → `XADD captions:{sessionId}`.
   - **Heartbeat:** `SET session:{id}:alive EX 30` every 10s.
5. **Transcribe (parallel worker jobs)** — Worker consumes `transcribe-chunk` → downloads WAV → Sarvam batch → inserts `transcript_segment` rows.
6. **End detection** — Bot runs `Promise.race`:
   - participant count = 1
   - "You're the only one here" banner visible
   - "Leave call" button absent > 5s
   - hard timeout (default 120 min)
7. **Bot shutdown** — Flush caption stream, FFmpeg closes current chunk, enqueue `finalize`, Playwright leaves Meet cleanly, container exits.
8. **Finalize (worker):**
   - Wait for all `transcribe-chunk` jobs for the session to drain.
   - Assemble concatenated WAV in MinIO.
   - `POST` to `diarize` → pyannote speaker clusters.
   - Read DOM captions from Redis stream.
   - **Reconcile:** for each pyannote cluster, find DOM-caption name with maximum temporal overlap → name-map the cluster. DOM wins on conflict.
   - Merge `transcript_segments` (Sarvam words) + reconciled speakers → write `transcript_final` rows.
   - Pull final transcript → OpenAI `gpt-4.1-mini` → store summary on `sessions.summary_md`.
   - Set `sessions.status=complete`, delete Redis session keys.

---

## 6. Storage shapes (proposed — confirm before Phase 4)

```sql
sessions(
  id, meet_url, bot_account_id, status,
  started_at, ended_at, duration_s,
  summary_md, metadata jsonb
)

transcript_segments(              -- raw Sarvam output
  id, session_id, chunk_idx,
  start_ts, end_ts,
  raw_text, confidence, sarvam_request_id
)

dom_captions(                     -- MutationObserver output
  id, session_id,
  start_ts, end_ts,
  speaker_name, text
)

speaker_turns(                    -- pyannote output
  id, session_id,
  start_ts, end_ts, pyannote_cluster
)

transcript_final(                 -- reconciled (end artifact)
  id, session_id,
  start_ts, end_ts,
  speaker_name, text
)

bot_accounts(
  id, email, auth_path,
  last_used_at, cooldown_until
)
```

**Redis keys:** `bull:*` (queues), `captions:{sid}` (stream), `session:{sid}:alive` (heartbeat).

---

## 7. Failure handling

| Failure | Response |
|---|---|
| Join fails (CAPTCHA / lobby reject) | Non-zero exit → BullMQ retry with next `bot_account` |
| Sarvam chunk fails | 3x retry with backoff → dead-letter queue; finalize proceeds with gaps |
| pyannote OOM / crash | Finalize falls back to DOM-only speaker attribution (graceful degrade) |
| Bot crashes mid-call | Heartbeat TTL expires → worker triggers partial finalize on whatever persisted |
| Google changes DOM class names | DOM scraper + end-signals isolated behind a `selectors` module → single-file fix |

---

## 8. Build order (each phase requires confirmation before starting)

| Phase | Deliverable | Gate |
|---|---|---|
| **0. Scaffold** | Repo layout, Dockerfiles, `docker-compose.yml`, env config, `generate-auth.ts` login helper. No Meet logic. | — |
| **1. Join/leave** | Playwright joins a given Meet URL with stored `auth.json`, mic/cam off, detects join success, leaves cleanly. | User-provided Google account credentials |
| **2. Audio pipeline** | PulseAudio virtual sink in-container, FFmpeg tap, 30s WAV chunks to MinIO, PCM buffer to Redis. End-to-end audio quality verified. | — |
| **3. DOM captions** | MutationObserver injection, speaker-tagged segments streamed to Redis alongside audio. | — |
| **4. Sarvam transcription** | Worker consumes `transcribe-chunk` jobs, writes `transcript_segment` rows. | Postgres schema confirmed; Sarvam API key |
| **5. Diarization + reconciliation** | pyannote sidecar; finalize reconciles clusters with DOM names; writes `transcript_final`. | HuggingFace token for pyannote models |
| **6. Call-end + summary** | Multi-signal `Promise.race`; on end, flush buffers, call GPT-4.1-mini, write summary to session row. | OpenAI API key |
| **7. BullMQ + per-session isolation** | `docker run` per call via host socket, account rotation, retry/backoff. | — |
| **8. Observability + anti-detection** | Structured logs, tracing, stealth UA, exponential backoff on rejoin. | — |

---

## 9. Open questions to resolve before the gates they block

| Gate | Question | Default if unanswered |
|---|---|---|
| Phase 1 | Which Google account? Is it Workspace or consumer? Does it need 2FA workaround? | — (blocker) |
| Phase 4 | Confirm Postgres schema in §6 as-is, or changes? | Ship as §6 |
| Phase 5 | Pool of bot accounts for rotation, or single account for v1? | Single account |
| Phase 6 | Deliver results by webhook or poll-only? | Poll-only (`GET /sessions/:id`) |
| Phase 6 | Raw WAV retention in MinIO — forever, 30d, 90d? | 30d TTL |
| Phase 7 | Target cloud for later port (AWS/GCP/Hetzner)? | Hetzner (cost) |

---

## 10. Proposed repo layout (Phase 0 scaffold target)

```
renate-transcription-bot/
├── PLAN.md                          (this file)
├── docker-compose.yml
├── .env.example
├── .gitignore
├── package.json                     (root workspace)
├── bot/                             Node + Playwright (per-session container)
│   ├── Dockerfile                   playwright base + pulseaudio + ffmpeg
│   ├── package.json
│   ├── tsconfig.json
│   ├── scripts/
│   │   └── generate-auth.ts         one-time manual Google login → auth.json
│   └── src/
│       ├── index.ts                 orchestrator entrypoint
│       ├── config.ts                env schema (zod)
│       ├── join.ts                  Playwright join/leave
│       ├── captions.ts              MutationObserver injection
│       ├── audio.ts                 PulseAudio + FFmpeg control
│       ├── endDetect.ts             Promise.race signals
│       ├── state.ts                 Redis writes (streams + heartbeat)
│       └── selectors.ts             isolated DOM selector module
├── worker/                          Node + BullMQ (long-lived)
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                 queue consumer
│       ├── config.ts
│       ├── spawnBot.ts              docker run per session
│       ├── sarvam.ts                chunked batch ASR
│       ├── finalize.ts              diarize → reconcile → summary → persist
│       ├── reconcile.ts             pyannote↔DOM merge
│       ├── summarize.ts             OpenAI gpt-4.1-mini
│       ├── persist.ts               Postgres writes
│       └── s3.ts                    MinIO client
├── diarize/                         Python + FastAPI + pyannote
│   ├── Dockerfile
│   ├── pyproject.toml
│   └── src/
│       ├── main.py                  FastAPI app
│       ├── config.py
│       └── pyannote_runner.py
├── api/                             Node thin control plane
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.ts                 POST /sessions, GET /sessions/:id
│       └── config.ts
└── db/
    └── migrations/                  (empty until Phase 4 schema lock)
```

---

## 11. References

- [How I built an in-house Google Meet bot — Recall.ai](https://www.recall.ai/blog/how-i-built-an-in-house-google-meet-bot)
- [recallai/google-meet-meeting-bot (GitHub)](https://github.com/recallai/google-meet-meeting-bot)
- [Fireflies Google Meet SDK integration](https://guide.fireflies.ai/articles/3309351579-integrate-google-meet-sdk-with-fireflies-for-bot-free-meeting-recording)
- [Vexa — open-source self-hosted meeting bot API](https://vexa.ai)
- [Sarvam AI docs](https://docs.sarvam.ai)
- [pyannote.audio](https://github.com/pyannote/pyannote-audio)
- [BullMQ docs](https://docs.bullmq.io)
