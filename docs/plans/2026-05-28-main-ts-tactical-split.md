# main.ts Tactical Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the 1564-line `main.ts` into nine focused modules under `src/main/` while preserving every observable behavior. The IPC contract surface (channel names) stays identical; only file organization changes.

**Architecture:** Per ADR [0001](../adr/0001-runtime-and-architecture.md): no new abstraction layers, no ports/adapters/repositories. Each new module is a thin file of named async functions called from `main.ts`'s IPC registry. `ipcMain` lives only in `main.ts`. `BrowserWindow`/`Tray` live only in `src/main/windows.ts`.

**Tech Stack:** TypeScript 5, Electron 39, `tsc`-in-place build (no bundler). Vitest 1.x added for per-module unit tests. Existing Playwright E2E remains the integration gate.

**Total scope:** Seven incremental PRs; each PR independently mergeable; app shippable at every step. Estimated 5–7 focused working days spread across the v1 launch window.

---

## Task 0: Setup — Vitest, folder, CI

This is a prep PR. Adds the test runner and the empty target directory. No `main.ts` changes yet.

**Files:**
- Modify: `package.json` (add devDependency + npm script)
- Modify: `package-lock.json` (npm install side effect)
- Create: `src/main/.gitkeep` (so the empty folder is committed)
- Create: `vitest.config.ts`
- Modify: `.github/workflows/ci.yml` (add test:unit job step)

### Steps

- [ ] **Step 1: Branch off main**

```bash
git checkout main && git pull --ff-only
git checkout -b refactor/setup-vitest
```

- [ ] **Step 2: Install Vitest as dev dependency**

```bash
npm install --save-dev vitest@^1.6.0
```

Expected: 1 package added; lockfile updated.

- [ ] **Step 3: Create `vitest.config.ts` at repo root**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: { enabled: false },
  },
});
```

- [ ] **Step 4: Add `test:unit` script to `package.json`**

In the `"scripts"` object, after `"test"`:

```json
"test:unit": "vitest run",
"test:unit:watch": "vitest"
```

- [ ] **Step 5: Create the placeholder module folder**

```bash
mkdir -p src/main tests/unit
touch src/main/.gitkeep tests/unit/.gitkeep
```

- [ ] **Step 6: Add a sanity test that just runs Vitest end-to-end**

Create `tests/unit/sanity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('vitest is wired up', () => {
  it('runs', () => {
    expect(2 + 2).toBe(4);
  });
});
```

- [ ] **Step 7: Run the test runner locally**

```bash
npm run test:unit
```

Expected: 1 file / 1 test passes; runner exits 0.

- [ ] **Step 8: Add `test:unit` to CI**

In `.github/workflows/ci.yml`, find the existing test step inside the `Build & Test` job and add a new step right after it:

```yaml
- name: Vitest (per-module unit tests)
  run: npm run test:unit
```

- [ ] **Step 9: Commit, push, open PR, wait for green, merge**

```bash
git add package.json package-lock.json vitest.config.ts \
        src/main/.gitkeep tests/unit/.gitkeep \
        tests/unit/sanity.test.ts .github/workflows/ci.yml
git commit -m "test(setup): add Vitest runner + src/main/ folder for refactor"
git push -u origin refactor/setup-vitest
gh pr create --title "test(setup): add Vitest + src/main/ for tactical refactor" \
  --body "Per ADR 0001 prep — adds Vitest, the src/main/ target folder, and a CI step. No production code changes."
```

After CI green: `gh pr merge --squash --delete-branch`.

---

## Task 1: Extract `paths.ts` + `tools.ts`

The smallest, lowest-risk extraction. Pure constants and binary-resolution helpers.

**Files:**
- Create: `src/main/paths.ts`
- Create: `src/main/tools.ts`
- Modify: `main.ts` (remove extracted lines, add imports)
- Create: `tests/unit/paths.test.ts` (one smoke test)

**main.ts line ranges to move:**

| To `paths.ts` | To `tools.ts` |
|---|---|
| L14 (`storeFile`) | L363–418 (`TOOL_PATHS`, `bundledFfmpeg`, `findBin`, `spawnPromise`) |
| L19–23 (`userRoot`, `userPacksFile`, `userSoundsDir`, `userRecordingsDir`, `userRecordingsFile`) | |
| L25–28 (`ensureUserDirs`) | |
| L564–569 (`bundledPacksFile`, `bundledSoundsRoot`) | |
| L671–675 (`customSoundsDir`) | |

### Steps

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull --ff-only
git checkout -b refactor/main-paths-tools
```

- [ ] **Step 2: Create `src/main/paths.ts`**

The file's exported surface (copy bodies verbatim from the line ranges above):

```ts
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export const storeFile = (): string =>
  path.join(app.getPath('userData'), 'settings.json');

export const userRoot           = (): string => app.getPath('userData');
export const userPacksFile      = (): string => path.join(userRoot(), 'packs.json');
export const userSoundsDir      = (): string => path.join(userRoot(), 'sounds');
export const userRecordingsDir  = (): string => path.join(userRoot(), 'recordings');
export const userRecordingsFile = (): string => path.join(userRoot(), 'recordings.json');
export const customSoundsDir    = (): string => path.join(userSoundsDir(), 'custom');

export function ensureUserDirs(): void {
  fs.mkdirSync(userSoundsDir(),     { recursive: true });
  fs.mkdirSync(userRecordingsDir(), { recursive: true });
}

export function bundledPacksFile(): string {
  return path.join(__dirname, 'src', 'packs.json');
}

export function bundledSoundsRoot(): string {
  return path.join(__dirname, 'src', 'sounds');
}
```

