#!/usr/bin/env bash
# Download the BlackHole 2ch installer pkg from Existential Audio's GitHub
# releases and stage it under assets/installers/ so electron-builder can copy
# it into the packaged app's extraResources directory.
#
# Idempotent — skips the download if the pkg is already present. Override the
# pinned release tag with BLACKHOLE_VERSION=vX.Y.Z when needed.
#
# Why a shell script instead of an npm package: BlackHole's distribution
# channel is the .pkg release asset on GitHub, signed by Existential Audio
# (Developer ID). We want the exact signed .pkg, not a repackaged copy.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$ROOT/assets/installers"
DEST_FILE="$DEST_DIR/BlackHole2ch.pkg"
VERSION="${BLACKHOLE_VERSION:-v0.6.0}"
URL="https://github.com/ExistentialAudio/BlackHole/releases/download/${VERSION}/BlackHole2ch.v${VERSION#v}.pkg"

mkdir -p "$DEST_DIR"

if [[ -f "$DEST_FILE" ]]; then
  echo "blackhole: already present at $DEST_FILE (skip)"
  exit 0
fi

echo "blackhole: fetching $VERSION from GitHub releases"
echo "blackhole: url $URL"

# -L follows redirects (GitHub release assets are hosted on a CDN).
# -f errors on HTTP 4xx/5xx instead of writing an HTML body.
# --retry 3 + --retry-delay 2 covers transient network blips on CI.
curl -L -f --retry 3 --retry-delay 2 -o "$DEST_FILE.partial" "$URL"

# Cheap sanity check before atomic-rename: real signed .pkg files start with
# the xar magic number 'xar!' (0x78 0x61 0x72 0x21). Catches HTML-error-page
# downloads that slipped past the HTTP code check.
HEADER="$(head -c 4 "$DEST_FILE.partial" | xxd -p)"
if [[ "$HEADER" != "78617221" ]]; then
  rm -f "$DEST_FILE.partial"
  echo "blackhole: download is not a .pkg (header=$HEADER) — aborting" >&2
  exit 1
fi

mv "$DEST_FILE.partial" "$DEST_FILE"
SIZE="$(wc -c < "$DEST_FILE" | tr -d ' ')"
echo "blackhole: ok — $DEST_FILE (${SIZE} bytes)"
