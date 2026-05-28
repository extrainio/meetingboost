# 0001 — Stay on Electron; tactical main.ts split; defer Tauri spike to post-v1

- **Status:** Accepted
- **Date:** 2026-05-28
- **Deciders:** Pascal Giessler

## Context

MeetingBoost is a macOS Electron + TypeScript app, currently at v0.0.1 with a public launch targeted for the **1–3 month window** after this decision. The codebase has a clean renderer↔main boundary (vanilla HTML renderers communicate with the Electron main process only through `preload.ts`'s `contextBridge` surface), but `main.ts` itself has grown to **1564 lines** mixing 7+ concerns: window/tray lifecycle, settings persistence, audio device detection, YouTube clipping, recording management, pack CRUD/import/export, and external tool orchestration. Adding new IPC handlers means scrolling through unrelated code, and the file is now too large to hold in working memory.

Two structural questions were on the table:

1. **Should we refactor `main.ts`** — and if so, with how much architectural ceremony (full DDD/hexagonal vs. tactical file split)?
2. **Should we switch the runtime from Electron 39 to Tauri 2.x** — for smaller bundle size (~150 MB → ~15 MB DMG), lower idle RAM (~200 MB → ~70 MB), and an eventual Windows build?

Electron 39 just landed (PR #4) and closed all 24 prior CVEs; the security urgency that often forces a runtime change is not present.

## Decision drivers

- **Launch window: 1–3 months.** No work may put the launch at risk; every change must leave the app shippable.
- **Rust appetite: curious but not committed.** A bounded Rust spike is acceptable; a Rust rewrite during the launch window is not.
- **Platform plan: macOS first, Windows next, no Linux.** A future Windows build is real motivation, but not blocking v1.
- **macOS 13 support is a hard requirement.** WKWebView's `setSinkId()` API (needed to route audio to BlackHole) is gated on macOS 14+ at the time of this decision — Tauri would force us to drop macOS 13 users or build a native Rust audio router.
- **App domain complexity is modest.** The "domains" inside `main.ts` (packs, recording, youtube, audio, settings) are procedural workflows over `fs` + `child_process.spawn`, not rich business logic. Heavy abstraction (ports/adapters/repositories) would cost more than it saves.

## Considered options

**A. Tactical file split now, Tauri evaluation deferred to post-v1 (chosen).** Extract `main.ts` into `src/main/{paths,tools,settings,audio,recording,youtube,packs,library,windows}.ts` modules. No new abstraction layers — modules are thin files of named functions called from `main.ts`'s IPC registry. After v1 ships, a 3-day timeboxed Tauri spike investigates a v2 port with a falsifiable hypothesis.

**B. Full hexagonal refactor now (DDD-lite), Tauri deferred.** Introduce explicit `domain/`, `ports/`, `adapters/` layers so the runtime could be swapped by reimplementing adapters only. Rejected: 2–3 weeks of refactor during a launch window, paying for abstraction the domain doesn't justify. Most "ports" would have one implementation forever.

**C. Defer everything until v1 ships.** No structural changes; polish and ship. Rejected: every feature added between now and launch lands on a 1564-line file. The compounding cost during the launch window outweighs the "safer" framing — the tactical split (A) is light enough that *not* doing it actively costs velocity.

**D. Tauri port now.** Rejected outright on the macOS 13 `setSinkId` gap. Even with Windows as a v2 goal, a runtime change before v1 would force either dropping macOS 13 users or building a Rust audio-router — both untenable in the launch window.

## Decision

**Adopt Approach A.** During the launch window, extract `main.ts` into nine modules under `src/main/`. After v1 ships, run a 3-day Tauri spike against a falsifiable hypothesis and record the outcome in ADR 0002.

**Refactor scope.** Seven incremental PRs, lowest-risk first, each merging independently and leaving the app shippable:

1. `paths.ts` + `tools.ts` — pure helpers
2. `settings.ts`
3. `audio.ts`
4. `recording.ts`
5. `youtube.ts` — largest single chunk
6. `packs.ts` + `library.ts` — largest combined chunk
7. `windows.ts` — last; touches Electron windows/tray most directly

`main.ts` ends up at ~150 lines containing only app lifecycle, IPC channel registration, and one-line delegations into the modules. Each module exports named async functions returning plain values. `ipcMain` is imported only by `main.ts` (no module touches it). `BrowserWindow`/`Tray` are imported only by `windows.ts` (the one module whose job IS Electron windows).

**Testing.** Add per-module Vitest suites for pure functions only (`isVirtualAudioDevice`, snippet filters, key mappers, manifest validators, settings side-effect logic, id-collision suffixer). IPC handlers continue to be covered by the existing Playwright E2E suite. No mocking of `fs` / `child_process` / Electron — that abstraction cost is exactly what Approach B was rejected for.

**Post-v1 Tauri spike.** Three days, sandboxed (`spikes/tauri-poc/`), throwaway. One feature ported end-to-end (settings storage). Falsifiable hypothesis: *"We can ship a Windows build on Tauri 2.x without dropping macOS 13 support."* Decision criteria documented in ADR 0002; binary outcome is either "plan v2 Tauri port" or "stay on Electron through v2".

## Consequences

**Positive**

- `main.ts` becomes navigable; the IPC registry sits at the top of one ~150-line file with everything else delegated.
- New features land in a single domain module instead of grepping through 1564 lines.
- Per-module Vitest tests catch pure-logic regressions that the Playwright E2E currently can't isolate.
- The Tauri decision gets made with empirical data instead of a hallway poll.
- ADR practice is established; future architecture decisions land in `docs/adr/` with a known shape.

**Negative**

- ~5–7 working days of refactor effort split across the launch window — non-trivial cost, no user-visible benefit during that window.
- The Tauri spike is deferred; the bundle-size and RAM wins that would matter for distribution are not realized for v1.
- Renderer code paths that touch Electron-specific APIs (e.g., `setSinkId`) remain coupled to Electron; if a future spike finds Tauri viable, the renderer will need port-time changes too.

**Neutral**

- The renderer/preload contract is unchanged. No HTML/CSS/JS in `src/*.html` is touched by this refactor.
- Build pipeline is unchanged (`tsc` in-place, no bundler introduced).
- Existing pytest sound/pipeline tests are unaffected.

## Follow-ups

- **PR series #1–#7:** the seven refactor PRs listed above. The accompanying implementation plan (written via the writing-plans skill in the next step) details file-by-file diffs and the validation gate for each PR.
- **ADR 0002 — `tauri-evaluation-spike.md`:** to be written after v1 ships and the spike completes. Captures the empirical answers to the falsifiable hypothesis and the binary v2-runtime decision.
- **ADR 0003 (optional) — Windows audio routing strategy:** if ADR 0002 concludes "stay on Electron" but Windows is still on the roadmap, a separate ADR will record how Windows users will reach a virtual audio driver equivalent to BlackHole (VB-CABLE? bundled installer? user-installs?).
- **Re-evaluate trigger:** if a future macOS minor release ships `setSinkId` for macOS 13 WKWebView, re-run the Tauri spike. Record outcome in a new ADR (not by editing this one).
