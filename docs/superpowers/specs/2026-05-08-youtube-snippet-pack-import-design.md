# YouTube Snippet → Auto Pack Import

**Status:** Approved (design)
**Date:** 2026-05-08
**Author:** brainstormed with Claude Code (superpowers)

## Goal

Let a user paste a YouTube URL and get a ready-to-use sound pack created from the video's chapters or the playlist's videos — without manually scrubbing timestamps for each snippet. This is a wedge feature for "ease the generation of sound packs."

## Non-goals

- Reordering, re-keying, or thumbnailing snippets inside the import flow. The existing Pack Management screen handles rebinding after import.
- Resuming partial downloads on app restart.
- Concurrent imports.
- Cache eviction (orthogonal housekeeping).
- AI-assisted snippet detection (silence-split, ASR). Single videos without chapters are routed back to the existing single-clip flow.

## Scope summary

| Dimension | Decision |
|---|---|
| Input | Any YouTube URL — single video or playlist |
| Detection (single video) | YouTube chapter metadata only; no chapters → bounce to existing YouTube Clip tab |
| Detection (playlist) | Each video becomes one candidate, named by video title |
| Output | New user pack auto-created in `packs.json`, snippets bound to keys in chapter/playlist order |
| UI surface | Third tab in Sound Manager: "YouTube Pack" |
| Architecture | Approach A — extend existing IPC, reuse cache + binaries |

## Architecture

A new tab in `sound-manager.html` is the single user-facing surface. Three new IPC handlers run in main:

```
yt-detect-snippets(url)
  → spawns yt-dlp --dump-single-json (with --flat-playlist when list= present)
  → returns { kind: 'playlist' | 'chapters' | 'none', items[] | chapters[], meta }

yt-prepare-pack(url, segments[])
  → downloadSourceMp3(url) ONCE (skipped if every segment is already cached)
  → for each segment: ffmpeg cut into .cache/yt/<ytCacheKey(url,start,end)>.mp3
  → returns { ok, prepared:[{cachePath, title, durationMs}], failed:[{title, error}] }

library-create-pack-from-clips(packName, clips[])
  → copy each clip → userSoundsDir()/custom/yt-<id>.mp3
  → write user packs.json with new pack entry, keys mapped in order (q,w,e,r,t,a,s,d,f,g,z,x,c,v,b,…)
  → emits 'packs-changed' to all windows
  → returns { ok, packId, finalName }
```

**Invariants preserved:**

- `yt-info` and `yt-prepare-clip` (single-clip flow) are not modified.
- `.cache/yt/` cache layout and `ytCacheKey(url,start,end)` are reused. Snippets previewed via the existing single-clip flow populate the same cache that bulk-import consumes, and vice versa.
- `packs.json` schema is unchanged. New packs use `origin: 'user'`.

**Single shared-helper extraction:** `downloadSourceMp3(url) → tmpPath` is factored out of the existing `yt-prepare-clip` body. The single-clip handler keeps its current observable shape (no behavior change). This is the only refactor — Approach A explicitly resists Approach C's broader extraction.

## UI / Candidate Review

Three states inside the new "YouTube Pack" tab:

### State 1 — Paste

```
YouTube URL  [ https://youtube.com/watch?v=…             ] [ Detect ]
Tip: Paste a playlist URL or a video with chapters.
Single videos without chapters: use the "YouTube Clip" tab.
```

### State 2 — Review

```
📺  <video or playlist title>
Detected: N items · total duration · approx download size

┌───────────────────────────────────────────────────────────────┐
│  ☑  ▶  Cat scream            0:00–0:06   (6s)                 │
│  ☑  ▶  Anvil drop            0:06–0:11   (5s)                 │
│  ☐  ▶  [skipped: 47s]        0:11–0:58              [too long]│
│  …                                                            │
└───────────────────────────────────────────────────────────────┘

Pack name:  [ <prefilled from video/playlist title>           ]
Selected:   M / N snippets   →   keys q,w,e,r,t,a,s,d,f,…

                                       [ Cancel ] [ Create Pack ]
```

### State 3 — Import progress

```
Downloading source…              ████████████░░░░░░  62%
Cutting snippet 7 of 14…
(cancel anytime — cache is preserved for next attempt)
```