Note: `storeFile` was a `const` calling `app.getPath()` at module-load; making it a function avoids the "app not ready" trap when imports order shifts.

- [ ] **Step 3: Create `src/main/tools.ts`**

```ts
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';

// Search PATH locations where yt-dlp / ffmpeg are commonly installed on macOS
export const TOOL_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
];

export function bundledFfmpeg(): string | null {
  // (copy body from main.ts:378-382 verbatim)
}

export function findBin(name: string): string {
  // (copy body from main.ts:384-394 verbatim)
}

export function spawnPromise(
  // (copy body from main.ts:396-418 verbatim, including return type)
}
```

- [ ] **Step 4: Wire `main.ts` to import from the new modules**

At the top of `main.ts`, after the existing imports, add:

```ts
import {
  storeFile, userRoot, userPacksFile, userSoundsDir,
  userRecordingsDir, userRecordingsFile, customSoundsDir,
  ensureUserDirs, bundledPacksFile, bundledSoundsRoot,
} from './src/main/paths.js';
import { TOOL_PATHS, bundledFfmpeg, findBin, spawnPromise } from './src/main/tools.js';
```

Note: `.js` suffix on the import path because `tsc` compiles to CommonJS-with-Node-resolution; the resolved file at runtime is `paths.js`.

- [ ] **Step 5: Remove the now-duplicated definitions in `main.ts`**

Delete lines 14–28, 363–418, 564–569, 671–675. Leave `const isDev = …` on line 13 — it's an app-wide flag, not a path/tool concern.

Update any reference to `storeFile` (was a const, now a function): replace `storeFile` with `storeFile()` everywhere in main.ts.

- [ ] **Step 6: Add a sanity test**

Create `tests/unit/paths.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { bundledPacksFile, bundledSoundsRoot } from '../../src/main/paths';

describe('paths', () => {
  it('points bundled paths at the src/ tree relative to compiled main', () => {
    expect(bundledPacksFile()).toMatch(/src[\\\/]packs\.json$/);
    expect(bundledSoundsRoot()).toMatch(/src[\\\/]sounds$/);
  });
});
```

- [ ] **Step 7: Build and verify**

```bash
npm run build
npm run test:unit
npm run test          # pytest sound-pack integrity
npm run test:e2e      # Playwright on Electron — the integration gate
```

Expected: all green; `main.ts` is now ~1450 lines (down ~110).

- [ ] **Step 8: Commit, PR, merge**

```bash
git add main.ts main.js src/main/paths.ts src/main/tools.ts tests/unit/paths.test.ts
git commit -m "refactor(main): extract paths + tools modules"
git push -u origin refactor/main-paths-tools
gh pr create --title "refactor(main): extract paths + tools modules" \
  --body "Task 1 of the ADR-0001 split. Pure helpers (filesystem locations, external binary resolution) moved out of main.ts into src/main/{paths,tools}.ts. No behavior change. Build + unit + pytest + e2e all green locally."
```

Wait for CI green, then squash-merge.

---

## Task 2: Extract `settings.ts`

Settings store + the IPC handlers that read/write it + the side-effect dispatcher.

**Files:**
- Create: `src/main/settings.ts`
- Modify: `main.ts`
- Create: `tests/unit/settings.test.ts`

**main.ts line ranges to move:**

| To `settings.ts` |
|---|
| L30 (`type Store = …`) |
| L32–44 (`readStore`, `writeStore`, `getSetting`, `setSetting`) |
| L281–310 (`applySettingSideEffect`) |

**IPC handlers that delegate to `settings.ts`:**
| Channel | Becomes |
|---|---|
| `get-setting` (L192) | `(_e, k, fb) => settings.get(k, fb)` |
| `get-all-settings` (L193) | `() => settings.readAll()` |
| `app-version` (L194) | `() => app.getVersion()` (stays inline — not settings) |
| `save-setting` (L187–190) | `(_e, k, v) => settings.save(k, v)` |
| `set-volume` (L182) | `(_e, v) => settings.save('volume', v)` |
| `settings-export` (L242–257) | `() => settings.exportToFile(boardWin)` |
| `settings-reset` (L262–268) | `() => settings.reset()` |

### Steps

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull --ff-only && git checkout -b refactor/main-settings
```

- [ ] **Step 2: Create `src/main/settings.ts`**

```ts
import { app, dialog, type BrowserWindow } from 'electron';
import * as fs from 'fs';
import { storeFile } from './paths.js';

export type Store = Record<string, unknown>;

export function readAll(): Store {
  try { return JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Store; }
  catch { return {}; }
}

export function writeAll(data: Store): void {
  try { fs.writeFileSync(storeFile(), JSON.stringify(data, null, 2)); } catch {}
}

export function get<T>(key: string, fallback: T): T {
  return (readAll()[key] as T) ?? fallback;
}

export function save(key: string, val: unknown): void {
  const s = readAll(); s[key] = val; writeAll(s);
}

export async function exportToFile(parent: BrowserWindow | null): Promise<{ ok: boolean; path?: string }> {
  // (copy body from main.ts:242-257 — uses dialog.showSaveDialog)
}

export function reset(): { ok: boolean } {
  // (copy body from main.ts:262-268)
}

