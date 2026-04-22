#!/usr/bin/env bash
# Boots Xvfb (virtual display) + PulseAudio (virtual null sink), then execs
# the bot. Headful Chromium inside Xvfb is used instead of headless-shell
# because headless-shell doesn't route audio to PulseAudio — the whole
# point of this bot is capturing Meet audio, so we need the full browser.

set -euo pipefail

unset PULSE_SERVER

mkdir -p /chunks /var/run/pulse /var/lib/pulse /root/.config/pulse /tmp/.X11-unix

# --- Xvfb ---
export DISPLAY=":99"
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
XVFB_PID=$!

for i in $(seq 1 30); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then
    echo "[entrypoint] Xvfb ready after ${i} attempts"
    break
  fi
  sleep 0.2
done

if ! xdpyinfo -display :99 >/dev/null 2>&1; then
  echo "[entrypoint] ERROR: Xvfb failed to start" >&2
  exit 1
fi

# --- PulseAudio ---
pulseaudio \
  --exit-idle-time=-1 \
  --disallow-exit=false \
  --disable-shm=true \
  --log-target=stderr \
  --daemonize=true

for i in $(seq 1 30); do
  if pactl info >/dev/null 2>&1; then
    echo "[entrypoint] pulseaudio ready after ${i} attempts"
    break
  fi
  sleep 0.3
done

if ! pactl info >/dev/null 2>&1; then
  echo "[entrypoint] ERROR: pulseaudio failed to start" >&2
  exit 1
fi

pactl load-module module-null-sink \
  sink_name=meet_sink \
  sink_properties=device.description=MeetSink >/dev/null

pactl set-default-sink meet_sink
pactl set-default-source meet_sink.monitor

echo "[entrypoint] DISPLAY=${DISPLAY}; default sink=meet_sink"

# Propagate SIGTERM to all children so docker stop completes quickly.
_term() {
  echo "[entrypoint] received SIGTERM"
  kill -TERM "${BOT_PID:-0}" 2>/dev/null || true
  kill -TERM "${XVFB_PID:-0}" 2>/dev/null || true
}
trap _term SIGTERM SIGINT

"$@" &
BOT_PID=$!
wait "$BOT_PID"