**Sanity rules** (operator brand: minimal, non-blocking):

- Auto-uncheck snippets > 30s. Visible with `[too long]` caption; user can re-check.
- Drop snippets < 0.3s silently.
- Hard-cap at 21 selected (keyboard layout). UI warns inline above the cap.
- Playlist render cap at 50 entries; above that, show overflow message.
- Single video that also carries `list=` triggers a one-time disambiguation prompt: *"Just this video"* vs *"Whole playlist."*

**Preview behavior:** the row ▶ button calls the existing `yt-prepare-clip` handler. This warms the cache, so when the user clicks Create Pack, those segments skip the cut step.

## Data flow

```
USER             RENDERER                          MAIN                     DISK
────             ────────                          ────                     ────

paste URL ─►     ytPasteUrl
click Detect ─► ipc.invoke('yt-detect-snippets')
                                                   yt-dlp --dump-single-json
                                                   classify into kind
                ◄─ DetectResult

apply filters; render review list

click ▶ ────►   ipc.invoke('yt-prepare-clip')                                .cache/yt/<hash>.mp3
                                                   (existing handler)        ◀─ download+cut

click Create ──►ipc.invoke('yt-prepare-pack', segments)
                                                   downloadSourceMp3(url) ─► /tmp/mb_pack_*.mp3
                                                     skipped if all cached
                                                   for each segment:
                                                     cache hit → skip
                                                     else ffmpeg cut ──────► .cache/yt/<hash>.mp3
                                                   delete /tmp source
                ◄─ {prepared[], failed[]}

                ipc.invoke('library-create-pack-from-clips', packName, clips)
                                                   copy each → custom/yt-*.mp3
                                                   write user packs.json
                                                   emit 'packs-changed'
                ◄─ {ok, packId, finalName}

board reloads → new pack appears
```

**Storage layout decision:** snippets imported as part of a pack land under `userSoundsDir()/custom/yt-<id>.mp3` and are registered in `packs.json` only — **not** in `recordings.json`. Library inventory stays focused on unbound clips. Snippets created by the existing single-clip flow remain in `recordings.json` as today.

**Cache reuse property:** the worst case ("user previews zero rows then clicks Create") is one full source download. Best case ("user previewed every row") is zero downloads — `yt-prepare-pack` short-circuits when every segment hits the cache.

## Error handling

### Stage 1 — Detect

| Failure | Handling |
|---|---|
| `yt-dlp` not on PATH | Existing `findBin` error reused: *"Install yt-dlp via Homebrew."* |
| Network / 429 / private / age-gated | Map common stderr patterns to short user-facing strings; generic catchall otherwise. |
| `kind: 'none'` (no chapters, not a playlist) | Inline message + one-click button that switches to the YouTube Clip tab and prefills the URL. |
| All snippets filtered out post-detect | *"No usable snippets — chapters are too long or too short."* + same switch-tab button. |
| URL has both video id and `list=` | Disambiguation prompt: *"Just this video"* vs *"Whole playlist."* |

### Stage 2 — Prepare pack

| Failure | Handling |
|---|---|
| Source download fails | Abort; previously-cached segments survive; user can retry, retry is fast for cached segments. |
| Single ffmpeg cut fails | **Continue, don't abort.** That snippet is reported in `failed[]`; pack is created from the rest. Renderer shows red glyph + Retry link on the failed row. |
| User clicks Cancel | Send cancel signal; main kills in-flight child processes, deletes half-written cache for the **current** segment only, preserves all completed cache files. No `packs.json` write. |
| Disk full | Surface OS error, abort. Cache survives. |

### Stage 3 — Library + pack creation

Only stage with rollback because it touches user-visible state.

```
1. for each clip:
     copy cachePath → userSoundsDir()/custom/yt-<id>.mp3
     track copied paths
2. write user packs.json with new pack entry
3. emit 'packs-changed'

if step 1 fails on clip N:
  delete the N-1 already-copied files; return error

if step 2 fails:
  delete ALL files copied in step 1; return error
```

`packs.json` is written last, so a process crash between steps 1 and 2 leaks at most a few orphaned mp3 files — not a broken pack reference.