// One place for all "this setting changes app behaviour at runtime" effects.
export function applySideEffect(key: string, val: unknown): void {
  // (copy body from main.ts:282-310 — note the function is renamed from
  //  applySettingSideEffect to applySideEffect for the new module namespace)
}
```

- [ ] **Step 3: Wire `main.ts`**

Add import at top:

```ts
import * as settings from './src/main/settings.js';
```

Replace the relevant handlers in main.ts with delegations:

```ts
ipcMain.on('set-volume',   (_e, v: number)               => settings.save('volume', v));
ipcMain.on('save-setting', (_e, key: string, val: unknown) => {
  settings.save(key, val);
  settings.applySideEffect(key, val);
});

ipcMain.handle('get-setting',      (_e, key: string, fb: unknown) => settings.get(key, fb));
ipcMain.handle('get-all-settings', () => settings.readAll());

ipcMain.handle('settings-export', () => settings.exportToFile(boardWin));
ipcMain.handle('settings-reset',  () => settings.reset());
```

- [ ] **Step 4: Remove the now-duplicated code from main.ts**

Delete lines 30, 32–44, 281–310. Replace internal calls to `getSetting`/`setSetting`/`readStore`/`writeStore`/`applySettingSideEffect` with `settings.get`/`settings.save`/`settings.readAll`/`settings.writeAll`/`settings.applySideEffect`.

- [ ] **Step 5: Unit test the side-effect dispatcher**

Create `tests/unit/settings.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

// applySideEffect routes specific keys to specific actions. We don't unit-test
// the actions (they touch BrowserWindow); we verify the routing table.
//
// This requires extracting the routing table out of applySideEffect into a
// pure helper. If that's not feasible inline, skip the unit test and rely on
// the e2e suite; settings already has a Playwright path.

describe('settings module shape', () => {
  it('exports the expected surface', async () => {
    const m = await import('../../src/main/settings');
    expect(typeof m.get).toBe('function');
    expect(typeof m.save).toBe('function');
    expect(typeof m.readAll).toBe('function');
    expect(typeof m.applySideEffect).toBe('function');
  });
});
```

(If a pure helper can be cleanly extracted from `applySideEffect`, write a behavior test for the routing table. Otherwise the shape test above is the floor — settings is mostly e2e-tested already.)

- [ ] **Step 6: Build + verify**

```bash
npm run build && npm run test:unit && npm run test && npm run test:e2e
```

Settings IPC paths exercised by Playwright: theme toggle, volume slider, opacity slider — all must still work.

- [ ] **Step 7: Commit, PR, merge**

```bash
git add main.ts main.js src/main/settings.ts tests/unit/settings.test.ts
git commit -m "refactor(main): extract settings module"
git push -u origin refactor/main-settings
gh pr create --title "refactor(main): extract settings module" \
  --body "Task 2 of ADR-0001 split. readStore/writeStore/getSetting/setSetting/applySideEffect moved to src/main/settings.ts. IPC channels unchanged; renderer code untouched."
```

After CI green: squash-merge.

---

## Task 3: Extract `audio.ts`

Virtual driver detection + accessibility permission flow + walkthrough flag.

**Files:**
- Create: `src/main/audio.ts`
- Modify: `main.ts`
- Create: `tests/unit/audio.test.ts` (this one's the easy win — pure regex match)

**main.ts line ranges to move:**

| To `audio.ts` |
|---|
| L46–54 (`VIRTUAL_DRIVER_RE` const + `isVirtualAudioDevice` function — already exported) |
| L200–220 (`audio-detect-virtual-driver` handler body → `detectVirtualDriver(boardWin)`) |
| L235–238 (`audio-mark-walkthrough-seen` → `markWalkthroughSeen()`) |
| L270–279 (`check-accessibility`, `request-accessibility` → `checkAccessibility()`, `requestAccessibility()`) |

### Steps

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull --ff-only && git checkout -b refactor/main-audio
```

- [ ] **Step 2: Create `src/main/audio.ts`**

```ts
import { systemPreferences, type BrowserWindow } from 'electron';
import * as settings from './settings.js';

export const VIRTUAL_DRIVER_RE = /BlackHole|VB-Cable|Soundflower|Loopback Audio/i;

export function isVirtualAudioDevice(name: string): boolean {
  return VIRTUAL_DRIVER_RE.test(name);
}

export async function detectVirtualDriver(
  boardWin: BrowserWindow | null,
): Promise<{ found: boolean; deviceName?: string }> {
  // (copy body from main.ts:200-220)
}

export function markWalkthroughSeen(): { ok: boolean } {
  // (copy body from main.ts:235-238 — uses settings.save under the hood)
}

export function checkAccessibility(): boolean {
  return systemPreferences.isTrustedAccessibilityClient(false);
}

export function requestAccessibility(): boolean {
  return systemPreferences.isTrustedAccessibilityClient(true);
}
```

- [ ] **Step 3: Wire `main.ts`**

```ts
import * as audio from './src/main/audio.js';

ipcMain.handle('audio-detect-virtual-driver',  () => audio.detectVirtualDriver(boardWin));
ipcMain.handle('audio-mark-walkthrough-seen',  () => audio.markWalkthroughSeen());
ipcMain.handle('check-accessibility',          () => audio.checkAccessibility());
ipcMain.handle('request-accessibility',        () => audio.requestAccessibility());
```

Update internal references to `isVirtualAudioDevice` (if any) to `audio.isVirtualAudioDevice`.

- [ ] **Step 4: Remove from main.ts**

Delete lines 46–54, 200–220, 235–238, 270–279.

- [ ] **Step 5: Unit test the pure helper**

