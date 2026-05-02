# MeetingBoost — Shipping Checklist

Status snapshot for getting from current state (v1.0.0-beta) to a publicly shippable
v1.0.0. Items are grouped by blocking severity. Items already done are checked off
so the diff is clear; everything unchecked is real work.

---

## ✅ Already done in this iteration

- [x] Renamed app from MeetingBoom → **MeetingBoost** across all source files, package.json, HTML titles, copy, and tray menu.
- [x] Sound pipeline: 25 free sound effects across 3 packs (Classics, Corporate Warfare, Hype Machine).
- [x] Real audio playback via `new Audio()` driven by `packs.json`.
- [x] Pack-selection IPC chain: `packs.html` → `main.ts` → `board.html`.
- [x] YouTube → MP3 download + crop pipeline (`yt-dlp` + `ffmpeg`) wired in `sound-manager.html`.
- [x] Light / Dark / System theme switching with anti-FOUC inline script + live IPC broadcast.
- [x] Logo SVG (`assets/logo.svg`) — waveform mark with electric-violet accent.
- [x] GitHub Actions CI (`.github/workflows/ci.yml`): TypeScript check + Python tests on Linux; macOS DMG packaging on tags.
- [x] Test suite: 20 unit/integration tests + Playwright E2E spec + YouTube pipeline tests.
- [x] **Voice recording**: Record-Voice tab in sound-manager with `MediaRecorder` (WebM/Opus), live level meter, 30 s cap, in-browser playback. WebM blob is sent over IPC and converted to MP3 via ffmpeg, then merged into the Custom pack.
- [x] **Pack share format `.mbpack`**: zip-shadowed archive with `manifest.json` + flat `sounds/` directory. Export from any real pack via the Packs screen footer; import via the same footer with auto-renaming on id collision. Built with system `zip`/`unzip` (no JS deps).
- [x] **Example pack** at `assets/classics.mbpack` (2.6 MB, 11 sounds) — a real, importable archive. Rebuild with `make example-pack` whenever the classics pack changes.
- [x] **Recording pipeline integration test** that synthesizes a WebM/Opus file and runs the exact ffmpeg invocation from `main.ts` against it. Now part of CI.
- [x] **Tray icon as macOS template image** — `assets/trayTemplate.png` (16/32 px), auto-tinted by macOS. No more emoji in the menu bar.
- [x] **Hardened runtime + entitlements** — `assets/entitlements.mac.plist` grants JIT, mic, and network. `package.json#build.mac.hardenedRuntime` is now `true`. Ready for notarization once a Developer ID cert is available.
- [x] **DMG background** — wordmark + drag arrow at `assets/dmg/background.png`, generated from SVG. Included in built DMGs.
- [x] **Real audio device routing** — Settings → Audio enumerates real outputs via `enumerateDevices()`. The board reads `outputDeviceId` and applies it via `setSinkId()` per Audio element. BlackHole shows up in the list with a "(recommended for meeting injection)" hint when present.
- [x] **Global keyboard capture** — wired via [`node-global-key-listener`](https://www.npmjs.com/package/node-global-key-listener). Toggle in Settings → Keyboard. Requests Accessibility permission via `systemPreferences`. Per-key 80 ms debounce when "Suppress Repeat" is on.
- [x] **All other settings now actually do something:** `windowOpacity` applies to the board via `setOpacity()`, `launchAtLogin`/`startHidden` go through `app.setLoginItemSettings()`, `alwaysOnTop` applies live to both windows.
- [x] **Version sync** — Settings → About reads `app.getVersion()` instead of a hardcoded string.
- [x] **First-run onboarding** — 3-step overlay (welcome → BlackHole → Accessibility) on first launch. Persisted via the `onboardingComplete` setting.
- [x] **Local DMG build verified** — `release/MeetingBoost-1.0.0-beta-arm64.dmg` (99.6 MB, checksum valid). Tray template image, native key-listener helper, and DMG background all bundled correctly.
- [x] **`mac.notarize: true`** in `package.json#build` — notarization runs when Apple notary credentials are set in CI; skipped otherwise (`SETUP.md`).
- [x] **`scripts/verify-macos-bundle.sh`** + release-workflow verification: **layout-only** without `CSC_*`; **`codesign --verify --deep --strict`** plus optional **`spctl`** when Developer ID + notary credentials are configured in CI (`SETUP.md`).

---

## 🔴 Blocking ship (must do)

### Code-signing & notarization (only thing left blocking distribution)

- [ ] **Apple Developer ID certificate** ($99/yr). Without one, downloaders see *"MeetingBoost can't be opened because Apple cannot check it for malicious software"*. Hardened-runtime config and entitlements are already in place — once the cert is installed, `electron-builder` picks it up automatically.
- [ ] **Notarization credentials in CI**: set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` as GitHub Action secrets (notarization is enabled via `mac.notarize` in `package.json#build`; without these env vars electron-builder skips notarization).
- [ ] **Test on a clean Mac**: download the notarised DMG, confirm Gatekeeper accepts it without right-click → Open.

### Remaining feature stubs

- [ ] `monitorOutput`, `fireOnKeydown`, `suppressRepeat` (the global side; renderer-side debounce already wired), `disableInText` (across-app detection), `reduceMotion` (CSS toggle).
- [ ] Custom-sound delete/rename UI in `sound-manager.html` (currently only add).
- [ ] Settings → "Reset Defaults" and "Export Settings" buttons are stubs that just toast — wire them up or hide.

---

## 🟡 Nice to have for v1 (sand off rough edges)

- [ ] Auto-update via `electron-updater` + GitHub Releases. The CI workflow already publishes releases on tag, so this is mostly: install pkg, add `autoUpdater.checkForUpdatesAndNotify()` in `main.ts`, configure `publish` in `package.json#build`.
- [ ] Crash reporter (`electron.crashReporter.start()`).
- [ ] Telemetry kill-switch & privacy doc — even if you don't collect anything, say so.
- [ ] Empty-state for the Custom pack when no sounds added yet.
- [ ] Volume per-sound override (settings UI shows it; needs persistence).
- [ ] Localize strings into `i18n/en.json`. Even if EN-only at launch, the structure unblocks future locales.

---

## 🟢 Polish & launch readiness

- [ ] Marketing site / landing page with a 30-second demo video.
- [ ] Press kit: 1024×1024 logo PNG, screenshots in light & dark mode, app description in 3 lengths.
- [ ] Privacy policy + Terms (one page each is fine).
- [ ] Pricing decision: free, paid one-time, paid + free tier, or pay-what-you-want?
- [ ] Distribution: GitHub Releases only? Mac App Store (requires sandboxing — incompatible with global key capture)? Homebrew Cask?
- [ ] Logo / wordmark variants: dark-on-light, light-on-dark, monochrome, square favicon.

---

## 🔵 Engineering hygiene

- [ ] Replace `tests/test_sounds.py`'s reliance on real MP3 files with a fixture set under `tests/fixtures/` so CI doesn't depend on `download_sounds.py` succeeding.
- [ ] Run Playwright E2E in CI (currently only unit tests run). Needs `xvfb` on Linux runner OR macos-14 runner — the latter is already in the release job; we could split a `e2e` job there.
- [ ] Add `eslint` + `prettier` configs and run them in CI.
- [ ] `tsconfig.json`: enable `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes`.
- [ ] Replace ad-hoc `findBin()` PATH search in `main.ts` with `which`-style helper that respects `process.env.PATH` and supports user-configured tool paths.
- [ ] Bundle `yt-dlp` and `ffmpeg` binaries with the app (or detect-and-prompt-to-install). Right now the YouTube feature silently fails if either is missing.
- [ ] Fix the radial-gradient vignette in `board.html` so it adapts in light theme (currently darkens corners on a light bg).

---

## Quick win order (suggested)

1. Generate `.icns` icon → CI can produce a real DMG. *(30 min)*
2. Wire global key capture → headline feature works. *(1 day)*
3. Either ship-or-strip the audio device picker → no broken UI surface. *(2 hr or 1 day)*
4. Apple Developer cert + notarization → DMG is downloadable without warnings. *(1 day, gated on the cert)*
5. First-run onboarding → users actually finish setup. *(half day)*
6. Auto-updater + landing page → ready for public launch. *(1–2 days)*

Total to v1.0.0 release: roughly 1 working week of focused engineering, plus a couple of days for the dev account / notarization paperwork.
