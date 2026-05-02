# Contributing to MeetingBoost

Thanks for considering a contribution. MeetingBoost is small enough that
nothing here is bureaucratic — this doc is a one-shot brief on how to set
up, where the code lives, and what makes a PR easy to merge.

## TL;DR

```bash
git clone <your-fork> meetingboost && cd meetingboost
brew install node@20 ffmpeg yt-dlp
npm install
make sounds        # one-time, ~10 MB of MP3s
make dev           # launches Electron with DevTools
```

That's it. The board appears top-left of your primary screen. Press keys.

## Project layout (the 30-second tour)

| Path                       | What lives there                                                        |
| -------------------------- | ----------------------------------------------------------------------- |
| `main.ts`                  | Electron main process — windows, tray, IPC handlers, settings store     |
| `preload.ts`               | The `contextBridge` API surface exposed to renderers                    |
| `src/board.html`           | The soundboard window                                                   |
| `src/packs.html`           | Pack browser, import/export                                             |
| `src/sound-manager.html`   | Add Sound (Record / YouTube)                                            |
| `src/settings.html`        | Settings panes                                                          |
| `src/packs.json`           | Bundled pack manifest                                                   |
| `src/sounds/`              | Bundled MP3s, grouped by pack id                                        |
| `assets/`                  | Logo, DMG background, entitlements, example `.mbpack`                   |
| `scripts/`                 | Sound downloader, example-pack builder, BlackHole test                  |
| `tests/`                   | pytest unit tests + Playwright E2E                                      |
| `.github/workflows/`       | CI, CodeQL, macOS release pipelines                                     |

There's no React/Vue — every renderer is a self-contained HTML file with
inline `<style>` and `<script>`. They share the same OKLCH design tokens
defined at the top of each file. Keep it that way; the simplicity is a
feature.

## Running the app

```bash
make dev          # tsc + electron with DevTools open + ELECTRON_IS_DEV=1
make build        # tsc only (compile main.ts/preload.ts → .js)
make app          # build an unsigned .app for local smoke tests
make dmg          # build a .dmg installer (arm64 + x64)
```

All are thin wrappers around `npm` scripts. Either is fine.

## Running tests

Fast loop (what CI runs on every push):

```bash
make test                                                # sound integrity + tsc
python3 -m pytest tests/test_pack_format.py -v           # .mbpack round-trip
python3 -m pytest tests/test_record_pipeline.py -v       # WebM → MP3 ffmpeg
```

E2E loop (Electron full IPC chain, slower):

```bash
make test-e2e
```

Before opening a PR, run **all of the above** plus:

```bash
npx tsc --noEmit            # the same check CI runs
./scripts/test-blackhole.sh # if your change touches audio routing
```

## Branch & PR conventions

- Branch naming: `feature/<short-slug>`, `fix/<short-slug>`, `docs/<short-slug>`.
- One concern per PR. A bug fix and a refactor go in separate PRs even if
  they touch the same file — easier to review, easier to revert.
- Commit messages: imperative mood, ≤ 72 chars on the first line, body
  explains _why_ (the diff already shows _what_).
- If you're touching audio routing or BlackHole, attach the output of
  `./scripts/test-blackhole.sh` to the PR description so reviewers can see
  the dB level.
- If you're touching the renderer HTML, screenshot before/after.

## What we accept

✅ Bugfixes for any feature listed in the README.
✅ Tests for under-covered areas (especially `main.ts` IPC handlers).
✅ Polish on existing surfaces — empty states, error toasts, accessibility.
✅ New sound packs (under royalty-free licenses, attribute the source).
✅ Documentation improvements.

## What we don't accept (yet)

❌ Cloud sync, accounts, telemetry. MeetingBoost is intentionally local-only.
❌ Cross-platform ports until macOS feels finished. Linux/Windows are
welcome _eventually_, but we'd rather make one OS great than three OSes
mediocre.
❌ Massive framework swaps (introducing React/Vue/Svelte). The lack of a
framework is load-bearing — it's why renderer files are readable in one
sitting.

If you're unsure whether a contribution fits, open a draft issue first to
sketch the idea before writing code. Cheaper than rewriting after a "no".

## Reporting bugs

A good bug report contains:

1. macOS version (`sw_vers`).
2. MeetingBoost version (Settings → About).
3. What you did, what you expected, what happened.
4. Console output (open DevTools with `Cmd+Option+I` on the focused window;
   in packaged builds, log files live at
   `~/Library/Logs/MeetingBoost/`).
5. If audio-related: result of `./scripts/test-blackhole.sh`.

## Releasing (maintainers only)

1. Bump `version` in `package.json`.
2. Tag: `git tag v1.2.3 && git push --tags`.
3. The `Release (macOS)` workflow builds the DMG + ZIP and creates a
   GitHub Release automatically.
4. Verify the artifacts mount and launch on a clean Mac before announcing.

## License

MeetingBoost is released under the MIT License (see [LICENSE](LICENSE)).
By contributing, you agree your contributions will be licensed under the
same terms.

## Code of conduct

Don't be a jerk. That's the whole code of conduct. Disagreements about
technical decisions are welcome; personal attacks are not.