Create `tests/unit/audio.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isVirtualAudioDevice } from '../../src/main/audio';

describe('isVirtualAudioDevice', () => {
  it.each([
    ['BlackHole 2ch', true],
    ['BlackHole 16ch', true],
    ['VB-Cable A', true],
    ['Soundflower (2ch)', true],
    ['Loopback Audio', true],
    ['MacBook Pro Speakers', false],
    ['AirPods Pro', false],
    ['External Headphones', false],
    ['', false],
  ])('matches %s -> %s', (name, expected) => {
    expect(isVirtualAudioDevice(name)).toBe(expected);
  });
});
```

This mirrors `tests/test_blackhole_detection.py` — keep them in sync.

- [ ] **Step 6: Build + verify**

```bash
npm run build && npm run test:unit && npm run test && npm run test:e2e
```

E2E touchpoint: first-run BlackHole walkthrough must still trigger when no virtual driver is present.

- [ ] **Step 7: Commit, PR, merge**

```bash
git add main.ts main.js src/main/audio.ts tests/unit/audio.test.ts
git commit -m "refactor(main): extract audio + accessibility module"
git push -u origin refactor/main-audio
gh pr create --title "refactor(main): extract audio + accessibility module" \
  --body "Task 3 of ADR-0001 split. Virtual driver detection regex (mirrored in tests/test_blackhole_detection.py), accessibility checks, and walkthrough flag move to src/main/audio.ts."
```

After CI green: squash-merge.

---

## Task 4: Extract `recording.ts`

Voice recording CRUD: save, list, delete, rename. Touches fs writes + ffmpeg transcode.

**Files:**
- Create: `src/main/recording.ts`
- Modify: `main.ts`
- Create: `tests/unit/recording.test.ts` (slug/filename helpers only)

**main.ts line ranges to move:**

| To `recording.ts` |
|---|
| L1021–1029 (`interface RecordingMeta`) |
| L1031–1048 (`readRecordings`, `writeRecordings`) |
| L1064–1068 (`interface RecordSaveOpts`) |
| L1070–1126 (`recording-save`, `recording-list` handlers) |
| L1177–1224 (`recording-delete`, `recording-rename` handlers) |

Note: L1050–1062 (`ytCacheDir`, `ytCacheKey`) are NOT recording — they're YouTube cache helpers and stay for Task 5.

### Steps

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull --ff-only && git checkout -b refactor/main-recording
```

- [ ] **Step 2: Create `src/main/recording.ts`**

```ts
import * as fs from 'fs';
import * as path from 'path';
import { userRecordingsDir, userRecordingsFile } from './paths.js';
import { findBin, spawnPromise } from './tools.js';

export interface RecordingMeta {
  // (copy body from main.ts:1021-1029)
}

interface RecordSaveOpts {
  // (copy body from main.ts:1064-1068)
}

export function readAll(): RecordingMeta[] {
  // (copy from main.ts:1031-1037; rename readRecordings -> readAll)
}

function writeAll(list: RecordingMeta[]): void {
  // (copy from main.ts:1038-1048; rename writeRecordings -> writeAll; keep file-local)
}

export async function save(opts: RecordSaveOpts): Promise<{ ok: boolean; id?: string; relPath?: string }> {
  // (copy from main.ts:1070-1113; uses ffmpeg via spawnPromise)
}

export async function remove(id: string): Promise<{ ok: boolean }> {
  // (copy from main.ts:1177-1205; called from recording-delete handler)
}

export function rename(id: string, name: string): { ok: boolean } {
  // (copy from main.ts:1207-1222)
}
```

- [ ] **Step 3: Wire `main.ts`**

```ts
import * as recording from './src/main/recording.js';

ipcMain.handle('recording-save',   (_e, opts) => recording.save(opts));
ipcMain.handle('recording-list',   ()         => recording.readAll());
ipcMain.handle('recording-delete', (_e, id)   => recording.remove(id));
ipcMain.handle('recording-rename', (_e, id, name) => recording.rename(id, name));
```

- [ ] **Step 4: Remove from main.ts**

Delete the line ranges in the table above.

- [ ] **Step 5: Smoke test the public surface**

Create `tests/unit/recording.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('recording module', () => {
  it('exports the expected surface', async () => {
    const m = await import('../../src/main/recording');
    for (const fn of ['save', 'readAll', 'remove', 'rename']) {
      expect(typeof m[fn as keyof typeof m]).toBe('function');
    }
  });
});
```

Deeper behavior is exercised by `tests/test_record_pipeline.py` (existing pytest).

- [ ] **Step 6: Build + verify**

```bash
npm run build && npm run test:unit && npm run test && npm run test:e2e
```

E2E touchpoint: record a sound through the Sound Manager voice tab. End-to-end save must still write a file under `~/Library/Application Support/MeetingBoost/sounds/custom/`.

- [ ] **Step 7: Commit, PR, merge**

```bash
git add main.ts main.js src/main/recording.ts tests/unit/recording.test.ts
git commit -m "refactor(main): extract recording module"
git push -u origin refactor/main-recording
gh pr create --title "refactor(main): extract recording module" \
  --body "Task 4 of ADR-0001 split. Voice recording CRUD moved to src/main/recording.ts. ffmpeg pipeline (covered by tests/test_record_pipeline.py) is unchanged."
