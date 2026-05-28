# AGENTS.md

Conventions for AI coding agents (Claude Code, Codex, Cursor, Aider, etc.) working in this repo.

This file is intentionally short. Read it, then look at `main.ts` and one of `src/*.html` to absorb the actual style.

---

## What this is

MeetingBoost — a macOS Electron app. Always-on-top 520×580 window, your keyboard is a soundboard, audio is routed into Zoom/Teams/Meet via a virtual driver (BlackHole).

## Stack

- **Electron 32** main process in TypeScript
- **Renderers**: vanilla HTML/CSS/JS. No framework. No bundler. Each `src/*.html` is self-contained.
- **TypeScript 5** compiled in-place by `tsc` (no Vite/esbuild/webpack — see `tsconfig.json`)
- **Tests**: Python `pytest` for sound-pack and pipeline tests, Playwright for E2E
- **External tools**: `yt-dlp`, `ffmpeg`, system `zip`/`unzip` — invoked via `child_process.spawn`, not npm packages

## Run / build / test

```bash
npm install
npm run dev            # tsc && ELECTRON_IS_DEV=1 electron .
npm run build          # tsc only
npm run test           # python3 -m pytest tests/test_sounds.py
npm run test:unit      # vitest run — per-module unit tests under tests/unit/
npm run dist:dmg       # signed/notarised DMG (needs Apple cert)
make sounds            # download the sound packs (~10 MB)
```

`tsc` compiles `*.ts` in-place — `main.ts` → `main.js` next to it. Do not introduce a `dist/` or `build/` output dir.

## Architecture

```
main.ts        Electron main: windows, tray, global shortcut, IPC, settings store
preload.ts     contextBridge surface — narrow, per-renderer API
src/
  board.html         the soundboard window (520×580)
  packs.html         pack browser
  sound-manager.html add sound (record / YouTube clip / upload)
  settings.html      audio, keyboard, appearance, window
  packs.json         single source of truth for pack data
  sounds/<id>/       MP3s grouped by pack id
assets/        logo, screenshots, example .mbpack
scripts/       Python download helpers, bash build helpers
tests/         pytest + playwright
```

Renderer pages share OKLCH design tokens but do not share JS. They are isolated by design.

## Don'ts

- **No JS frameworks in renderers** — vanilla DOM only. The whole renderer surface is ~3 small HTML files; React/Vue/Svelte would dwarf the actual code.
- **No bundlers** — `tsc` in-place is the build. No webpack/Vite/esbuild.
- **No npm packages for things the OS already does** — use `yt-dlp`, `ffmpeg`, `zip`, `unzip` via `child_process.spawn`. Don't add `node-zip` or `fluent-ffmpeg`.
- **No telemetry, analytics, or cloud calls.** Settings live in `~/Library/Application Support/MeetingBoost/settings.json`. Nothing leaves the machine without an explicit user action (e.g. update check).
- **No SaaS purple gradients.** The aesthetic is operator-console: dark background, amber accent (`oklch(67% 0.17 72)`), IBM Plex Mono + Barlow Condensed 900. See `PRODUCT.md` for the full brief.
- **Don't reach into Node from a renderer.** Add an IPC handler in `main.ts` and expose a narrow method via `preload.ts` instead.

## Conventions

- **OKLCH for colors.** Never hex, never `rgb()`. Tokens live at the top of each HTML file (the v6 system).
- **Typography**: IBM Plex Mono everywhere except keycap letters, which use Barlow Condensed 900.
- **Keycap metaphor**: `border-bottom: 3px` + `translateY(3px)` on press — keys collapse like physical keys.
- **IPC channel names** follow `<domain>-<verb>` (e.g. `pack-export`, `record-save`, `yt-info`).
- **Settings shape**: a single JSON object on disk, read/write via `getSetting`/`setSetting` in `main.ts`. No schema migrations yet — keys are added, never renamed.

## Tests

Three suites:

- **pytest** (`tests/test_sounds.py`, `tests/test_pack_format.py`, `tests/test_record_pipeline.py`, `tests/test_youtube_download.py`) — sound-pack integrity, `.mbpack` round-trip, ffmpeg pipeline, yt-dlp pipeline. Run with `make test`.
- **Vitest** (`tests/unit/*.test.ts`) — per-module unit tests for pure TypeScript helpers under `src/main/`. Run with `npm run test:unit`. Vitest uses Vite internally for its runner; this is a dev-only concern and does **not** introduce a bundler into the production build (`npm run build` remains `tsc` in-place).
- **Playwright** (`tests/e2e/*.spec.ts`) — launches the actual Electron binary. Slow; not in PR CI. Run with `npm run test:e2e`.

When adding behavior to a renderer, prefer a pytest test against the underlying IPC handler over a Playwright E2E. E2E is the last resort. When adding a pure function to a `src/main/` module, add a Vitest case.

## Pull requests

- Keep them scoped. A bugfix is not the place for a refactor.
- Reference the issue if there is one.
- Tests for new behavior unless it's a UI-only tweak.
