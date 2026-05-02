#!/usr/bin/env bash
# test-blackhole.sh — verify MeetingBoost audio is reaching BlackHole 2ch.
#
# What it does:
#   1. Confirms BlackHole 2ch is installed.
#   2. Records 8s of audio from BlackHole 2ch into a WAV file.
#   3. While recording, you press keys in MeetingBoost (with output set to
#      BlackHole 2ch in Settings → Audio).
#   4. Reports peak/RMS levels so you know whether ANY signal arrived.
#   5. Plays the captured WAV back through your speakers so you can hear it.
#
# If the WAV has signal, the audience in Teams WILL hear sounds — provided
# Teams' microphone input is set to BlackHole 2ch (see SETUP.md).

set -euo pipefail

DURATION="${1:-8}"
OUT="${2:-/tmp/meetingboost-blackhole-test.wav}"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found. Install with: brew install ffmpeg" >&2
  exit 1
fi

# Find BlackHole 2ch index in avfoundation (varies per machine).
BH_LINE="$(ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 \
  | awk '/AVFoundation audio devices/{flag=1; next} flag' \
  | grep -i 'BlackHole 2ch' || true)"

if [[ -z "$BH_LINE" ]]; then
  cat >&2 <<EOF
ERROR: BlackHole 2ch is not installed (or not exposed to AVFoundation).

Install it:
  brew install --cask blackhole-2ch
Then restart your Mac (the kernel extension needs to load).

After install, re-run this script.
EOF
  exit 1
fi

BH_INDEX="$(echo "$BH_LINE" | sed -E 's/.*\[([0-9]+)\].*/\1/')"
echo "Found BlackHole 2ch at AVFoundation audio index [$BH_INDEX]"
echo

cat <<EOF
== HOW TO USE ==
1. In MeetingBoost: Settings → Audio → Output → "BlackHole 2ch"
2. Make sure MeetingBoost's board window is open and focused.
3. When recording starts (after the 3-second countdown), spam Q/W/E/R/T keys
   in MeetingBoost. You have ${DURATION} seconds.
4. After the recording stops, the script will play the captured audio back
   through your default output so you can hear it.
   - If you hear the sounds → BlackHole routing works ✓
   - If silence → routing is broken (check console of MeetingBoost for errors)

EOF

for i in 3 2 1; do
  echo "  starting in $i ..."
  sleep 1
done
echo "RECORDING ${DURATION}s from BlackHole 2ch — PRESS KEYS NOW"

# -ac 2: stereo (BlackHole 2ch). -i ":$BH_INDEX": audio-only input.
# pcm_s16le into WAV is universally playable.
ffmpeg -hide_banner -loglevel error \
  -f avfoundation -ac 2 -i ":$BH_INDEX" \
  -t "$DURATION" -c:a pcm_s16le -y "$OUT"

echo
echo "Saved: $OUT"

# Report peak + RMS so the user knows whether real signal was captured even
# without listening. -af volumedetect prints stats to stderr.
echo
echo "== SIGNAL ANALYSIS =="
ffmpeg -hide_banner -nostats -i "$OUT" -af "volumedetect" -f null - 2>&1 \
  | grep -E "mean_volume|max_volume|n_samples" || true

# Heuristic: if max_volume is below -60 dB, effectively silent.
MAX_DB="$(ffmpeg -hide_banner -nostats -i "$OUT" -af "volumedetect" -f null - 2>&1 \
  | awk '/max_volume/ {print $5}' | tr -d 'dB')"

echo
if [[ -n "${MAX_DB:-}" ]] && awk "BEGIN{exit !($MAX_DB > -60)}" 2>/dev/null; then
  echo "✅ Signal detected (max ${MAX_DB} dB) — BlackHole is receiving audio."
  echo "   The audience in Teams will hear this IF Teams' mic input is set to"
  echo "   BlackHole 2ch and noise-suppression is OFF (see SETUP.md)."
else
  echo "❌ No signal detected (max ${MAX_DB:-?} dB) — BlackHole received nothing."
  echo "   Check: Settings → Audio output is BlackHole 2ch, AND you actually"
  echo "   pressed a key on a non-empty pad during the recording window."
fi

echo
echo "Playing back through default output (Ctrl+C to stop)..."
afplay "$OUT" || true