```

After CI green: squash-merge.

---

## Task 5: Extract `youtube.ts`

The biggest single chunk (~360 LOC). Snippet helpers, yt-dlp orchestration, prepare-clip and prepare-pack.

**Files:**
- Create: `src/main/youtube.ts`
- Modify: `main.ts`
- Create: `tests/unit/youtube.test.ts` (pure helpers from L453–562)

**main.ts line ranges to move:**

| To `youtube.ts` |
|---|
| L453–462 (`MIN_SNIPPET_SEC`, `MAX_SNIPPET_SEC_AUTOCHECK`, `MAX_KEYS`, `KEY_ORDER`) |
| L465–489 (`RawChapter`, `FilteredSnippet`, `KeyAssignment` types) |
| L525–562 (`DetectMeta`, `PlaylistItem`, `ChapterItem`, `DetectResult` types + pure helpers `filterSnippets`, `mapSnippetsToKeys`, `classifyDetectResult`) |
| L677–731 (`yt-info`, `yt-detect-snippets` handlers) |
| L733–757 (`PrepareClipOpts`) |
| L760–805 (`yt-prepare-clip` handler) |
| L791–805 (`PreparePackSegment`, `PreparePackOpts`) |
| L807–877 (`yt-prepare-pack` handler) |
| L1050–1062 (`ytCacheDir`, `ytCacheKey`) |

### Steps

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull --ff-only && git checkout -b refactor/main-youtube
```

- [ ] **Step 2: Create `src/main/youtube.ts`**

The module is large (~400 LOC). Structure inside the file (top to bottom):

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { userRoot } from './paths.js';
import { findBin, spawnPromise } from './tools.js';

// ── Constants ──────────────────────────────────────────────────────────────
export const MIN_SNIPPET_SEC = 0.3;
export const MAX_SNIPPET_SEC_AUTOCHECK = 30.0;
export const MAX_KEYS = 15;
export const KEY_ORDER = ['q','w','e','r','t','a','s','d','f','g','z','x','c','v','b'];

// ── Types (verbatim from main.ts:465-489 and 525-531) ──────────────────────
export interface RawChapter      { /* … */ }
export interface FilteredSnippet { /* … */ }
export interface KeyAssignment<T>{ /* … */ }
export interface DetectMeta      { /* … */ }
export interface PlaylistItem    { /* … */ }
export interface ChapterItem     { /* … */ }
export type DetectResult         = /* … */;

// ── Pure helpers (mirrored in tests/test_youtube_pack.py — keep in sync) ──
export function filterSnippets(/* … */): /* … */ { /* main.ts:491-507 */ }
export function mapSnippetsToKeys(/* … */): /* … */ { /* main.ts:509-523 */ }
export function classifyDetectResult(/* … */): /* … */ { /* main.ts:533-562 */ }

// ── Cache helpers ──────────────────────────────────────────────────────────
export function cacheDir(): string  { /* main.ts:1050-1054 */ }
export function cacheKey(url: string, start: number, end: number): string { /* main.ts:1056-1062 */ }

// ── IPC-backing functions ──────────────────────────────────────────────────
export async function getInfo(url: string): Promise</* … */> {
  // main.ts:677-700
}

export async function detectSnippets(url: string): Promise<DetectResult> {
  // main.ts:702-731
}

export async function prepareClip(opts: PrepareClipOpts): Promise</* … */> {
  // main.ts:760-789
}

export async function preparePack(opts: PreparePackOpts): Promise</* … */> {
  // main.ts:807-877
}
```

- [ ] **Step 3: Wire `main.ts`**

```ts
import * as youtube from './src/main/youtube.js';

ipcMain.handle('yt-info',             (_e, url)  => youtube.getInfo(url));
ipcMain.handle('yt-detect-snippets',  (_e, url)  => youtube.detectSnippets(url));
ipcMain.handle('yt-prepare-clip',     (_e, opts) => youtube.prepareClip(opts));
ipcMain.handle('yt-prepare-pack',     (_e, opts) => youtube.preparePack(opts));
```

- [ ] **Step 4: Remove from main.ts**

Delete all listed line ranges. Internal references to `filterSnippets`/`mapSnippetsToKeys`/`classifyDetectResult`/`ytCacheDir`/`ytCacheKey` are now in `youtube.*` — update any remaining call sites.

- [ ] **Step 5: Unit test the pure helpers**

Create `tests/unit/youtube.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  filterSnippets,
  mapSnippetsToKeys,
  classifyDetectResult,
  MAX_KEYS, KEY_ORDER,
} from '../../src/main/youtube';

describe('filterSnippets', () => {
  it('drops snippets shorter than MIN_SNIPPET_SEC', () => {
    // build a RawChapter array, call filterSnippets, assert the boundary
  });
  it('auto-unchecks snippets longer than MAX_SNIPPET_SEC_AUTOCHECK', () => {
    // …
  });
  it('caps at MAX_KEYS', () => {
    // …
  });
});

describe('mapSnippetsToKeys', () => {
  it('assigns the first N snippets to KEY_ORDER in order', () => {
    // …
  });
});

describe('classifyDetectResult', () => {
  it('returns playlist-shape when entries are present', () => {
    // …
  });
  it('returns chapters-shape when chapters are present and no entries', () => {
    // …
  });
  it('returns unknown when neither is present', () => {
    // …
  });
});
```

Mirror cases from `tests/test_youtube_pack.py` (the Python test gives you the table of inputs/outputs to assert).

- [ ] **Step 6: Build + verify**

```bash
npm run build && npm run test:unit && npm run test && npm run test:e2e
```

E2E touchpoint: paste a YouTube URL into Sound Manager → YouTube Clip tab; assert the snippet detection round-trip still works. The yt-dlp pipeline is also covered by `tests/test_youtube_download.py` (slow, opt-in).

- [ ] **Step 7: Commit, PR, merge**

```bash
git add main.ts main.js src/main/youtube.ts tests/unit/youtube.test.ts
git commit -m "refactor(main): extract youtube module"
git push -u origin refactor/main-youtube
gh pr create --title "refactor(main): extract youtube module" \
  --body "Task 5 of ADR-0001 split — the largest single extraction. ~360 LOC of yt-dlp orchestration and pure snippet helpers move to src/main/youtube.ts. New Vitest suite asserts the pure helpers against the same cases as tests/test_youtube_pack.py."
