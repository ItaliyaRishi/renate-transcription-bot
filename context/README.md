# Renate — Session Resume Pack

This folder is a snapshot of everything you (or a future Claude) need to resume work on the Renate Google Meet transcription bot without re-reading the full chat history.

## What each file covers

| File | What's in it |
|---|---|
| [PIPELINE.md](./PIPELINE.md) | End-to-end data flow, component responsibilities, file-by-file map |
| [ENV.md](./ENV.md) | Every environment variable, where it's used, and what it does |
| [STATE.md](./STATE.md) | What's working, what's not, known issues, next steps |
| [COSTS.md](./COSTS.md) | Per-meeting + fixed monthly costs in INR |
| [RESUME.md](./RESUME.md) | Exact commands to bring the stack up and test it |

Also read, in order:
1. **`PLAN.md`** in the repo root — the original blueprint (Phase 0–8). Still the source of truth for the product vision.
2. **`~/.claude/plans/go-through-the-plan-serialized-ritchie.md`** — the most recent approved plan (speaker-name fix via Web Audio API).
3. **`~/.claude/projects/-Users-italiyarishi-renate-transcription-bot/memory/`** — memory files that load automatically in new sessions.

## One-line status

End-to-end pipeline is **live and verified** for audio → Sarvam transcription → diarize (FoxNoseTech/diarize, 2 clusters correct) → GPT-4.1-mini summary → Postgres. **Real participant names are implemented via Web Audio API per-tile analyser but not yet verified on a live multi-person call.**

## The one command you'll probably want

```bash
cd /Users/italiyarishi/renate-transcription-bot
docker compose up -d postgres redis minio api worker diarize
```

Then follow [RESUME.md](./RESUME.md) to trigger a test session.

## Last live call (reference)

- Session ID: `bd5f6181-5d3d-4e0e-9072-96816c6a44f4`
- Meet URL: `https://meet.google.com/cjg-ucss-tpg` (since ended)
- Result: 2 speakers identified correctly (fix #2 ✅), but labeled `Speaker 1/2` not real names (fix #1 still pending live verification after the Web Audio API path was added).
- Transcript + summary still live in Postgres.
