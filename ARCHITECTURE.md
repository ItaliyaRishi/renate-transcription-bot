# Renate Transcription Bot — Architecture (2026-04-24)

Self-hosted Google Meet transcription + summarization. No Google APIs. Speaker
attribution comes from DOM signals inside the Meet tab plus pyannote
diarization.

---

## Services (docker-compose)

| Service    | Image / Build        | Role                                                                 | Ports (host) |
|------------|----------------------|----------------------------------------------------------------------|--------------|
| `postgres` | postgres:16-alpine   | Sessions, transcripts, speaker turns, roster cache                   | 5432         |
| `redis`    | redis:7-alpine       | BullMQ queues + Redis streams for live signals                       | 6379         |
| `minio`    | minio/minio:latest   | S3-compatible audio object store                                     | 9000, 9001   |
| `api`      | `api/Dockerfile`     | HTTP API — `POST /sessions`, `GET /sessions/:id`                     | 3000         |
| `worker`   | `worker/Dockerfile`  | BullMQ consumer — spawns bots, transcribes chunks, finalizes calls   | —            |
| `diarize`  | `diarize/Dockerfile` | pyannote sidecar — POST /diarize (HF_TOKEN in env)                   | 8000         |
| `bot`      | `bot/Dockerfile`     | Ephemeral — one container per Meet session, spawned by worker        | —            |

The worker has `/var/run/docker.sock` mounted so it can `docker run` a fresh
`renate-bot:latest` container for each session. Bots never restart — they live
exactly as long as the call.

---

## End-to-end pipeline

```
POST /sessions
      │
      ▼
┌──────────────┐    BullMQ: spawn-bot    ┌───────────────────────────────┐
│     api      │────────────────────────▶│            worker             │
└──────────────┘                         └──────────────┬────────────────┘
                                                        │ docker run
                                                        ▼
                                         ┌───────────────────────────────┐
                                         │  bot (per-session container)  │
                                         │  ─────────────────────────    │
                                         │  Xvfb + PulseAudio null-sink  │
                                         │  Chromium (Playwright)        │
                                         │  ffmpeg → 28s WAV chunks      │
                                         └──────────────┬────────────────┘
                                                        │
                        ┌───────────────────────────────┼───────────────────────────────┐
                        │                               │                               │
                        ▼                               ▼                               ▼
               ┌─────────────────┐             ┌────────────────┐             ┌────────────────┐
               │  audio chunks   │             │ caption events │             │ active-speaker │
               │  → S3 (MinIO)   │             │ (badge + text) │             │ tile (5 Hz)    │
               │                 │             │  → Redis xadd  │             │  → Redis xadd  │
               └────────┬────────┘             └────────┬───────┘             └────────┬───────┘
                        │                               │                              │
                        │ BullMQ: transcribe-chunk      │                              │
                        ▼                               │                              │
               ┌─────────────────┐                      │                              │
               │     worker      │                      │                              │
               │   → Sarvam      │                      │                              │
               │   saaras:v3     │                      │                              │
               │   mode=translate│                      │                              │
               │                 │                      │                              │
               │  transcript_    │                      │                              │
               │  segments (pg)  │                      │                              │
               └────────┬────────┘                      │                              │
                        │                               │                              │
                        └─ (on SIGTERM / end-of-call ───┴──────────────────────────────┘
                           → bot enqueues BullMQ: finalize)
                                                        │
                                                        ▼
                                         ┌───────────────────────────────┐
                                         │       worker: finalize        │
                                         │  ─────────────────────────    │
                                         │  1. concat session audio      │
                                         │  2. POST /diarize → clusters  │
                                         │  3. drain caption + tile      │
                                         │     streams → nameEvents      │
                                         │  4. resolveClusterNames()     │
                                         │  5. mergeSegmentsWithSpeakers │
                                         │  6. summarize (OpenAI)        │
                                         │  7. write transcript_final +  │
                                         │     speaker_turns + summary   │
                                         └──────────────┬────────────────┘
                                                        ▼
                                             sessions.status = 'complete'
```

---

## Signals fused in finalize