```

After CI green: squash-merge.

---

## Task 6: Extract `packs.ts` + `library.ts`

The largest combined chunk (~430 LOC). Pack CRUD + bind/unbind + import/export goes into `packs.ts`. The two `library-*` handlers (which combine youtube + pack operations) go into `library.ts`.

**Files:**
- Create: `src/main/packs.ts`
- Create: `src/main/library.ts`
- Modify: `main.ts`
- Create: `tests/unit/packs.test.ts`

**main.ts line ranges to move:**

| To `packs.ts` | To `library.ts` |
|---|---|
| L420–462 (Pack types, `slugify`) | L879–914 (`library-add-from-clip`) |
| L571–675 minus customSoundsDir (already moved): `tagBundledEntries`, `readBundledPacks`, `inferEntrySource`, `readUserPacks`, `writeUserPacks`, `readPacks`, `resolveEntryPath`, `upsertUserCustomSound`, `refreshBoardIfActivePackIs` | L916–1018 (`CreatePackClip`, `CreatePackOpts`, `library-create-pack-from-clips`) |
| L1128–1175 (`pack-create`, `pack-delete`) | |
| L1225–1306 (`pack-bind-sound`, `pack-unbind-key`, `get-packs`) | |
| L1309–1437 (`PackManifest`, `pack-export`, `pack-import`) | |

### Steps

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull --ff-only && git checkout -b refactor/main-packs-library
```

- [ ] **Step 2: Create `src/main/packs.ts`**

Top-to-bottom structure:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { dialog, type BrowserWindow } from 'electron';
import {
  userPacksFile, userSoundsDir, userRecordingsDir, customSoundsDir,
  bundledPacksFile, bundledSoundsRoot,
} from './paths.js';
import { findBin, spawnPromise } from './tools.js';
import * as settings from './settings.js';

// ── Types (verbatim from main.ts:432-447) ──────────────────────────────────
export type EntrySource = 'bundled' | 'user' | 'recording';
export interface SoundEntry { /* … */ }
export interface PackEntry  { /* … */ }
export interface PackManifest { /* … from main.ts:1309-1316 */ }

// ── Helpers ────────────────────────────────────────────────────────────────
export function slugify(name: string, fallback = 'sound'): string { /* L449-451 */ }
export function tagBundledEntries(p: PackEntry): PackEntry { /* L571-578 */ }
export function inferEntrySource(entry: SoundEntry): SoundEntry { /* L598-608 */ }
export function resolveEntryPath(entry: SoundEntry): string { /* L642-649 */ }

// ── Filesystem reads/writes ────────────────────────────────────────────────
export function readBundled(): PackEntry[] { /* L580-596 */ }
export function readUser(): PackEntry[]    { /* L610-621 */ }
export function writeUser(packs: PackEntry[]): void { /* L623-630 */ }
export function readAll(): PackEntry[]     { /* L632-640 — readPacks */ }
export function upsertUserCustomSound(key: string, label: string, relFile: string): void { /* L651-663 */ }

// ── Pack CRUD ──────────────────────────────────────────────────────────────
export function create(opts: { name: string; description?: string; id?: string }): { ok: boolean; id?: string } {
  // main.ts:1128-1157
}
export function remove(packId: string): { ok: boolean } { /* main.ts:1159-1175 */ }
export function bindSound(opts: { /* … */ }): { ok: boolean } { /* main.ts:1225-1259 */ }
export function unbindKey(packId: string, key: string): { ok: boolean } { /* main.ts:1261-1286 */ }
export function getAll(): PackEntry[]   { /* main.ts:1288-1306 */ }

// ── Import / export ────────────────────────────────────────────────────────
export async function exportPack(packId: string, parent: BrowserWindow | null): Promise<{ ok: boolean; path?: string }> {
  // main.ts:1318-1369
}
export async function importPack(parent: BrowserWindow | null): Promise<{ ok: boolean; id?: string }> {
  // main.ts:1371-1437
}

// ── Live-board refresh ─────────────────────────────────────────────────────
export function refreshBoardIfActivePackIs(packId: string, boardWin: BrowserWindow | null): void {
  // main.ts:665-669; thread boardWin through instead of using a module-level ref
}
```

- [ ] **Step 3: Create `src/main/library.ts`**

```ts
import * as fs from 'fs';
import * as path from 'path';
import { customSoundsDir, ensureUserDirs } from './paths.js';
import { findBin, spawnPromise } from './tools.js';
import * as packs from './packs.js';
import * as youtube from './youtube.js';

interface AddFromClipOpts { /* shape from main.ts:879 */ }
interface CreatePackClip  { /* main.ts:916-919 */ }
interface CreatePackOpts  { /* main.ts:921-938 */ }

export async function addFromClip(opts: AddFromClipOpts): Promise<{ ok: boolean }> {
  // main.ts:879-914
}

