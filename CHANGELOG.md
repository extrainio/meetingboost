# Changelog

All notable changes to MeetingBoost. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-rc1] — 2026-05-28

First release candidate. Feature-complete; awaiting Apple Developer ID + notarisation to ship as 1.0.0 (see [SHIPPING.md](./SHIPPING.md)).

### Added
- **`mbpack://` install links.** Share any pack as a one-click URL. The Packs window has a new Share button that wraps a hosted .mbpack URL into an `mbpack://import?url=…` link; clicking the link in any app downloads the archive (https-only, redirect-limited) and installs after an explicit confirmation dialog.
- **Bundled BlackHole installer.** Packaged builds can ship the signed [BlackHole 2ch](https://existential.audio/blackhole/) .pkg in their extraResources. The first-run walkthrough probes for it and promotes a one-click "Install BlackHole (bundled)" button when present, falling back to brew / web download otherwise. Step 3 of the walkthrough now also has an "Open Audio MIDI Setup" shortcut for the Multi-Output Device routing step. Fetch the .pkg at build time with `npm run fetch:blackhole`.
- **GitHub Releases update checker.** Notify-only — surfaces newer releases via a tray menu item and the Settings → About → Check Now control. Background check on startup (packaged builds only, 5-second delay, opt-out via the `autoUpdate` setting). Clicking "Update available" opens the release page; an actual auto-downloader awaits a signed-build path post-v1.
- **9 per-module Vitest suites** in `tests/unit/` covering pure helpers (slugify, isVirtualAudioDevice, snippet filters, key mappers, semver compare, mbpack URL parser, etc.). 82 unit tests in total, runnable in <300 ms via `npm run test:unit`.

### Changed
- **`main.ts` extraction.** The 1564-line monolith is now a 200-line IPC registration table. All business logic moved to nine focused modules under `src/main/` (`paths`, `tools`, `settings`, `audio`, `recording`, `youtube`, `packs`, `library`, `updates`, `protocol`, `windows`). See [ADR-0001](./docs/adr/0001-runtime-and-architecture.md) for the decision record.
- **Pack import emits `packs-changed`.** The file-picker import flow now refreshes the renderer the same way other CRUD operations do; previously the Packs window required a manual reload after `pack-import`.
- **`settings-export` parent-window fallback.** Restored the pre-extraction `childWin ?? boardWin` chain so the save dialog parents to the settings child window when it's open.
- **`README.md` modernised** with badges, hero screenshot, and a landing-page link. Internal planning docs (`docs/superpowers/`) removed from the repo; brainstorm scratch lives outside source control now.

### Security
- **`open-external` IPC restricted to http(s).** The bridge that lets the renderer ask the main process to launch a URL now refuses `file://`, `javascript:`, and custom-protocol URIs.
- **`mbpack://` URL gating.** `parseMbpackUrl` rejects non-https inner URLs, unknown actions, and malformed outer URLs (7 unit tests cover the rejection paths). Every install requires explicit user confirmation.
- **Electron 32 → 39 upgrade.** Closed all 24 prior CVE-level Dependabot alerts. The `brace-expansion` polynomial-regex advisory is also resolved.

### Internal
- **9-module split delivered in seven incremental PRs.** Each PR landed independently and left the app shippable; per-PR review applied a two-stage subagent pipeline (spec compliance + code quality).
- **`docs/adr/` directory** established for architecture decision records. ADR-0001 captures the refactor + the rationale for staying on Electron through v1 (Tauri post-v1 spike is queued as ADR-0002).
- **`AGENTS.md` + `CLAUDE.md`** describe the new `src/main/*` layout, the namespace-import convention, and the documented "ipcMain only in main.ts" exception that `windows.ts` owns.
- **GitHub Pages workflow** assembles and deploys the landing page from `landing/index.html` on push to main. Live at [extrainio.github.io/meetingboost](https://extrainio.github.io/meetingboost/).

### Removed
- Five orphaned `landing-*.png` files from repo root (~3 MB) that were tied to an old Showcase section in the README. Screenshots live in `assets/screenshots/` instead.

---

## [1.0.0-beta] — 2026-04 (pre-Changelog)

Initial public beta. Detailed history precedes the introduction of this changelog; see commit log and [SHIPPING.md](./SHIPPING.md) for the prior milestones (sound pipeline, voice recording, YouTube clip import, `.mbpack` archive format, global keyboard capture, hardened runtime, DMG packaging, tray template image, first-run onboarding).
