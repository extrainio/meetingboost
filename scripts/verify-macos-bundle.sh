#!/usr/bin/env bash
# Verify MeetingBoost.app after electron-builder packaging.
#
# Usage:
#   ./scripts/verify-macos-bundle.sh [/path/to/MeetingBoost.app]
#
# Default path: release/mac-arm64/MeetingBoost.app
#
# Optional env:
#   REQUIRE_GATEKEEPER_PASS=1  — also run `spctl -a -vv` and fail if Gatekeeper rejects.
#                                Use after Developer ID signing + notarization (release CI).
#
set -euo pipefail

APP="${1:-release/mac-arm64/MeetingBoost.app}"

if [[ ! -d "${APP}" ]]; then
  echo "error: app bundle not found: ${APP}" >&2
  echo "hint: npm run dist, or pass the path to MeetingBoost.app (e.g. from a mounted DMG)." >&2
  exit 1
fi

echo "==> codesign verify (deep, strict)"
codesign --verify --deep --strict --verbose=2 "${APP}"

if [[ "${REQUIRE_GATEKEEPER_PASS:-}" == "1" ]]; then
  echo "==> Gatekeeper assessment (spctl)"
  spctl -a -vv "${APP}"
fi

echo "ok: ${APP}"