export async function createPackFromClips(opts: CreatePackOpts): Promise<{ ok: boolean; id?: string }> {
  // main.ts:940-1018
}
```

- [ ] **Step 4: Wire `main.ts`**

```ts
import * as packs from './src/main/packs.js';
import * as library from './src/main/library.js';

// Pack CRUD
ipcMain.handle('pack-create',      (_e, opts) => packs.create(opts));
ipcMain.handle('pack-delete',      (_e, id)   => packs.remove(id));
ipcMain.handle('pack-bind-sound',  (_e, opts) => packs.bindSound(opts));
ipcMain.handle('pack-unbind-key',  (_e, id, k) => packs.unbindKey(id, k));
ipcMain.handle('get-packs',        ()         => packs.getAll());

// Import / export
ipcMain.handle('pack-export', (_e, id) => packs.exportPack(id, boardWin));
ipcMain.handle('pack-import', ()       => packs.importPack(boardWin));

// Library (combines youtube + packs)
ipcMain.handle('library-add-from-clip',          (_e, opts) => library.addFromClip(opts));
ipcMain.handle('library-create-pack-from-clips', (_e, opts) => library.createPackFromClips(opts));
```

- [ ] **Step 5: Remove from main.ts**

Delete every line range listed in the tables above.

- [ ] **Step 6: Unit test pure helpers**

Create `tests/unit/packs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { slugify, inferEntrySource } from '../../src/main/packs';