| Failure | Handling |
|---|---|
| Pack name already exists | Auto-suffix `(2)`, `(3)`, … Toast confirms final name. No blocking prompt. |
| Empty/whitespace pack name | Fall back to video/playlist title; if also empty, `"YouTube Pack"`. |
| Slugify produces empty id | Append `<unix_ms>` to the id. |

### Cross-cutting defensive caps (IPC layer)

Even though the UI enforces these visually, the main-process handlers re-check:

- `yt-prepare-pack`: reject if `segments.length > 100`.
- `yt-prepare-pack`: reject any segment with `end - start > 60` or `< 0.1`.
- `library-create-pack-from-clips`: reject if `clips.length > 21`.

### Out of scope for v1

- Resumable downloads (yt-dlp's own retry covers transient hiccups).
- Concurrent imports (UI disables Detect/Create while one runs).
- Cache eviction.

## Testing

### Layer 1 — Unit tests on pure functions

Extract these into testable helpers, no Electron, no spawn:

| Function | Coverage |
|---|---|
| `classifyDetectResult(json)` | playlist+video URL ambiguity, missing chapters, empty chapters, single-entry playlist |
| `filterSnippets(chapters, {minSec, maxSec})` | drop <0.3s, default-uncheck >30s, preserve order, preserve original index |
| `mapSnippetsToKeys(snippets)` | pack-key order; truncate at 21; report overflow count |
| `slugifyPackName(name, existing[])` | collision suffixing; empty/whitespace fallback |
| `ytCacheKey(url, start, end)` | extend existing coverage: equal start/end, very long URLs |

### Layer 2 — Integration tests with mocked binaries

Stub `yt-dlp` and `ffmpeg` via shell scripts in `tests/fixtures/mock-bin/`:

- `yt-dlp` — reads `$MOCK_YTDLP_FIXTURE` env var, prints fixture contents.
- `ffmpeg` — creates an empty `.mp3` at the output path; exits non-zero if `MOCK_FFMPEG_FAIL` set.

Fixtures cover: chapters-only video, playlist, no-chapters video, private-video error.

Tests exercise handler bodies as plain functions (export them from `main.ts` for test access — same pattern as existing testable helpers).

Coverage:

- `yt-detect-snippets` per fixture kind.
- `yt-prepare-pack` happy path: 3 segments → 3 cache files written.
- `yt-prepare-pack` partial failure: segment 2's ffmpeg fails → result reports 2 ok, 1 failed, no abort.
- `library-create-pack-from-clips` happy path: 3 files + `packs.json` entry.
- `library-create-pack-from-clips` rollback on fs error.

### Layer 3 — One Playwright e2e (golden path)

Add `tests/e2e/youtube-pack-import.spec.ts`:

1. Boot app with mock-bin fixtures on PATH via env.
2. Open Sound Manager → click "YouTube Pack" tab.
3. Paste fixture URL → click Detect → assert 3 candidate rows render with correct titles.
4. Uncheck row 2, type pack name, click Create Pack.
5. Wait for completion toast.
6. Close Sound Manager → open Pack Selection → assert new pack appears with 2 keybinds.
7. Trigger one keybind on the board → assert audio source loads (file:// resolves; no playback verification).

### Out of scope for testing

- Real YouTube fetches in CI (flaky, brittle, slow — mock-bin covers the contract).
- Visual regression on the candidate-review UI.
- Stress tests for long videos / large playlists (caps enforced and unit-tested).

## File-level change list (preview)

- `main.ts` — three new `ipcMain.handle` blocks; one helper `downloadSourceMp3`; export pure helpers for tests.
- `preload.ts` — expose three new IPC channels.
- `src/sound-manager.html` — third tab + three states (paste / review / import) + sanity-rule logic.
- `tests/test_youtube_pack.js` (or similar; match existing style) — Layer 1 + 2.
- `tests/fixtures/mock-bin/{yt-dlp,ffmpeg}` — mock binaries.
- `tests/fixtures/yt-detect/{chapters,playlist,none,private-error}.json` — JSON fixtures.
- `tests/e2e/youtube-pack-import.spec.ts` — Layer 3 e2e.

No changes to: `packs.json` schema, `recordings.json` schema, single-clip YouTube flow, board, settings, packs.html.