| Signal                   | Source                                    | Written to                        |
|--------------------------|-------------------------------------------|-----------------------------------|
| Audio chunks             | PulseAudio null-sink → ffmpeg (28 s WAV)  | S3 `renate-audio/sessions/<id>/`  |
| Transcript segments      | Sarvam Saaras v3 (`translate` mode)       | `transcript_segments` (pg)        |
| Caption badge + text     | MutationObserver on Meet caption DOM      | Redis stream `captions:<id>`      |
| Active-speaker name      | 5 Hz DOM poll (tile highlight → name)     | Redis stream `active_speaker:<id>`|
| Roster (human names)     | People-panel scrape, scoped + filtered    | Redis `session:<id>:roster`       |
| `expectedSpeakers` hint  | Optional `metadata` on POST /sessions     | `sessions.metadata` (pg)          |

### Reconciliation (`worker/src/reconcile.ts`)

`resolveClusterNames(turns, nameEvents, roster)`:

1. Build per-cluster `{caption, tile}` tallies for every `NameEvent` whose
   `tSec` lands inside one of the cluster's diarization turns.
2. Winner per cluster = argmax of `caption × 2 + tile × 1`.
3. Canonicalize the winner against `roster`: a ≥ 3-char token-prefix that
   matches exactly one roster entry is rewritten to that entry. Multiple
   matches → keep the raw winner.
4. Clusters with no evidence take unused roster entries in first-appearance
   order.
5. Still unresolved → `Speaker 1`, `Speaker 2`, …

`mergeSegmentsWithSpeakers` then assigns each Sarvam segment to the cluster
with maximum temporal overlap, merging adjacent same-speaker segments when
the gap is < 2.5 s.

---

## Postgres schema (`db/migrations/0001_init.sql` + `0003_*`)

```
bot_accounts(id, email, auth_path, last_used_at, cooldown_until)
sessions(id, meet_url, bot_account_id, status, started_at, ended_at,
         duration_s, summary_md, metadata, created_at, updated_at)
transcript_segments(id, session_id, chunk_idx, start_ts, end_ts,
                    raw_text, confidence, sarvam_request_id)
dom_captions(id, session_id, start_ts, end_ts, speaker_name, text)
speaker_turns(id, session_id, start_ts, end_ts, pyannote_cluster,
              resolved_name)
transcript_final(id, session_id, start_ts, end_ts, speaker_name, text)
```

`workspace_credentials` was dropped in migration `0003` — no Google API
surface is used.

---

## BullMQ queues

| Queue               | Producer      | Consumer    | Job shape                                                                     |
|---------------------|---------------|-------------|-------------------------------------------------------------------------------|
| `spawn-bot`         | api           | worker      | `{ sessionId, meetUrl }` → `docker run renate-bot:latest`                     |
| `transcribe-chunk`  | bot (per chunk) | worker    | `{ sessionId, chunkIdx, s3Key }` → Sarvam → `transcript_segments`             |
| `finalize`          | bot (on end)  | worker      | `{ sessionId, endSignal, participantCount }` → diarize + merge + summarize    |

Per-session `transcribe-chunk` jobs use `jobId = <sessionId>-chunk-<idx>` so
the shutdown drain can select only this session's pending jobs.

---

## Redis streams + keys (per session)

- `captions:<sessionId>` — caption badge + text, 50k MAXLEN ring
- `active_speaker:<sessionId>` — tile-highlight name changes, 50k MAXLEN
- `session:<sessionId>:roster` — JSON list of scraped participant names
- `session:<sessionId>:heartbeat` — bot liveness, 30 s TTL, refreshed every 10 s

Finalize `DEL`s all four after persisting to Postgres.

---

## Bot internals (per-session container)

- `Xvfb :99` + `PulseAudio` null-sink (`meet_sink`) set up by
  `bot/docker/entrypoint.sh`.
- Chromium launched via Playwright with backgrounding throttles disabled
  (`--disable-renderer-backgrounding`,
  `--disable-background-timer-throttling`,
  `--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion`,
  `--disable-background-media-suspend`).
- Audio: ffmpeg segment muxer with `-use_wallclock_as_timestamps 1` and a
  60 s watchdog that restarts ffmpeg from `lastSeenChunk + 1` if two
  consecutive chunks fall under 50 KB.
