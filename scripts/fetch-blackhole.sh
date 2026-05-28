#!/usr/bin/env bash
# Stage a bundled BlackHole 2ch installer pkg under assets/installers/ so
# electron-builder can copy it into the packaged app's extraResources.
#
# IMPORTANT: BlackHole's official distribution is hosted on existential.audio
# behind an email-form (no stable, scriptable URL). This script therefore
# treats the bundled installer as OPTIONAL — if the .pkg is already present
# (you dropped it in yourself), we keep it; otherwise we log a warning and
# exit 0 so the release build continues. The first-run walkthrough falls
# back to brew / web download when the .pkg is absent.
#
# To bundle the installer in a dist build:
#   1. Visit https://existential.audio/blackhole/ and download BlackHole 2ch
#   2. Place the .pkg at assets/installers/BlackHole2ch.pkg
#   3. Run npm run dist (this script will detect the file and skip the fetch)
#
# Optional env override for future GitHub-hosted releases:
#   BLACKHOLE_DOWNLOAD_URL=https://… npm run fetch:blackhole
# When set, the script attempts a curl download from that URL.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$ROOT/assets/installers"
DEST_FILE="$DEST_DIR/BlackHole2ch.pkg"

mkdir -p "$DEST_DIR"

if [[ -f "$DEST_FILE" ]]; then
  SIZE="$(wc -c < "$DEST_FILE" | tr -d ' ')"
  echo "blackhole: already present at $DEST_FILE (${SIZE} bytes) — keeping"
  exit 0
fi

if [[ -z "${BLACKHOLE_DOWNLOAD_URL:-}" ]]; then
  echo "blackhole: no installer present and BLACKHOLE_DOWNLOAD_URL not set"
  echo "blackhole: skipping bundled installer — walkthrough will use brew/web fallback"
  echo "blackhole: to bundle, drop the .pkg at $DEST_FILE before \`npm run dist\`"
  exit 0
fi

echo "blackhole: fetching from $BLACKHOLE_DOWNLOAD_URL"

# Soft-fail the download too — a broken URL shouldn't block the release build,
# since the walkthrough handles the .pkg's absence gracefully.
if ! curl -L -f --retry 3 --retry-delay 2 -o "$DEST_FILE.partial" "$BLACKHOLE_DOWNLOAD_URL"; then
  rm -f "$DEST_FILE.partial"
  echo "blackhole: download failed — continuing without bundled installer" >&2
  exit 0
fi

# Cheap sanity check: signed .pkg files start with the xar magic number 'xar!'
# (0x78 0x61 0x72 0x21). Catches HTML-error-page downloads that slipped past
# the HTTP code check.
HEADER="$(head -c 4 "$DEST_FILE.partial" | xxd -p)"
if [[ "$HEADER" != "78617221" ]]; then
  rm -f "$DEST_FILE.partial"
  echo "blackhole: download is not a .pkg (header=$HEADER) — continuing without bundled installer" >&2
  exit 0
fi

mv "$DEST_FILE.partial" "$DEST_FILE"
SIZE="$(wc -c < "$DEST_FILE" | tr -d ' ')"
echo "blackhole: ok — $DEST_FILE (${SIZE} bytes)"
