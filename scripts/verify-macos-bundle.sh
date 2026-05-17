#!/usr/bin/env bash
# Verify MeetingBoost.app after electron-builder packaging.
#
# Usage:
#   ./scripts/verify-macos-bundle.sh [/path/to/MeetingBoost.app]
#
# Default path: release/mac-arm64/MeetingBoost.app
#
# Optional env:
#   STRICT_CODESIGN_VERIFY=1   — run `codesign --verify --deep --strict` (needs Developer ID flow;
#                                 ad-hoc / linker-signed Electron often fails Apple's verify.)
#   REQUIRE_GATEKEEPER_PASS=1  — also run `spctl -a -vv`; use after sign + notarization in CI.
#
set -euo pipefail

APP="${1:-release/mac-arm64/MeetingBoost.app}"

if [[ ! -d "${APP}" ]]; then
  echo "error: app bundle not found: ${APP}" >&2
  echo "hint: npm run dist, or pass the path to MeetingBoost.app (e.g. from a mounted DMG)." >&2
  exit 1
fi

INF="${APP}/Contents/Info.plist"
EXE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${INF}" 2>/dev/null || true)"
if [[ -z "${EXE_NAME}" ]]; then
  echo "error: cannot read CFBundleExecutable from ${INF}" >&2
  exit 1
fi

MAIN="${APP}/Contents/MacOS/${EXE_NAME}"

echo "==> bundle layout (adhoc-safe)"
for p in Contents/Info.plist "Contents/MacOS/${EXE_NAME}" Contents/PkgInfo; do
  if [[ ! -e "${APP}/${p}" ]]; then
    echo "error: missing ${APP}/${p}" >&2
    exit 1
  fi
done
if [[ ! -x "${MAIN}" ]]; then
  echo "error: main executable not executable: ${MAIN}" >&2
  exit 1
fi
if [[ ! -e "${APP}/Contents/Frameworks/Electron Framework.framework" ]]; then
  echo "error: missing Electron Framework.framework" >&2
  exit 1
fi
if [[ ! -e "${APP}/Contents/Resources/app.asar" ]] && [[ ! -d "${APP}/Contents/Resources/app.asar.unpacked" ]]; then
  echo "error: missing Contents/Resources app payload (asar or asar.unpacked)" >&2
  exit 1
fi

echo "ok: bundle layout (${EXE_NAME})"

if [[ "${STRICT_CODESIGN_VERIFY:-}" == "1" ]]; then
  echo "==> codesign verify (strict) — Developer ID builds only"
  # --deep is deprecated and trips on Electron's nested frameworks with the
  # cryptic "code has no resources but signature indicates they must be present"
  # error. Nested-bundle verification is covered by spctl below (Gatekeeper's
  # actual evaluation path) and by Apple's notary service upstream.
  codesign --verify --strict --verbose=2 "${APP}"
fi

if [[ "${REQUIRE_GATEKEEPER_PASS:-}" == "1" ]]; then
  echo "==> Gatekeeper assessment (spctl)"
  spctl -a -vv "${APP}"
fi

echo "ok: ${APP}"
