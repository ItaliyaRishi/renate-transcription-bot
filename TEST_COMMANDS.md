# Manual end-to-end test — live Meet → transcript + summary

All commands assume you're in the project root (`/Users/italiyarishi/renate-transcription-bot`).

---

## 0) One-time per box

```bash
# Ensure .env is filled (SARVAM_API_KEY, OPENAI_API_KEY, HF_TOKEN).
cp -n .env.example .env   # if .env doesn't exist yet
# Edit .env and set the three API keys.

# Ensure ./auth/auth.json exists (Meet storage state for the bot's Google account).
ls -l auth/auth.json
# If missing: `cd bot && npm run generate-auth` (one-time interactive login).
```

---

## 1) Bring the stack up (build everything)

```bash
# Build and start postgres, redis, minio, api, worker, diarize.
docker compose build
docker compose up -d postgres redis minio diarize api worker

# Build the bot image too (ephemeral — worker spawns it per session).
docker compose --profile bot build

# Confirm all services are healthy.
docker compose ps
```

---

## 2) Create a session (paste your Meet URL)

```bash
# Replace the URL. Optionally pass expectedSpeakers for canonical names.
MEET_URL='https://meet.google.com/abc-defg-hij'

SESSION_ID=$(curl -sS -X POST http://localhost:3000/sessions \
  -H 'content-type: application/json' \
  -d "{
        \"meetUrl\": \"$MEET_URL\",
        \"metadata\": { \"expectedSpeakers\": [\"Rishi Italiya\", \"Candidate Name\"] }
      }" | tee /dev/stderr | python3 -c 'import json,sys;print(json.load(sys.stdin)["sessionId"])')

echo "SESSION_ID=$SESSION_ID"
```

---

## 3) Watch the bot do its thing

```bash
# Worker logs — shows spawn-bot, transcribe-chunk, finalize jobs.
docker compose logs -f worker

# Bot container logs (name is 'renate-bot-<sessionId>'). Open in a 2nd terminal.
docker logs -f "renate-bot-$SESSION_ID"

# Quick status poll.
watch -n 5 "curl -sS http://localhost:3000/sessions/$SESSION_ID | python3 -m json.tool"
```

Bot auto-leaves when the meeting ends (everyone else leaves / you close the tab / 120 min hard timeout). Finalize runs automatically after that.

---

## 4) After the call ends — fetch transcript + summary

```bash
# Wait for status = 'complete'.
curl -sS http://localhost:3000/sessions/$SESSION_ID | python3 -m json.tool

# Summary (markdown). API returns it directly.
curl -sS http://localhost:3000/sessions/$SESSION_ID \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["summary_md"] or "(no summary)")'

# Full transcript — straight from Postgres (no API endpoint for this yet).
docker compose exec -T postgres psql -U renate -d renate -c \
  "SELECT to_char(start_ts, 'FM999990.00') AS t, speaker_name, text
     FROM transcript_final
    WHERE session_id = '$SESSION_ID'
    ORDER BY start_ts;"
```

Pretty-print the transcript to a file:

```bash
docker compose exec -T postgres psql -U renate -d renate -At -F $'\t' -c \
  "SELECT start_ts, speaker_name, text FROM transcript_final
    WHERE session_id = '$SESSION_ID' ORDER BY start_ts;" \
  | awk -F '\t' '{ printf "[%06.2f] %-20s %s\n", $1, $2":", $3 }' \
  > "transcript-$SESSION_ID.txt"

cat "transcript-$SESSION_ID.txt"
```

---

## 5) Debugging helpers (only if something looks wrong)

```bash
# Redis — what the bot pushed live.
docker compose exec redis redis-cli XLEN "captions:$SESSION_ID"
docker compose exec redis redis-cli XRANGE "captions:$SESSION_ID" - + COUNT 5
docker compose exec redis redis-cli XLEN "active_speaker:$SESSION_ID"
docker compose exec redis redis-cli XRANGE "active_speaker:$SESSION_ID" - + COUNT 20
docker compose exec redis redis-cli GET "session:$SESSION_ID:roster"

# MinIO — audio chunks (one per 30s by default).
docker compose exec minio mc ls local/renate-audio/sessions/$SESSION_ID/chunks/ 2>/dev/null \
  || docker compose exec minio sh -c "ls -lh /data/renate-audio/sessions/$SESSION_ID/chunks/ | tail -20"

# Postgres — raw tables.
docker compose exec -T postgres psql -U renate -d renate -c \
  "SELECT chunk_idx, start_ts, end_ts, left(raw_text, 60) FROM transcript_segments
    WHERE session_id = '$SESSION_ID' ORDER BY chunk_idx LIMIT 20;"

docker compose exec -T postgres psql -U renate -d renate -c \
  "SELECT pyannote_cluster, resolved_name, count(*) AS turns,
          sum(end_ts - start_ts)::numeric(8,2) AS seconds
     FROM speaker_turns
    WHERE session_id = '$SESSION_ID'
    GROUP BY 1, 2 ORDER BY seconds DESC;"

# Bot DOM debug dump (written once at t+8s into the bot's chunk dir).
docker cp "renate-bot-$SESSION_ID":/chunks/debug_dom.json .
```

---

## 6) Tear down / reset

```bash
# Stop services, keep volumes (postgres + minio survive).
docker compose down

# Nuke everything, including stored sessions + audio.
docker compose down -v

# Prune leftover per-session bot containers.
docker ps -a --filter "name=renate-bot-" --format '{{.ID}}' | xargs -r docker rm -f
```

---

## Notes

- **Session doesn't get auto-limited.** The bot stays in the call until (a) everyone else leaves, (b) you close the tab, or (c) `CALL_HARD_TIMEOUT_MIN` (default 120 min, override via `.env`). There is no per-session rate limit on the API side.
- **First call of the day is slowest.** pyannote downloads its model weights on first run (~2 GB into `diarize-cache`).
- **Free Gmail works.** No Google API / OAuth anywhere in this pipeline.