- DOM captures:
  - `captions.ts` — MutationObserver scoped to the caption container;
    rejects mutations whose ancestor is `role="button"` (filters "Jump to
    bottom").
  - `activeSpeaker.ts` — 5 Hz poll; 3 strategies for finding the active
    tile: `data-active-speaker="true"`, accent-blue border, `/active/` class
    token. Debounces to one event per name change.
  - `peoplePanel.ts` — scrapes the People panel; scopes to panel container,
    rejects `role="menuitem"` and spans inside `<button>` (filters
    "Show in a tile", "Pin to your screen", …).
- Shutdown: SIGTERM → stop observers + ffmpeg → drain transcribe-chunk for
  this session (≤ 45 s) → enqueue finalize → leave Meet. Entrypoint uses a
  double-`wait` so PID 1 blocks until Node's handler fully runs.

---

## Environment variables

### Worker (`worker/src/config.ts`)
```
DATABASE_URL                 postgres://renate:renate@postgres:5432/renate
REDIS_URL                    redis://redis:6379
S3_ENDPOINT                  http://minio:9000
S3_REGION                    us-east-1
S3_ACCESS_KEY                minioadmin
S3_SECRET_KEY                minioadmin
S3_BUCKET_AUDIO              renate-audio
S3_FORCE_PATH_STYLE          true
SARVAM_API_KEY               <secret>
SARVAM_MODEL                 saaras:v3
SARVAM_LANGUAGE_CODE         unknown
SARVAM_MODE                  translate
OPENAI_API_KEY               <secret>
OPENAI_SUMMARY_MODEL         gpt-4.1-mini
DIARIZE_URL                  http://diarize:8000
BOT_IMAGE                    renate-bot:latest
BOT_NETWORK                  renate-transcription-bot_renate
AUTH_HOST_PATH               ${PWD}/auth           (set by compose)
CALL_HARD_TIMEOUT_MIN        120
LOG_LEVEL                    info
```

### Bot (`bot/src/config.ts`)
```
SESSION_ID                   (injected by worker)
MEET_URL                     (injected by worker)
AUTH_PROFILE                 /auth/auth.json
REDIS_URL                    redis://redis:6379
S3_ENDPOINT                  http://minio:9000
S3_REGION                    us-east-1
S3_ACCESS_KEY                minioadmin
S3_SECRET_KEY                minioadmin
S3_BUCKET_AUDIO              renate-audio
S3_FORCE_PATH_STYLE          true
AUDIO_CHUNK_SECONDS          28
AUDIO_SAMPLE_RATE            16000
AUDIO_CHUNK_DIR              /chunks
PULSE_SOURCE                 meet_sink.monitor
HEARTBEAT_INTERVAL_MS        10000
HEARTBEAT_TTL_SECONDS        30
CALL_HARD_TIMEOUT_MS         7200000              (120 min)
DISPLAY_NAME                 Renate
LOG_LEVEL                    info
```

### Diarize sidecar
```
HF_TOKEN                     <secret>    required for pyannote weights
DIARIZE_PORT                 8000
```

### Host-only (`docker-compose.yml`)
```
API_PORT                     3000
POSTGRES_HOST_PORT           5432         (non-default in local .env: 54322)
REDIS_HOST_PORT              6379         (non-default in local .env: 63790)
MINIO_API_PORT               9000
MINIO_CONSOLE_PORT           9001
POSTGRES_USER / _PASSWORD / _DB           renate / renate / renate
```

---

## Session metadata

Callers can pass `metadata` at `POST /sessions`:

```json
{
  "meetUrl": "https://meet.google.com/abc-defg-hij",
  "metadata": { "expectedSpeakers": ["Rishi Italiya", "Candidate Name"] }
}
```

`expectedSpeakers` overrides the DOM-scraped roster for canonicalization.
Everything else in `metadata` is preserved verbatim but unused.

---

## Languages

Sarvam `saaras:v3` with `SARVAM_MODE=translate` and
`SARVAM_LANGUAGE_CODE=unknown`. Any supported language in → English out.
Transcript and summary are always English regardless of what participants
speak.

---

## What is intentionally not here

- No Google Meet REST API, no Google OAuth, no Calendar API, no
  `workspace_credentials` table.
- No LLM-based speaker-attribution corrector (Stage E in `PLAN.md` — deferred
  until data says we need it).
- No voice-biometric cross-session recognition.
