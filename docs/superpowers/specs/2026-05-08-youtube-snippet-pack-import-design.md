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
  → write user packs.json with new pack entry, keys mapped in order (q,w,e,r,t,a,s,d,f,g,z,x,c,v,b — 15 max)
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
Selected:   M / N snippets   →   keys q,w,e,r,t,a,s,d,f,g,z,x,c,v,b (15 max)

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
- Hard-cap at 15 selected (keyboard layout: `q,w,e,r,t,a,s,d,f,g,z,x,c,v,b`). UI warns inline above the cap.
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
- `library-create-pack-from-clips`: reject if `clips.length > 15`.

### Out of scope for v1

- Resumable downloads (yt-dlp's own retry covers transient hiccups).
- Concurrent imports (UI disables Detect/Create while one runs).
- Cache eviction.

## Testing

The repo's existing pattern (`test_record_pipeline.py`, `test_youtube_download.py`) is **Python tests that exercise the real binaries** and validate disk side effects, not JS tests with mocked IPC. We follow that pattern for the new pipeline.

### Layer 1 — Python integration test (`tests/test_youtube_pack.py`)

Mirrors the structure of `test_youtube_download.py`. Skips itself if `yt-dlp` or `ffmpeg` is not on PATH. Uses a stable CC0 YouTube video with chapters (TBD — needs to be selected; candidates: a short public-domain compilation, or an internal short upload) so CI can hit the real chain.

Cases:

- **Detect — chapters present.** Call `yt-dlp --dump-single-json` on the test URL, classify the result, assert `kind == 'chapters'` with the expected chapter count and titles.
- **Detect — playlist.** Same with a short playlist URL; assert `kind == 'playlist'` with N items.
- **Detect — no chapters.** A video known to have no chapters; assert `kind == 'none'`.
- **Filter rules.** Pure-Python reimplementation of `filterSnippets` matching the TypeScript version: drop <0.3s, default-uncheck >30s. Tested against synthetic fixture chapter arrays. (Same dual-implementation pattern `test_record_pipeline.py` uses for the ffmpeg invocation.)
- **Key mapping.** Pure-Python reimplementation of `mapSnippetsToKeys`: keys `q,w,e,r,t,a,s,d,f,g,z,x,c,v,b`, truncate at 15.
- **Pack-name slug + collision suffixing.** Synthetic input + reimplementation.
- **End-to-end pipeline replication.** Run yt-dlp + ffmpeg invocations identical to `yt-prepare-pack` against the test URL with two synthetic chapter ranges. Validate two valid `.mp3` files appear in a temp cache. Reuse the `is_valid_mp3` helper from `test_record_pipeline.py`.

The dual-implementation pattern (logic exists in both TypeScript and Python) is a known cost of this testing style — the project already accepts it for `test_record_pipeline.py`. We accept the same trade-off here: it catches binary-invocation regressions, accepts the risk of TS/Python logic drift, and avoids booting Electron in tests.

### Layer 2 — Playwright e2e (`tests/e2e/youtube-pack-import.spec.ts`)

One golden-path spec. Uses the same real CC0 test URL as Layer 1 (or a recorded fixture if CI flakes — see Open Questions).

1. Boot app.
2. Open Sound Manager → click "YouTube Pack" tab.
3. Paste fixture URL → click Detect → assert candidate rows render with chapter titles.
4. Uncheck one row, type pack name, click Create Pack.
5. Wait for completion toast; assert no error states.
6. Close Sound Manager → open Pack Selection → assert new pack appears with the expected keybind count.
7. Trigger one keybind on the board → assert audio source resolves to a `file://` URL (no playback verification).

### Out of scope for testing

- Visual regression on the candidate-review UI.
- Stress tests for long videos / large playlists (caps enforced at IPC layer and exercised in Layer 1).
- IPC-channel-level mock testing (project doesn't do this elsewhere; Playwright e2e is the IPC contract test).

### Open question to resolve before implementation

- **Test URL stability.** Does the project want to use a real public CC0 URL (matching `test_youtube_download.py`'s `aBr2kKAHN6M`), or record a JSON fixture once and replay it? The former is more authentic; the latter is more CI-resilient. Decide during plan-writing.

## File-level change list (preview)

- `main.ts` — three new `ipcMain.handle` blocks; one helper `downloadSourceMp3`; export pure helpers for tests.
- `preload.ts` — expose three new IPC channels.
- `src/sound-manager.html` — third tab + three states (paste / review / import) + sanity-rule logic.
- `tests/test_youtube_pack.py` — Layer 1 (matches existing Python test pattern: `test_youtube_download.py`, `test_record_pipeline.py`).
- `tests/e2e/youtube-pack-import.spec.ts` — Layer 2 e2e.
- Optional: `tests/fixtures/yt-detect/{chapters,playlist,none}.json` — only if we go the recorded-fixture route over real-URL (see test open question).

No changes to: `packs.json` schema, `recordings.json` schema, single-clip YouTube flow, board, settings, packs.html.
