# CLAUDE.md

Project memory for [Claude Code](https://claude.com/claude-code).

**Start here:** [`AGENTS.md`](./AGENTS.md) — stack, build, architecture, don'ts. The rest of this file is Claude-specific notes that don't apply to other agents.

---

## Claude Code specifics

### Where files come from

- `main.ts` and `preload.ts` are TypeScript at the repo root. `tsc` compiles them in-place. Edit the `.ts`, not the `.js` — the `.js` is the build output and is regenerated.
- `main.ts` is the IPC registration table — pure wiring. All business logic lives in `src/main/*.ts` modules (`paths`, `tools`, `settings`, `audio`, `recording`, `youtube`, `packs`, `library`, `windows`). See [`docs/adr/0001-runtime-and-architecture.md`](./docs/adr/0001-runtime-and-architecture.md) for the rationale.
- `src/*.html` are vanilla HTML/CSS/JS — no framework, no JSX. If a renderer needs a Node API, add an `ipcMain.handle('domain-verb', ...)` to the right `src/main/*.ts` module and expose it via `preload.ts`.
- `src/packs.json` is the source of truth for built-in pack data. The Custom pack is created at runtime on first save.

### Things Claude usually gets wrong here

- **Reaching for a framework**: don't. The renderers are intentionally tiny. Adding React would be more code than the actual feature.
- **Adding a bundler**: don't. `tsc` is enough. Electron loads the compiled JS directly.
- **Using npm packages for ffmpeg / yt-dlp / zip**: don't. The repo invokes the system binaries via `child_process.spawn`. `fluent-ffmpeg`, `node-zip`, `yt-dlp-wrap` are out of scope.
- **Switching color space**: stay in OKLCH. The design tokens are intentional.
- **SaaS-style copy**: the brand voice is operator/direct/precise. No "Welcome to your new dashboard!" energy.

### Useful entry points

- New IPC handler → add the function to the right `src/main/*.ts` module (or create a new module if a new domain), then add `ipcMain.handle('domain-verb', (_e, ...args) => module.fn(...args))` to the IPC table in `main.ts`, and expose it in `preload.ts`.
- New renderer feature → edit the HTML file directly; it owns its own CSS and JS.
- New sound pack → add to `src/packs.json`, drop MP3s in `src/sounds/<pack-id>/`, run `make example-pack` if you also want to rebuild the example `.mbpack`.
- New pure helper in an existing module → add a Vitest case in `tests/unit/<module>.test.ts`. The unit suite is fast; use it before reaching for Playwright.

### Testing

`make test` runs pytest against the sound packs and ffmpeg pipeline. Playwright E2E is opt-in (`npm run test:e2e`). Both are documented in `AGENTS.md`.

### Folders that aren't tracked

- `.superpowers/` — local design brainstorm scratch (gitignored). HTML prototype iterations of the v6 design system. Reference only; not part of the build.
- `release/` — electron-builder output (gitignored).
- `_site/` — assembled during the GitHub Pages workflow (gitignored).