describe('slugify', () => {
  it.each([
    ['Hello World', 'hello-world'],
    ['  spaces  ', 'spaces'],
    ['émojis 🎉 strip', 'emojis-strip'],
    ['', 'sound'], // fallback
  ])('%s -> %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});

describe('inferEntrySource', () => {
  it('preserves an explicit source', () => {
    expect(inferEntrySource({ source: 'recording', /* … */ } as any).source).toBe('recording');
  });
  it('infers user for paths in userData', () => {
    // …
  });
  it('infers bundled for paths under src/sounds', () => {
    // …
  });
});
```

Use the exact cases from `tests/test_pack_format.py` where they overlap.

- [ ] **Step 7: Build + verify**

```bash
npm run build && npm run test:unit && npm run test && npm run test:e2e
```

E2E touchpoints: pack switching from the Packs window, voice recording → Custom pack creation, `.mbpack` export → import round-trip (covered by `tests/test_pack_format.py`).

- [ ] **Step 8: Commit, PR, merge**

```bash
git add main.ts main.js src/main/packs.ts src/main/library.ts tests/unit/packs.test.ts
git commit -m "refactor(main): extract packs + library modules"
git push -u origin refactor/main-packs-library
gh pr create --title "refactor(main): extract packs + library modules" \
  --body "Task 6 of ADR-0001 split — the largest combined chunk (~430 LOC). Pack CRUD, bind/unbind, import/export move to src/main/packs.ts. The two library-* IPC handlers (which fuse youtube + packs) move to src/main/library.ts."
```

After CI green: squash-merge.

---

## Task 7: Extract `windows.ts`

The last extraction. Window/tray lifecycle, child-window opener, global keyboard listener, app menu builder. After this, `main.ts` is just app lifecycle + IPC registration.

**Files:**
- Create: `src/main/windows.ts`
- Modify: `main.ts`
- (No new unit tests — windows.ts is all Electron API glue; covered by Playwright)

**main.ts line ranges to move:**

| To `windows.ts` |
|---|
| L56–59 (`boardWin`, `childWin`, `tray`, `isQuitting` module state) |
| L61–101 (`createBoardWindow`) |
| L103–105 (`clamp01`) |
| L107–138 (`openChild`) |
| L140–168 (`createTray`) |
| L171–185 (window IPC: `open-packs`, `open-add-sound`, `open-settings`, `open-board`, `close-window`, `select-pack`) |
| L312–360 (global keyboard capture: `kbListener` state, `KEY_REPEAT_MS`, `startGlobalCapture`, `stopGlobalCapture`) |
| L1439–1564 (`buildAppMenu` + likely app menu hookup) |

### Steps

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull --ff-only && git checkout -b refactor/main-windows
```

- [ ] **Step 2: Create `src/main/windows.ts`**

```ts
import {
  app, BrowserWindow, Tray, nativeImage, Menu, screen, session, shell,
  ipcMain,
} from 'electron';
// ipcMain is intentionally imported here for the small set of window-related
// `ipcMain.on(...)` registrations that are tightly coupled to window state.
// This is the one module that owns window-IPC by design.
import * as path from 'path';
import { pathToFileURL } from 'url';
import { GlobalKeyboardListener } from 'node-global-key-listener';
import * as settings from './settings.js';

// ── Module state ───────────────────────────────────────────────────────────
let boardWin: BrowserWindow | null = null;
let childWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let kbListener: GlobalKeyboardListener | null = null;
let lastFiredKey: string | null = null;
let lastFiredAt = 0;
const KEY_REPEAT_MS = 80;

// ── Exposed getters (other modules need read access) ──────────────────────
export const getBoardWin = (): BrowserWindow | null => boardWin;
export const getChildWin = (): BrowserWindow | null => childWin;
export const setIsQuitting = (v: boolean): void => { isQuitting = v; };

// ── Functions (copy from main.ts line ranges in table above) ──────────────
function clamp01(n: number): number { /* L103-105 */ }
export function createBoardWindow(): void { /* L61-101 */ }
export function openChild(page: string): void { /* L107-138 */ }
export function createTray(): void { /* L140-168 */ }
export function buildAppMenu(): void { /* L1439-end */ }

export function startGlobalCapture(): void { /* L324-356 */ }
export function stopGlobalCapture(): void { /* L358-361 */ }

// ── Window-coupled IPC handlers (the one exception to the "ipcMain only
// lives in main.ts" rule — these are tightly bound to module state) ───────
export function registerWindowIPC(): void {
  ipcMain.on('open-packs',     () => openChild('packs'));
  ipcMain.on('open-add-sound', () => openChild('sound-manager'));
  ipcMain.on('open-settings',  () => openChild('settings'));
  ipcMain.on('open-board',     () => { /* L174-178 */ });
  ipcMain.on('close-window',   (e) => { /* L179-181 */ });
  ipcMain.on('select-pack',    (_e, packId: string) => { /* L183-186 */ });
}
```

**Note on the ipcMain exception:** the ADR says "ipcMain is imported only by main.ts." We deliberately break that rule for this one module because the handlers are tightly coupled to `boardWin`/`childWin` module-level state. Two options were considered:

1. Pass `boardWin`/`childWin` references in/out across the IPC boundary (ugly, lots of plumbing).
2. Let `windows.ts` own its window-IPC registrations and expose a `registerWindowIPC()` to main.ts.

Picked (2). The exception is documented inline. All non-window IPC stays in `main.ts`.

- [ ] **Step 3: Replace state references throughout the codebase**

Anywhere outside `windows.ts` that previously referenced `boardWin`, `childWin`, or `tray`, call `windows.getBoardWin()` / `windows.getChildWin()` instead. The main places this matters are the IPC handlers that pass `boardWin` to `packs.exportPack`, `packs.importPack`, `settings.exportToFile`, etc.

- [ ] **Step 4: Wire `main.ts`**

```ts
import * as windows from './src/main/windows.js';

// In app.whenReady():
windows.createBoardWindow();
windows.createTray();
windows.buildAppMenu();
windows.startGlobalCapture();
windows.registerWindowIPC();

// In app.on('window-all-closed'): nothing changes — windows.ts manages its own.

// Update calls that needed boardWin:
ipcMain.handle('pack-export',     (_e, id)  => packs.exportPack(id, windows.getBoardWin()));
ipcMain.handle('pack-import',     ()        => packs.importPack(windows.getBoardWin()));
ipcMain.handle('settings-export', ()        => settings.exportToFile(windows.getBoardWin()));
ipcMain.handle('audio-detect-virtual-driver', () => audio.detectVirtualDriver(windows.getBoardWin()));
```

- [ ] **Step 5: Remove from main.ts**

Delete every range in the table above.

After this task, `main.ts` should be ~150 lines: imports, `app.whenReady`, IPC registration table (~32 lines of one-liners), `app.on(...)` lifecycle handlers, and `before-quit` cleanup. Walk through it line-by-line — anything that's not lifecycle or one-line IPC delegation should already live in a module.

- [ ] **Step 6: Build + verify**

```bash
npm run build && npm run test:unit && npm run test && npm run test:e2e
```

This is the riskiest task because module-level state moved. Pay close attention to:
- Global shortcut (`Alt+Shift+M`) still toggles the board
- Tray still appears + click toggles board
- Quit flow still works (cmd+Q)
- Letter keypresses still fire sounds (global capture)
- Pack export/import still launches Save/Open dialogs from the right parent window

- [ ] **Step 7: Commit, PR, merge**

```bash
git add main.ts main.js src/main/windows.ts
git commit -m "refactor(main): extract windows module + slim main.ts to ~150 lines"
git push -u origin refactor/main-windows
gh pr create --title "refactor(main): extract windows module + slim main.ts" \
  --body "Final task of ADR-0001 split. Window/tray lifecycle, child-window opener, global keyboard listener, app menu builder move to src/main/windows.ts. main.ts is now ~150 lines: app lifecycle + IPC registration table. windows.ts is the one module that owns its window-coupled ipcMain.on registrations (documented inline)."
```

After CI green: squash-merge.

---

## Final state

After Task 7 merges, the repository should contain:

```
main.ts                       # ~150 lines: app lifecycle + IPC registry
src/main/
  paths.ts                    # filesystem locations
  tools.ts                    # external binary resolution
  settings.ts                 # settings store + side-effect dispatcher
  audio.ts                    # virtual driver detection + a11y
  recording.ts                # voice recording CRUD
  youtube.ts                  # yt-dlp pipeline + snippet helpers
  packs.ts                    # pack CRUD + import/export
  library.ts                  # cross-cutting library handlers
  windows.ts                  # window/tray/keyboard + window-coupled IPC
tests/unit/
  paths.test.ts
  settings.test.ts
  audio.test.ts
  recording.test.ts
  youtube.test.ts
  packs.test.ts
  sanity.test.ts
```

Run this to verify final state:

```bash
wc -l main.ts src/main/*.ts          # main.ts ~150; modules sum ~1450
npm run build                        # tsc compiles
npm run test:unit                    # all Vitest passes
npm run test                         # all pytest passes
npm run test:e2e                     # Playwright passes
```

## Follow-ups (not in this plan)

- **ADR 0002** — Tauri evaluation spike (post-v1). See ADR 0001 §Follow-ups.
- If `windows.ts` end-states larger than 250 LOC, consider a future split between window lifecycle and global keyboard capture. Defer until the file actually feels painful.
- The "settings.ts owns the side-effect dispatcher but needs `boardWin` for theme broadcast" coupling is a minor smell. Acceptable for now — revisit only if a third module wants the same broadcast pattern.
