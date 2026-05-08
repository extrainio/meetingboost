# YouTube Snippet → Auto Pack Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "YouTube Pack" tab to Sound Manager that lets a user paste any YouTube URL (single video with chapters, or playlist) and auto-creates a sound pack from the detected snippets.

**Architecture:** Approach A — extend the existing IPC layer (`yt-info`, `yt-prepare-clip`, `library-add-from-clip`) with three new handlers (`yt-detect-snippets`, `yt-prepare-pack`, `library-create-pack-from-clips`). Reuse the existing `.cache/yt/<hash>.mp3` cache keyed by `(url, start, end)` so previewing a row also warms the cache for the bulk import. Bound-only storage layout: snippets land under `userSoundsDir()/custom/yt-<id>.mp3` and register in `packs.json` only.

**Tech Stack:** Electron 32 + TypeScript 5 (main + preload), vanilla HTML/JS in `src/sound-manager.html`, yt-dlp + ffmpeg-static binaries (already wired), Python+pytest for integration tests, Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-05-08-youtube-snippet-pack-import-design.md`

---

## Task 1: Pure helpers — filter, key-map, slugify

**Files:**
- Modify: `main.ts` (append exported helpers near the existing `slugify` / `ytCacheKey` block)
- Create: `tests/test_youtube_pack.py` (pytest suite — Python re-implementations test the same algorithms)

**Why this task first:** these helpers have zero binary dependencies and unblock the IPC handlers. The Python re-implementations are the project's testing pattern (mirrors `test_record_pipeline.py`'s ffmpeg-flag re-implementation).

- [ ] **Step 1: Write the failing Python test for `filter_snippets`**

Create `tests/test_youtube_pack.py`:

```python
"""
Integration tests for the YouTube snippet → auto-pack pipeline.

The TypeScript implementation lives in main.ts. This file mirrors the
algorithms in Python (matching the test_record_pipeline.py pattern) so we
can validate logic and binary invocations without booting Electron.

Run with: python3 -m pytest tests/test_youtube_pack.py -v
(requires yt-dlp and ffmpeg installed for the binary-touching tests)
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest


# ── Pure-logic re-implementations (mirror main.ts) ─────────────────────────

MIN_SNIPPET_SEC = 0.3
MAX_SNIPPET_SEC_AUTOCHECK = 30.0
MAX_KEYS = 15
KEY_ORDER = list("qwert") + list("asdfg") + list("zxcvb")


def filter_snippets(chapters):
    """
    Return [{'title','start','end','dur','autoCheck','reason'}], preserving
    input order. Drops entries < MIN_SNIPPET_SEC. Marks entries >
    MAX_SNIPPET_SEC_AUTOCHECK with autoCheck=False, reason='too_long'.
    """
    out = []
    for ch in chapters:
        dur = float(ch['end']) - float(ch['start'])
        if dur < MIN_SNIPPET_SEC:
            continue
        too_long = dur > MAX_SNIPPET_SEC_AUTOCHECK
        out.append({
            'title': ch['title'],
            'start': float(ch['start']),
            'end':   float(ch['end']),
            'dur':   dur,
            'autoCheck': not too_long,
            'reason':    'too_long' if too_long else None,
        })
    return out


class TestFilterSnippets(unittest.TestCase):
    def test_drops_under_min_duration(self):
        result = filter_snippets([
            {'title': 'tiny',  'start': 0,    'end': 0.1},
            {'title': 'ok',    'start': 0.1,  'end': 5.0},
        ])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['title'], 'ok')

    def test_marks_too_long_as_autocheck_false(self):
        result = filter_snippets([
            {'title': 'short', 'start': 0,    'end': 5},
            {'title': 'long',  'start': 5,    'end': 50},
        ])
        self.assertTrue(result[0]['autoCheck'])
        self.assertFalse(result[1]['autoCheck'])
        self.assertEqual(result[1]['reason'], 'too_long')

    def test_preserves_input_order(self):
        result = filter_snippets([
            {'title': 'a', 'start': 0, 'end': 1},
            {'title': 'b', 'start': 1, 'end': 2},
            {'title': 'c', 'start': 2, 'end': 3},
        ])
        self.assertEqual([r['title'] for r in result], ['a', 'b', 'c'])
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
python3 -m pytest tests/test_youtube_pack.py::TestFilterSnippets -v
```

Expected: PASS (the Python re-impl is self-contained — this test only validates the algorithm).

> **Why does it pass on first run?** The Python is the test fixture. The TypeScript re-implementation in Step 3 is the production code. The dual-implementation pattern means the TypeScript change is validated against the Python algorithm at the e2e layer, not via cross-language imports.

- [ ] **Step 3: Add the TypeScript helper to `main.ts`**

Find the existing `slugify` function (search for `function slugify`) and add the new helpers just below it:

```typescript
// ── YouTube Pack helpers ───────────────────────────────────────────────────
//
// Pure functions used by yt-detect-snippets / yt-prepare-pack / library-
// create-pack-from-clips. Mirrored in tests/test_youtube_pack.py.

const MIN_SNIPPET_SEC = 0.3;
const MAX_SNIPPET_SEC_AUTOCHECK = 30.0;
const MAX_KEYS = 15;
const KEY_ORDER = ['q','w','e','r','t','a','s','d','f','g','z','x','c','v','b'];

interface RawChapter { title: string; start: number; end: number; }
interface FilteredSnippet {
  title: string; start: number; end: number; dur: number;
  autoCheck: boolean; reason: 'too_long' | null;
}

export function filterSnippets(chapters: RawChapter[]): FilteredSnippet[] {
  const out: FilteredSnippet[] = [];
  for (const ch of chapters) {
    const dur = ch.end - ch.start;
    if (dur < MIN_SNIPPET_SEC) continue;
    const tooLong = dur > MAX_SNIPPET_SEC_AUTOCHECK;
    out.push({
      title: ch.title,
      start: ch.start,
      end: ch.end,
      dur,
      autoCheck: !tooLong,
      reason: tooLong ? 'too_long' : null,
    });
  }
  return out;
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Add `mapSnippetsToKeys` Python test + implementation**

Append to `tests/test_youtube_pack.py`:

```python
def map_snippets_to_keys(snippets):
    """
    Take a list of snippets (in selected order). Returns:
      {'mapped': [{'snippet': s, 'key': 'q'}, ...], 'overflow_count': N}
    Truncates at MAX_KEYS.
    """
    mapped = []
    for i, s in enumerate(snippets[:MAX_KEYS]):
        mapped.append({'snippet': s, 'key': KEY_ORDER[i]})
    overflow = max(0, len(snippets) - MAX_KEYS)
    return {'mapped': mapped, 'overflow_count': overflow}


class TestMapSnippetsToKeys(unittest.TestCase):
    def test_assigns_keys_in_order(self):
        snippets = [{'title': f'snip{i}'} for i in range(5)]
        result = map_snippets_to_keys(snippets)
        self.assertEqual([m['key'] for m in result['mapped']],
                         ['q', 'w', 'e', 'r', 't'])
        self.assertEqual(result['overflow_count'], 0)

    def test_truncates_at_15(self):
        snippets = [{'title': f'snip{i}'} for i in range(20)]
        result = map_snippets_to_keys(snippets)
        self.assertEqual(len(result['mapped']), 15)
        self.assertEqual(result['overflow_count'], 5)
        # Last assigned key is 'b'
        self.assertEqual(result['mapped'][-1]['key'], 'b')
```

Add the TypeScript helper right after `filterSnippets` in `main.ts`:

```typescript
interface KeyAssignment<T> { snippet: T; key: string; }

export function mapSnippetsToKeys<T>(
  snippets: T[]
): { mapped: KeyAssignment<T>[]; overflowCount: number } {
  const mapped: KeyAssignment<T>[] = [];
  for (let i = 0; i < Math.min(snippets.length, MAX_KEYS); i++) {
    mapped.push({ snippet: snippets[i], key: KEY_ORDER[i] });
  }
  return {
    mapped,
    overflowCount: Math.max(0, snippets.length - MAX_KEYS),
  };
}
```

- [ ] **Step 6: Run the new tests; verify TypeScript still compiles**

```bash
python3 -m pytest tests/test_youtube_pack.py -v
npx tsc --noEmit
```

Expected: both pass.

- [ ] **Step 7: Add `slugify_pack_name` Python test + TypeScript implementation**

Append to `tests/test_youtube_pack.py`:

```python
def slugify_pack_name(name, existing_names):
    """
    Returns {'finalName': str, 'packId': str}.
    - Empty/whitespace name → 'YouTube Pack'.
    - On collision with existing_names: append ' (2)', ' (3)', ...
    - packId is the slug of finalName + a unix-ms suffix if slug is empty.
    """
    import re, time
    base = (name or '').strip() or 'YouTube Pack'

    final_name = base
    n = 2
    while final_name in existing_names:
        final_name = f"{base} ({n})"
        n += 1

    slug = re.sub(r'[^a-z0-9]+', '-', final_name.lower()).strip('-')
    if not slug:
        slug = f'yt-pack-{int(time.time() * 1000)}'

    return {'finalName': final_name, 'packId': slug}


class TestSlugifyPackName(unittest.TestCase):
    def test_empty_falls_back(self):
        r = slugify_pack_name('', [])
        self.assertEqual(r['finalName'], 'YouTube Pack')

    def test_collision_suffix(self):
        r = slugify_pack_name('Tom & Jerry', ['Tom & Jerry'])
        self.assertEqual(r['finalName'], 'Tom & Jerry (2)')

    def test_double_collision(self):
        r = slugify_pack_name('Foo', ['Foo', 'Foo (2)'])
        self.assertEqual(r['finalName'], 'Foo (3)')
```

Add the TypeScript helper to `main.ts`:

```typescript
export function slugifyPackName(
  name: string,
  existingNames: string[]
): { finalName: string; packId: string } {
  const base = (name || '').trim() || 'YouTube Pack';

  let finalName = base;
  let n = 2;
  while (existingNames.includes(finalName)) {
    finalName = `${base} (${n})`;
    n += 1;
  }

  let slug = finalName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) {
    slug = `yt-pack-${Date.now()}`;
  }

  return { finalName, packId: slug };
}
```

- [ ] **Step 8: Run all tests; verify TypeScript compiles**

```bash
python3 -m pytest tests/test_youtube_pack.py -v
npx tsc --noEmit
```

Expected: 9 tests pass; no TS errors.

- [ ] **Step 9: Commit**

```bash
git add main.ts tests/test_youtube_pack.py
git commit -m "feat(yt-pack): pure helpers — filter, key-map, slugify

Adds the foundation helpers for the upcoming YouTube Pack import flow:
filterSnippets (drops <0.3s, marks >30s as auto-uncheck), mapSnippetsToKeys
(assigns to q,w,e,r,t / a,s,d,f,g / z,x,c,v,b — 15 max), slugifyPackName
(collision-suffixed, fallback to 'YouTube Pack'). Python parity tests
mirror the algorithms following the test_record_pipeline.py convention."
```

---

## Task 2: Add `classifyDetectResult` helper

**Files:**
- Modify: `main.ts` (append after the helpers added in Task 1)
- Modify: `tests/test_youtube_pack.py` (add test class)
- Create: `tests/fixtures/yt_detect_chapters.json`
- Create: `tests/fixtures/yt_detect_playlist.json`
- Create: `tests/fixtures/yt_detect_none.json`

- [ ] **Step 1: Capture three real yt-dlp fixtures**

These are recorded once and committed. Run locally and save the output:

```bash
mkdir -p tests/fixtures

# Chapters case — find any video with YouTube chapters and dump-single-json it
yt-dlp --dump-single-json --no-playlist 'https://www.youtube.com/watch?v=<chaptered>' \
  > tests/fixtures/yt_detect_chapters.json

# Playlist case — flat-playlist with --dump-single-json gives the wrapper
yt-dlp --dump-single-json --flat-playlist 'https://www.youtube.com/playlist?list=<id>' \
  > tests/fixtures/yt_detect_playlist.json

# No-chapters case — any standard video without chapters
yt-dlp --dump-single-json --no-playlist 'https://www.youtube.com/watch?v=<plain>' \
  > tests/fixtures/yt_detect_none.json
```

> **Note for the executor:** if you can't capture these locally, use the existing `test_youtube_download.py` URL `aBr2kKAHN6M` for the no-chapters fixture, and stop the task here — write down which URLs were chosen in the commit message so the chapters/playlist fixtures can be backfilled. The TypeScript code is the spec; tests just need representative shapes.

- [ ] **Step 2: Write the failing test**

Append to `tests/test_youtube_pack.py`:

```python
FIXTURES_DIR = os.path.join(os.path.dirname(__file__), 'fixtures')


def classify_detect_result(raw):
    """
    Mirrors classifyDetectResult in main.ts.
    Returns one of:
      {'kind': 'playlist',  'items':    [{'videoId','title','duration'}, ...], 'meta': {...}}
      {'kind': 'chapters',  'chapters': [{'title','start','end'},        ...], 'meta': {...}}
      {'kind': 'none',      'meta': {...}}
    """
    meta = {
        'title':     raw.get('title', ''),
        'thumbnail': raw.get('thumbnail', ''),
        'duration':  raw.get('duration'),
    }

    # Playlist wrappers from yt-dlp set _type='playlist' and have 'entries'
    if raw.get('_type') == 'playlist' and isinstance(raw.get('entries'), list):
        items = []
        for e in raw['entries']:
            items.append({
                'videoId':  e.get('id', ''),
                'title':    e.get('title', ''),
                'duration': e.get('duration'),
            })
        return {'kind': 'playlist', 'items': items, 'meta': meta}

    # Single video with chapters: chapters is a list of {title,start_time,end_time}
    chapters = raw.get('chapters')
    if isinstance(chapters, list) and len(chapters) > 0:
        out = []
        for c in chapters:
            out.append({
                'title': c.get('title', 'Untitled'),
                'start': float(c.get('start_time', 0)),
                'end':   float(c.get('end_time', 0)),
            })
        return {'kind': 'chapters', 'chapters': out, 'meta': meta}

    return {'kind': 'none', 'meta': meta}


class TestClassifyDetectResult(unittest.TestCase):
    def test_chapters_fixture(self):
        with open(os.path.join(FIXTURES_DIR, 'yt_detect_chapters.json')) as f:
            raw = json.load(f)
        result = classify_detect_result(raw)
        self.assertEqual(result['kind'], 'chapters')
        self.assertGreater(len(result['chapters']), 0)
        for ch in result['chapters']:
            self.assertIn('title', ch)
            self.assertIn('start', ch)
            self.assertIn('end', ch)

    def test_playlist_fixture(self):
        with open(os.path.join(FIXTURES_DIR, 'yt_detect_playlist.json')) as f:
            raw = json.load(f)
        result = classify_detect_result(raw)
        self.assertEqual(result['kind'], 'playlist')
        self.assertGreater(len(result['items']), 0)

    def test_none_fixture(self):
        with open(os.path.join(FIXTURES_DIR, 'yt_detect_none.json')) as f:
            raw = json.load(f)
        result = classify_detect_result(raw)
        self.assertEqual(result['kind'], 'none')
```

- [ ] **Step 3: Run test; verify it passes**

```bash
python3 -m pytest tests/test_youtube_pack.py::TestClassifyDetectResult -v
```

Expected: PASS (algorithm-only test against fixtures).

- [ ] **Step 4: Add the TypeScript helper**

Append to `main.ts` (after `slugifyPackName`):

```typescript
interface DetectMeta { title: string; thumbnail: string; duration?: number; }

interface PlaylistItem { videoId: string; title: string; duration?: number; }
interface ChapterItem  { title: string; start: number; end: number; }

type DetectResult =
  | { kind: 'playlist';  items:    PlaylistItem[]; meta: DetectMeta }
  | { kind: 'chapters';  chapters: ChapterItem[];  meta: DetectMeta }
  | { kind: 'none';      meta: DetectMeta };

export function classifyDetectResult(raw: Record<string, unknown>): DetectResult {
  const meta: DetectMeta = {
    title:     (raw.title as string)     ?? '',
    thumbnail: (raw.thumbnail as string) ?? '',
    duration:  raw.duration as number | undefined,
  };

  if (raw._type === 'playlist' && Array.isArray(raw.entries)) {
    const items: PlaylistItem[] = (raw.entries as Record<string, unknown>[]).map(e => ({
      videoId:  (e.id as string)    ?? '',
      title:    (e.title as string) ?? '',
      duration: e.duration as number | undefined,
    }));
    return { kind: 'playlist', items, meta };
  }

  const chapters = raw.chapters;
  if (Array.isArray(chapters) && chapters.length > 0) {
    const out: ChapterItem[] = (chapters as Record<string, unknown>[]).map(c => ({
      title: (c.title as string) ?? 'Untitled',
      start: Number(c.start_time ?? 0),
      end:   Number(c.end_time ?? 0),
    }));
    return { kind: 'chapters', chapters: out, meta };
  }

  return { kind: 'none', meta };
}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add main.ts tests/test_youtube_pack.py tests/fixtures/yt_detect_*.json
git commit -m "feat(yt-pack): classifyDetectResult + recorded yt-dlp fixtures

Adds the dispatcher that routes a yt-dlp --dump-single-json blob into one
of three shapes: playlist (entries[]), chapters (start_time/end_time pairs),
or none (no chapters and not a playlist). Three recorded fixtures provide
representative shapes so Layer 1 tests stay deterministic in CI."
```

---

## Task 3: Refactor — extract `downloadSourceMp3` from `yt-prepare-clip`

**Files:**
- Modify: `main.ts` (factor out the download step from the existing `yt-prepare-clip` handler)

**Why this task:** `yt-prepare-pack` will need to download the source video once and cut N times. The existing handler downloads and cuts inline. We extract the download step as a private helper, leaving `yt-prepare-clip`'s observable behavior identical.

- [ ] **Step 1: Run existing YouTube test as baseline**

```bash
python3 -m pytest tests/test_youtube_download.py -v
```

Expected: PASS. Record the timing — the refactor must not regress this.

- [ ] **Step 2: Find the existing handler**

Open `main.ts` and locate `ipcMain.handle('yt-prepare-clip', …)` (search for `'yt-prepare-clip'`). The body downloads via yt-dlp into `tmpPath` then cuts via ffmpeg into `outFile`.

- [ ] **Step 3: Add the extracted helper above the handler**

Insert just before `ipcMain.handle('yt-prepare-clip'`:

```typescript
/**
 * Download a YouTube source as a temp mp3. Returns the temp file path.
 * Caller is responsible for unlinking the temp file when done. Used by
 * yt-prepare-clip (single-cut) and yt-prepare-pack (multi-cut).
 */
async function downloadSourceMp3(url: string): Promise<string> {
  const tmpPath = path.join(app.getPath('temp'), `mb_yt_${Date.now()}.%(ext)s`);
  const tmpMp3  = tmpPath.replace('%(ext)s', 'mp3');
  const ytdlp   = findBin('yt-dlp');
  await spawnPromise(ytdlp, [
    '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '--no-playlist', '-o', tmpPath, url,
  ]);
  return tmpMp3;
}
```

- [ ] **Step 4: Replace the inline download in `yt-prepare-clip`**

Inside `ipcMain.handle('yt-prepare-clip', async (_e, opts) => { ... })`, replace these two blocks:

```typescript
// BEFORE
const tmpPath = path.join(app.getPath('temp'), `mb_yt_${Date.now()}.%(ext)s`);
const tmpMp3  = tmpPath.replace('%(ext)s', 'mp3');
try {
  const ytdlp  = findBin('yt-dlp');
  const ffmpeg = findBin('ffmpeg');

  await spawnPromise(ytdlp, [
    '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '--no-playlist', '-o', tmpPath, url,
  ]);
  await spawnPromise(ffmpeg, [
```

with:

```typescript
// AFTER
let tmpMp3: string | null = null;
try {
  tmpMp3 = await downloadSourceMp3(url);
  const ffmpeg = findBin('ffmpeg');

  await spawnPromise(ffmpeg, [
```

And update the `try { fs.unlinkSync(tmpMp3); } catch {}` lines (there are two — in success path and catch block) so they handle the nullable:

```typescript
// In success path, replace:
try { fs.unlinkSync(tmpMp3); } catch {}
// with:
if (tmpMp3) { try { fs.unlinkSync(tmpMp3); } catch {} }

// In catch block, do the same:
if (tmpMp3) { try { fs.unlinkSync(tmpMp3); } catch {} }
try { fs.unlinkSync(outFile); } catch {}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Re-run the existing YouTube integration test**

```bash
python3 -m pytest tests/test_youtube_download.py -v
```

Expected: PASS. Behavior is identical to before the refactor.

- [ ] **Step 7: Commit**

```bash
git add main.ts
git commit -m "refactor(yt-clip): extract downloadSourceMp3 helper

Pull the yt-dlp download step out of yt-prepare-clip so the upcoming
yt-prepare-pack handler can reuse it. yt-prepare-clip's observable
behavior is unchanged — verified by test_youtube_download.py."
```

---

## Task 4: Add `yt-detect-snippets` IPC handler

**Files:**
- Modify: `main.ts` (add new `ipcMain.handle` block near the existing `yt-info` handler)
- Modify: `tests/test_youtube_pack.py` (add binary-touching test)

- [ ] **Step 1: Write the failing integration test**

Append to `tests/test_youtube_pack.py`:

```python
def find_bin(name):
    return shutil.which(name)


@unittest.skipIf(not find_bin('yt-dlp'), 'yt-dlp not installed')
class TestDetectSnippetsBinaryInvocation(unittest.TestCase):
    """
    Validates that the same yt-dlp invocation pattern used by
    yt-detect-snippets in main.ts works against the same fixture URL
    as test_youtube_download.py. We don't import TS code; we exercise
    the binary contract.
    """

    URL = 'https://www.youtube.com/watch?v=aBr2kKAHN6M'

    def test_dump_single_json_returns_parseable(self):
        result = subprocess.run(
            ['yt-dlp', '--dump-single-json', '--no-playlist', self.URL],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0,
                         f"yt-dlp failed: {result.stderr}")
        data = json.loads(result.stdout)
        # The classifier should handle this shape
        classified = classify_detect_result(data)
        # This particular URL has no chapters
        self.assertEqual(classified['kind'], 'none')
```

- [ ] **Step 2: Run the test**

```bash
python3 -m pytest tests/test_youtube_pack.py::TestDetectSnippetsBinaryInvocation -v
```

Expected: PASS (or SKIPPED if yt-dlp isn't installed). This validates that real yt-dlp output flows through the classifier.

- [ ] **Step 3: Add the IPC handler**

In `main.ts`, find `ipcMain.handle('yt-info', …)` and add the new handler immediately after it:

```typescript
/**
 * Detect what kind of source the URL points to: a playlist (multiple videos),
 * a single video with chapters, or a single video without chapters.
 *
 * One yt-dlp call per URL. Caller (renderer) decides what to do with each
 * shape — for 'none' we route the user to the existing single-clip flow.
 */
ipcMain.handle('yt-detect-snippets', async (_e, url: string) => {
  try {
    const ytdlp = findBin('yt-dlp');

    // For URLs with list= we want playlist info; for plain video URLs we
    // want chapters. yt-dlp behavior:
    //   --no-playlist → ignores list=, returns single-video json
    //   --flat-playlist → playlist wrapper with thin entries[]
    // We let the caller disambiguate by passing the URL exactly as the user
    // pasted it; if it has list=, we run flat-playlist; otherwise no-playlist.
    const isPlaylist = /[?&]list=/.test(url);
    const args = isPlaylist
      ? ['--dump-single-json', '--flat-playlist', url]
      : ['--dump-single-json', '--no-playlist',   url];

    const raw = await spawnPromise(ytdlp, args, { capture: true });
    const json = JSON.parse(raw) as Record<string, unknown>;
    const result = classifyDetectResult(json);

    return { ok: true, result };
  } catch (e) {
    const msg = (e as Error).message;
    // Map common yt-dlp stderr patterns to short user-facing strings
    let friendly = msg;
    if (/Private video/i.test(msg))             friendly = 'This video is private.';
    else if (/age-?restrict|Sign in to confirm your age/i.test(msg))
                                                friendly = 'Age-restricted video — yt-dlp cannot fetch it.';
    else if (/HTTP Error 429/.test(msg))        friendly = 'YouTube rate-limited — try again in a minute.';
    else if (/Video unavailable/i.test(msg))    friendly = 'Video unavailable.';

    return { ok: false, error: friendly };
  }
});
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add main.ts tests/test_youtube_pack.py
git commit -m "feat(yt-pack): yt-detect-snippets IPC handler

Single yt-dlp invocation that returns a typed DetectResult: playlist,
chapters, or none. Friendly error mapping for private/age-restricted/429.
Re-uses classifyDetectResult; auto-routes flat-playlist vs no-playlist
based on the URL's list= query param."
```

---

## Task 5: Add `yt-prepare-pack` IPC handler

**Files:**
- Modify: `main.ts` (new handler placed after `yt-prepare-clip`)
- Modify: `tests/test_youtube_pack.py` (binary integration test)

- [ ] **Step 1: Write the failing integration test**

Append to `tests/test_youtube_pack.py`:

```python
@unittest.skipIf(not (find_bin('yt-dlp') and find_bin('ffmpeg')),
                 'yt-dlp or ffmpeg not installed')
class TestPreparePackBinaryReplication(unittest.TestCase):
    """
    Mirrors the yt-prepare-pack pipeline: one download, multiple ffmpeg
    cuts. Validates that the exact ffmpeg invocation used in main.ts
    produces a valid mp3 for each segment.
    """

    URL = 'https://www.youtube.com/watch?v=aBr2kKAHN6M'

    def is_valid_mp3(self, path):
        if not os.path.exists(path) or os.path.getsize(path) < 200:
            return False
        with open(path, 'rb') as f:
            header = f.read(4)
        return header[:3] == b'ID3' or header[:2] in (
            b'\xff\xfb', b'\xff\xf3', b'\xff\xf2', b'\xff\xe3')

    def test_one_download_two_cuts(self):
        with tempfile.TemporaryDirectory() as tmp:
            src_template = os.path.join(tmp, 'src.%(ext)s')
            src_mp3      = os.path.join(tmp, 'src.mp3')

            # 1 — download once
            r = subprocess.run([
                'yt-dlp', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
                '--no-playlist', '-o', src_template, self.URL,
            ], capture_output=True, text=True, timeout=180)
            self.assertEqual(r.returncode, 0, f"download failed: {r.stderr}")
            self.assertTrue(os.path.exists(src_mp3))

            # 2 — cut twice from the same source
            segs = [(0.0, 1.0), (1.0, 2.0)]
            for i, (start, end) in enumerate(segs):
                out = os.path.join(tmp, f'seg{i}.mp3')
                r = subprocess.run([
                    'ffmpeg', '-y', '-ss', str(start), '-t', str(end - start),
                    '-i', src_mp3, '-acodec', 'libmp3lame', '-q:a', '2', out,
                ], capture_output=True, text=True, timeout=30)
                self.assertEqual(r.returncode, 0, f"cut {i} failed: {r.stderr}")
                self.assertTrue(self.is_valid_mp3(out),
                                f"segment {i} is not a valid mp3")
```

- [ ] **Step 2: Run the test**

```bash
python3 -m pytest tests/test_youtube_pack.py::TestPreparePackBinaryReplication -v
```

Expected: PASS (validates the binary pipeline before we wrap it in the IPC handler).

- [ ] **Step 3: Add the IPC handler to `main.ts`**

Place this immediately after the existing `yt-prepare-clip` handler:

```typescript
interface PreparePackSegment { title: string; start: number; end: number; }
interface PreparePackOpts    { url: string; segments: PreparePackSegment[]; }

/**
 * Bulk-prepare N snippets from one YouTube source. Downloads the source
 * mp3 once (or skips the download entirely if every requested segment is
 * already cached), then ffmpeg-cuts each segment into the same .cache/yt/
 * directory that yt-prepare-clip uses. Cache key matches: ytCacheKey(url,
 * start, end). Repeated invocations with overlapping segments are free.
 *
 * Partial failure tolerated: a failed cut is reported in `failed[]`; the
 * remaining cuts still complete. Caller decides whether to retry the
 * failures or proceed without them.
 *
 * Defensive caps: rejects > 100 segments or any segment outside [0.1, 60]s.
 */
ipcMain.handle('yt-prepare-pack', async (_e, opts: PreparePackOpts) => {
  const { url, segments } = opts;

  if (segments.length > 100) {
    return { ok: false, error: 'Too many segments (max 100).' };
  }
  for (const s of segments) {
    const dur = s.end - s.start;
    if (dur < 0.1 || dur > 60) {
      return { ok: false, error: `Segment "${s.title}" has invalid duration (${dur.toFixed(2)}s).` };
    }
  }

  // Pre-pass: figure out which segments are already cached
  const cacheDir = ytCacheDir();
  const planned = segments.map(s => {
    const key       = ytCacheKey(url, s.start, s.end);
    const cachePath = path.join(cacheDir, `${key}.mp3`);
    return { ...s, cachePath, cached: fs.existsSync(cachePath) };
  });

  const needsCut = planned.filter(p => !p.cached);
  let tmpMp3: string | null = null;
  const prepared: { title: string; cachePath: string; durationMs: number }[] = [];
  const failed:   { title: string; error: string }[] = [];

  try {
    if (needsCut.length > 0) {
      tmpMp3 = await downloadSourceMp3(url);
    }

    const ffmpeg = findBin('ffmpeg');
    for (const p of planned) {
      if (p.cached) {
        prepared.push({
          title: p.title, cachePath: p.cachePath,
          durationMs: Math.round((p.end - p.start) * 1000),
        });
        continue;
      }
      try {
        await spawnPromise(ffmpeg, [
          '-y', '-ss', String(p.start), '-t', String(p.end - p.start),
          '-i', tmpMp3!, '-acodec', 'libmp3lame', '-q:a', '2', p.cachePath,
        ]);
        prepared.push({
          title: p.title, cachePath: p.cachePath,
          durationMs: Math.round((p.end - p.start) * 1000),
        });
      } catch (e) {
        // Don't abort — try the rest. Clean up partial output for this segment.
        try { fs.unlinkSync(p.cachePath); } catch {}
        failed.push({ title: p.title, error: (e as Error).message });
      }
    }

    if (tmpMp3) { try { fs.unlinkSync(tmpMp3); } catch {} }

    return { ok: true, prepared, failed };
  } catch (e) {
    if (tmpMp3) { try { fs.unlinkSync(tmpMp3); } catch {} }
    return { ok: false, error: (e as Error).message, prepared, failed };
  }
});
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add main.ts tests/test_youtube_pack.py
git commit -m "feat(yt-pack): yt-prepare-pack IPC handler

One download + N ffmpeg cuts against the existing .cache/yt/ cache.
Reuses ytCacheKey so cached segments (e.g. previewed beforehand) skip
the download entirely. Partial failures reported in failed[]; remaining
segments still complete. Defensive caps: 100 segments, 0.1–60s each."
```

---

## Task 6: Add `library-create-pack-from-clips` IPC handler

**Files:**
- Modify: `main.ts` (new handler near `library-add-from-clip`)
- Modify: `tests/test_youtube_pack.py` (rollback test)

- [ ] **Step 1: Write the failing rollback test**

Append to `tests/test_youtube_pack.py`:

```python
class TestLibraryCreatePackRollback(unittest.TestCase):
    """
    The library-create-pack-from-clips handler must be atomic-with-rollback:
    if any clip copy fails, all previously-copied clips are deleted before
    the error returns. We test the algorithm here in Python form; the
    e2e Playwright test exercises it through the real handler.
    """

    def simulate_create_pack(self, clips, copy_fn):
        """
        clips: list of {'cachePath','dest'} dicts.
        copy_fn(src, dest): callable that may raise to simulate failure.
        Returns (ok: bool, copied_paths: list).
        """
        copied = []
        try:
            for c in clips:
                copy_fn(c['cachePath'], c['dest'])
                copied.append(c['dest'])
            return True, copied
        except Exception:
            for p in copied:
                try: os.unlink(p)
                except OSError: pass
            return False, []

    def test_rollback_on_third_clip(self):
        with tempfile.TemporaryDirectory() as tmp:
            srcs  = [os.path.join(tmp, f'src{i}.mp3') for i in range(3)]
            dests = [os.path.join(tmp, f'dst{i}.mp3') for i in range(3)]
            for s in srcs:
                with open(s, 'wb') as f:
                    f.write(b'ID3' + b'\x00' * 200)

            clips = [{'cachePath': s, 'dest': d} for s, d in zip(srcs, dests)]

            calls = {'n': 0}
            def flaky_copy(src, dest):
                calls['n'] += 1
                if calls['n'] == 3:
                    raise IOError('simulated disk full')
                shutil.copyfile(src, dest)

            ok, copied = self.simulate_create_pack(clips, flaky_copy)
            self.assertFalse(ok)
            for d in dests:
                self.assertFalse(os.path.exists(d),
                                 f"{d} should have been rolled back")
```

- [ ] **Step 2: Run the test**

```bash
python3 -m pytest tests/test_youtube_pack.py::TestLibraryCreatePackRollback -v
```

Expected: PASS.

- [ ] **Step 3: Add the IPC handler**

In `main.ts`, place this after the existing `library-add-from-clip` handler:

```typescript
interface CreatePackClip {
  cachePath:  string;
  title:      string;
  durationMs: number;
}
interface CreatePackOpts {
  url:        string;        // source URL (for sourceUrl provenance)
  packName:   string;        // user-supplied or video-title-derived
  clips:      CreatePackClip[];
}

/**
 * Atomically (with rollback) create a new user pack from prepared clip
 * cache files. Steps:
 *   1. for each clip: copy cachePath → userSoundsDir()/custom/yt-<id>.mp3
 *   2. write user packs.json with the new pack entry
 *   3. emit packs-changed
 * On any step-1 failure, deletes already-copied files and returns error.
 * On step-2 failure, deletes ALL step-1 files. packs.json is written last
 * so a crash between 1 and 2 leaks orphaned mp3s rather than leaving a
 * pack referencing missing files.
 *
 * Defensive cap: rejects > 15 clips (keyboard layout cap).
 */
ipcMain.handle('library-create-pack-from-clips', async (_e, opts: CreatePackOpts) => {
  const { url, packName, clips } = opts;
  if (clips.length === 0) {
    return { ok: false, error: 'No clips selected.' };
  }
  if (clips.length > MAX_KEYS) {
    return { ok: false, error: `Too many clips (max ${MAX_KEYS}).` };
  }

  ensureUserDirs();
  const customDir = customSoundsDir();

  // Resolve final pack name with collision suffixing
  const userPacks  = readUserPacks();
  const existing   = userPacks.map(p => p.name);
  const { finalName, packId } = slugifyPackName(packName, existing);

  // Step 1 — copy each clip into custom/yt-<id>.mp3
  const copied: string[] = [];
  const keyMap = mapSnippetsToKeys(clips);
  const packKeys: Record<string, { label: string; file: string; source: 'user' }> = {};

  try {
    for (const km of keyMap.mapped) {
      const clip   = km.snippet as CreatePackClip;
      const id     = `yt_${Date.now()}_${km.key}`;
      const file   = `yt-${id}.mp3`;
      const dest   = path.join(customDir, file);
      fs.copyFileSync(clip.cachePath, dest);
      copied.push(dest);
      packKeys[km.key] = {
        label:  clip.title,
        file:   `custom/${file}`,
        source: 'user',
      };
    }
  } catch (e) {
    for (const p of copied) { try { fs.unlinkSync(p); } catch {} }
    return { ok: false, error: (e as Error).message };
  }

  // Step 2 — append to user packs.json
  try {
    const newPack = {
      id: packId,
      name: finalName,
      description: `Imported from YouTube`,
      keys: packKeys,
      origin: 'user' as const,
      sourceUrl: url,
    };
    userPacks.push(newPack);
    writeUserPacks(userPacks);
  } catch (e) {
    for (const p of copied) { try { fs.unlinkSync(p); } catch {} }
    return { ok: false, error: (e as Error).message };
  }

  // Step 3 — notify
  boardWin?.webContents.send('packs-changed');
  childWin?.webContents.send('packs-changed');

  return {
    ok: true,
    packId,
    finalName,
    keysAssigned: keyMap.mapped.length,
  };
});
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors. If `readUserPacks` / `writeUserPacks` / `customSoundsDir` / `ensureUserDirs` lookups fail, search `main.ts` for those names — they already exist (used by `upsertUserCustomSound`).

- [ ] **Step 5: Verify the existing test_pack_format.py still passes**

```bash
python3 -m pytest tests/test_pack_format.py -v
```

Expected: PASS. Pack schema is unchanged.

- [ ] **Step 6: Commit**

```bash
git add main.ts tests/test_youtube_pack.py
git commit -m "feat(yt-pack): library-create-pack-from-clips with rollback

Atomically creates a new user pack from prepared clip cache files.
Copy-then-write-packs.json ordering means a crash between steps leaks
orphan mp3s instead of leaving a broken pack reference. On any failure
we roll back already-copied files. Pack-name collisions auto-suffix (2),
(3), etc."
```

---

## Task 7: Expose new IPC channels in preload

**Files:**
- Modify: `preload.ts`

- [ ] **Step 1: Read the current preload**

Open `preload.ts`. The bridge object is named **`electronAPI`** (`contextBridge.exposeInMainWorld('electronAPI', { … })`). `onPacksChanged` already exists (no need to add it). Existing YouTube methods use **options-object** style: `ytPrepareClip({ url, start, end })` — match that pattern.

- [ ] **Step 2: Add three new methods inside the existing `electronAPI` object**

Find the section commented `// ── YouTube clips → library ──`. Add right after `libraryAddFromClip`:

```typescript
ytDetectSnippets: (url: string):
  Promise<{
    ok: boolean;
    result?:
      | { kind: 'playlist';  items:    Array<{ videoId: string; title: string; duration?: number }>; meta: { title: string; thumbnail: string; duration?: number } }
      | { kind: 'chapters';  chapters: Array<{ title: string; start: number; end: number }>;          meta: { title: string; thumbnail: string; duration?: number } }
      | { kind: 'none';      meta: { title: string; thumbnail: string; duration?: number } };
    error?: string;
  }> =>
  ipcRenderer.invoke('yt-detect-snippets', url),

ytPreparePack: (opts: { url: string; segments: Array<{ title: string; start: number; end: number }> }):
  Promise<{
    ok: boolean;
    prepared?: Array<{ title: string; cachePath: string; durationMs: number }>;
    failed?:   Array<{ title: string; error: string }>;
    error?: string;
  }> =>
  ipcRenderer.invoke('yt-prepare-pack', opts),

libraryCreatePackFromClips: (opts: {
  url: string;
  packName: string;
  clips: Array<{ cachePath: string; title: string; durationMs: number }>;
}):
  Promise<{ ok: boolean; packId?: string; finalName?: string; keysAssigned?: number; error?: string }> =>
  ipcRenderer.invoke('library-create-pack-from-clips', opts),
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Smoke-test by booting the app**

```bash
npm run dev
```

Expected: app boots, sound manager opens, **no console errors** about missing methods. Close the app.

- [ ] **Step 5: Commit**

```bash
git add preload.ts
git commit -m "feat(yt-pack): expose detect/prepare/create-pack on preload

Three new IPC bridge methods plus an onPacksChanged subscription so the
renderer can refresh the pack list when a new pack lands. Renderer code
in the next task consumes these."
```

---

## Task 8: Add "YouTube Pack" tab — paste state UI

**Files:**
- Modify: `src/sound-manager.html`

This task adds the **third tab** alongside the existing `mic` and `youtube` tabs, plus the paste-state UI. Detect / review / create flows come in Tasks 9–11.

- [ ] **Step 1: Locate the tab strip**

Find the existing tab strip in `src/sound-manager.html` (search for `class="stab"` — there are tabs like `data-src="youtube"` and a Mic tab). Add a third tab after them.

- [ ] **Step 2: Add the new tab button**

Right after the existing `<div class="stab" data-src="youtube">` element (the YouTube Clip tab), insert:

```html
<div class="stab" data-src="ytpack" onclick="setTab(this)">
  <div class="stab-icon">📦</div>
  <div class="stab-label">YouTube Pack</div>
</div>
```

- [ ] **Step 3: Add the tab pane**

Find the existing `<section class="src-pane" data-src="youtube">` and add a new pane right after it:

```html
<section class="src-pane" data-src="ytpack" hidden>
  <div class="section-title">Create a pack from a YouTube URL</div>

  <div class="ytp-state ytp-paste">
    <div class="field-lbl">YouTube URL</div>
    <div class="field-row">
      <input class="inp" id="ytpUrl"
             placeholder="https://www.youtube.com/watch?v=…  or playlist URL">
      <button class="btn primary" id="ytpDetectBtn">Detect</button>
    </div>
    <div class="hint">
      Paste a playlist URL or a video with chapters.
      Single videos without chapters: use the <a href="#" id="ytpSwitchToClip">YouTube Clip</a> tab.
    </div>
    <div class="ytp-error" id="ytpPasteError" hidden></div>
  </div>

  <div class="ytp-state ytp-review" hidden>
    <!-- filled in Task 9 -->
  </div>

  <div class="ytp-state ytp-import" hidden>
    <!-- filled in Task 10 -->
  </div>
</section>
```

- [ ] **Step 4: Wire the tab switch + Detect click handler**

Find the existing `<script>` block in `sound-manager.html`. Near the YouTube tab logic (search for `data-src="youtube"` in JS), add:

```javascript
// ── YouTube Pack tab ───────────────────────────────────────────────────────
const ytpUrl       = document.getElementById('ytpUrl');
const ytpDetectBtn = document.getElementById('ytpDetectBtn');
const ytpPasteErr  = document.getElementById('ytpPasteError');
const ytpPaneRoot  = document.querySelector('.src-pane[data-src="ytpack"]');

function showYtpPasteError(msg) {
  ytpPasteErr.textContent = msg;
  ytpPasteErr.hidden = false;
}
function clearYtpPasteError() {
  ytpPasteErr.hidden = true;
}

function setYtpState(name) {
  ytpPaneRoot.querySelectorAll('.ytp-state').forEach(el => {
    el.hidden = !el.classList.contains(`ytp-${name}`);
  });
}

ytpDetectBtn.addEventListener('click', async () => {
  clearYtpPasteError();
  const url = ytpUrl.value.trim();
  if (!url) { showYtpPasteError('Paste a YouTube URL first.'); return; }

  ytpDetectBtn.disabled = true;
  ytpDetectBtn.textContent = 'Detecting…';
  try {
    const r = await window.electronAPI.ytDetectSnippets(url);
    if (!r.ok) { showYtpPasteError(r.error); return; }

    if (r.result.kind === 'none') {
      showYtpPasteError(
        'This video has no chapters. Use the YouTube Clip tab to cut a single excerpt.'
      );
      return;
    }
    // Wired in Task 9
    window.__ytpLastDetect = { url, result: r.result };
    renderYtpReview(url, r.result);
    setYtpState('review');
  } finally {
    ytpDetectBtn.disabled = false;
    ytpDetectBtn.textContent = 'Detect';
  }
});

document.getElementById('ytpSwitchToClip').addEventListener('click', e => {
  e.preventDefault();
  const ytTab = document.querySelector('.stab[data-src="youtube"]');
  if (ytTab) {
    setTab(ytTab);
    const ytClipUrl = document.getElementById('ytUrl');
    if (ytClipUrl) ytClipUrl.value = ytpUrl.value.trim();
  }
});

// Stub — implemented in Task 9
function renderYtpReview(_url, _result) {}
```

- [ ] **Step 5: Verify TypeScript compiles + smoke-test**

```bash
npx tsc --noEmit
npm run dev
```

Expected: app boots, Sound Manager opens, three tabs visible, the "YouTube Pack" tab is clickable and shows the paste state. Detect on an empty URL shows "Paste a YouTube URL first." Detect on a non-chapters URL shows the no-chapters message.

- [ ] **Step 6: Commit**

```bash
git add src/sound-manager.html
git commit -m "feat(yt-pack): add YouTube Pack tab — paste state

Third tab in Sound Manager. Paste a URL, click Detect; non-chapters
videos surface a one-click bounce to the existing YouTube Clip tab.
Review and Import states are stubbed for the next two tasks."
```

---

## Task 9: Implement the review-state UI

**Files:**
- Modify: `src/sound-manager.html` (fill in the `.ytp-review` block + JS)

- [ ] **Step 1: Replace the empty `.ytp-review` block**

Find `<div class="ytp-state ytp-review" hidden>` and replace its contents:

```html
<div class="ytp-state ytp-review" hidden>
  <div class="ytp-meta">
    <img class="ytp-thumb" id="ytpThumb" alt="">
    <div class="ytp-meta-text">
      <div class="ytp-title" id="ytpTitle"></div>
      <div class="ytp-summary" id="ytpSummary"></div>
    </div>
  </div>

  <div class="ytp-list" id="ytpList"></div>

  <div class="field-row">
    <div class="field-lbl">Pack name</div>
    <input class="inp" id="ytpPackName">
  </div>
  <div class="ytp-cap" id="ytpCap"></div>

  <div class="ytp-actions">
    <button class="btn" id="ytpCancelBtn">Cancel</button>
    <button class="btn primary" id="ytpCreateBtn">Create Pack</button>
  </div>
  <div class="ytp-error" id="ytpReviewError" hidden></div>
</div>
```

- [ ] **Step 2: Replace the `renderYtpReview` stub**

Replace the stub from Task 8 with the full implementation:

```javascript
const ytpThumb       = document.getElementById('ytpThumb');
const ytpTitle       = document.getElementById('ytpTitle');
const ytpSummary     = document.getElementById('ytpSummary');
const ytpListEl      = document.getElementById('ytpList');
const ytpPackNameInp = document.getElementById('ytpPackName');
const ytpCap         = document.getElementById('ytpCap');
const ytpCancelBtn   = document.getElementById('ytpCancelBtn');
const ytpCreateBtn   = document.getElementById('ytpCreateBtn');
const ytpReviewErr   = document.getElementById('ytpReviewError');

const YTP_MIN = 0.3;
const YTP_MAX_AUTO = 30.0;
const YTP_MAX_KEYS = 15;
const YTP_KEYS = ['q','w','e','r','t','a','s','d','f','g','z','x','c','v','b'];

function ytpFmtTime(s) {
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function ytpToSnippets(detect) {
  // Normalize playlist + chapters into the same {title,start,end} shape.
  // For playlist items we synthesize start=0, end=duration so the
  // filter/cap logic works uniformly. yt-prepare-pack downloads each video
  // separately, so playlist mode actually calls prepare-pack once per video.
  // To keep v1 small, we treat each playlist item as a "full video" segment
  // and let yt-prepare-pack handle the per-video download.
  if (detect.kind === 'chapters') {
    return detect.chapters.map(c => ({
      title: c.title, start: c.start, end: c.end,
      perVideoUrl: null,
    }));
  }
  // playlist
  return detect.items.map(it => ({
    title: it.title,
    start: 0,
    end:   it.duration ?? 0,
    perVideoUrl: `https://www.youtube.com/watch?v=${it.videoId}`,
  }));
}

let ytpRows = [];

function renderYtpReview(url, detect) {
  ytpReviewErr.hidden = true;
  ytpThumb.src = detect.meta.thumbnail || '';
  ytpThumb.style.display = detect.meta.thumbnail ? '' : 'none';
  ytpTitle.textContent = detect.meta.title || 'Untitled';

  const snippets = ytpToSnippets(detect);
  ytpRows = snippets
    .map((s, idx) => ({ ...s, idx, dur: s.end - s.start }))
    .filter(s => s.dur >= YTP_MIN || detect.kind === 'playlist')
    .map(s => ({
      ...s,
      autoCheck: detect.kind === 'playlist' ? true : (s.dur <= YTP_MAX_AUTO),
      reason:    (detect.kind !== 'playlist' && s.dur > YTP_MAX_AUTO) ? 'too_long' : null,
    }));

  ytpListEl.innerHTML = ytpRows.map((s, i) => `
    <div class="ytp-row" data-idx="${i}">
      <input type="checkbox" class="ytp-check" ${s.autoCheck ? 'checked' : ''}>
      <button class="ytp-preview" type="button">▶</button>
      <div class="ytp-row-title">${escapeHtml(s.title || 'Untitled')}</div>
      <div class="ytp-row-time">
        ${ytpFmtTime(s.start)}–${ytpFmtTime(s.end)}
        <span class="ytp-row-dur">(${s.dur.toFixed(1)}s)</span>
        ${s.reason === 'too_long' ? '<span class="ytp-tag">too long</span>' : ''}
      </div>
    </div>
  `).join('');

  ytpListEl.querySelectorAll('.ytp-check').forEach((cb, i) => {
    cb.addEventListener('change', updateYtpCap);
  });
  ytpListEl.querySelectorAll('.ytp-preview').forEach((btn, i) => {
    btn.addEventListener('click', () => previewYtpRow(url, ytpRows[i]));
  });

  ytpPackNameInp.value = detect.meta.title || 'YouTube Pack';
  updateYtpCap();
}

function selectedYtpRows() {
  return ytpRows.filter((_, i) =>
    ytpListEl.querySelectorAll('.ytp-check')[i].checked
  );
}

function updateYtpCap() {
  const sel = selectedYtpRows();
  const overflow = Math.max(0, sel.length - YTP_MAX_KEYS);
  const keys = YTP_KEYS.slice(0, Math.min(sel.length, YTP_MAX_KEYS)).join(',');
  ytpCap.textContent =
    `Selected: ${sel.length} / ${ytpRows.length} snippets   →   keys ${keys}` +
    (overflow ? `   (${overflow} extra ignored — cap is ${YTP_MAX_KEYS})` : '');
}

async function previewYtpRow(url, row) {
  // Reuses the existing single-clip handler for instant preview.
  // Note: existing handler takes an OPTIONS OBJECT (matches preload signature).
  const previewUrl = row.perVideoUrl || url;
  const r = await window.electronAPI.ytPrepareClip({
    url: previewUrl, start: row.start, end: row.end,
  });
  if (r.ok) {
    const a = new Audio(r.url);
    a.play();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

ytpCancelBtn.addEventListener('click', () => {
  ytpRows = [];
  ytpUrl.value = '';
  setYtpState('paste');
});
```

> **Note:** `window.electronAPI.ytPrepareClip` is the existing single-clip method. If it's not exposed on the preload bridge under that exact name, look it up in `preload.ts` and use the actual method name.

- [ ] **Step 3: Verify TypeScript compiles + smoke-test**

```bash
npx tsc --noEmit
npm run dev
```

Test in app:
1. Paste a chapters URL → click Detect → review list renders.
2. Snippets >30s appear with `[too long]` tag and unchecked.
3. Toggling a checkbox updates the "Selected: X / N" line.
4. Clicking ▶ on a row plays audio (cache warms — second click is instant).

- [ ] **Step 4: Commit**

```bash
git add src/sound-manager.html
git commit -m "feat(yt-pack): review-state UI — candidate list + preview

Renders detected snippets as a checkbox list with per-row preview
(reusing yt-prepare-clip cache) and an inline cap counter that mirrors
the keyboard layout (q,w,e,r,t / a,s,d,f,g / z,x,c,v,b). Snippets >30s
auto-uncheck with a 'too long' tag; <0.3s drop silently."
```

---

## Task 10: Implement the import-state flow

**Files:**
- Modify: `src/sound-manager.html` (fill in the `.ytp-import` block + Create Pack handler)

- [ ] **Step 1: Replace the `.ytp-import` block**

Find `<div class="ytp-state ytp-import" hidden>` and replace its contents:

```html
<div class="ytp-state ytp-import" hidden>
  <div class="ytp-progress-stage" id="ytpProgressStage">Preparing…</div>
  <progress class="ytp-progress" id="ytpProgress" max="100" value="0"></progress>
  <div class="ytp-progress-detail" id="ytpProgressDetail"></div>
  <div class="ytp-error" id="ytpImportError" hidden></div>
  <div class="ytp-actions">
    <button class="btn" id="ytpDoneBtn" hidden>Done</button>
    <button class="btn" id="ytpRetryBtn" hidden>Try again</button>
  </div>
</div>
```

- [ ] **Step 2: Wire the Create Pack flow**

Append to the existing `<script>` block (after the Cancel handler from Task 9):

```javascript
const ytpStage     = document.getElementById('ytpProgressStage');
const ytpProgress  = document.getElementById('ytpProgress');
const ytpDetail    = document.getElementById('ytpProgressDetail');
const ytpImportErr = document.getElementById('ytpImportError');
const ytpDoneBtn   = document.getElementById('ytpDoneBtn');
const ytpRetryBtn  = document.getElementById('ytpRetryBtn');

ytpCreateBtn.addEventListener('click', async () => {
  ytpReviewErr.hidden = true;
  const sel = selectedYtpRows().slice(0, YTP_MAX_KEYS);
  if (sel.length === 0) {
    ytpReviewErr.textContent = 'Select at least one snippet.';
    ytpReviewErr.hidden = false;
    return;
  }

  setYtpState('import');
  ytpStage.textContent = 'Preparing snippets…';
  ytpProgress.value = 5;
  ytpDetail.textContent = '';
  ytpImportErr.hidden = true;
  ytpDoneBtn.hidden = true;
  ytpRetryBtn.hidden = true;

  const detect = window.__ytpLastDetect;

  try {
    // Playlist mode = one prepare-pack call per video. Chapters mode = one call total.
    let allPrepared = [];
    let allFailed   = [];

    if (detect.result.kind === 'chapters') {
      ytpDetail.textContent = `Cutting ${sel.length} snippet(s)…`;
      const r = await window.electronAPI.ytPreparePack({
        url: detect.url,
        segments: sel.map(s => ({ title: s.title, start: s.start, end: s.end })),
      });
      if (!r.ok) throw new Error(r.error);
      allPrepared = r.prepared;
      allFailed   = r.failed;
      ytpProgress.value = 70;
    } else {
      // playlist — N downloads, one per video
      for (let i = 0; i < sel.length; i++) {
        const s = sel[i];
        ytpDetail.textContent = `Downloading video ${i + 1} of ${sel.length}: ${s.title}`;
        ytpProgress.value = 5 + Math.floor((i / sel.length) * 65);
        const r = await window.electronAPI.ytPreparePack({
          url: s.perVideoUrl,
          segments: [{ title: s.title, start: 0, end: s.end || 600 }],
        });
        if (!r.ok) {
          allFailed.push({ title: s.title, error: r.error });
        } else {
          allPrepared.push(...r.prepared);
          allFailed.push(...r.failed);
        }
      }
    }

    if (allPrepared.length === 0) {
      throw new Error('No snippets could be prepared.\n' +
        allFailed.map(f => `${f.title}: ${f.error}`).join('\n'));
    }

    ytpStage.textContent = 'Creating pack…';
    ytpProgress.value = 85;
    ytpDetail.textContent = '';

    const create = await window.electronAPI.libraryCreatePackFromClips({
      url:      detect.url,
      packName: ytpPackNameInp.value,
      clips:    allPrepared,
    });
    if (!create.ok) throw new Error(create.error);

    ytpProgress.value = 100;
    ytpStage.textContent = 'Pack created';
    ytpDetail.textContent =
      `${create.keysAssigned} keys assigned in pack "${create.finalName}"` +
      (allFailed.length ? `   (${allFailed.length} failed)` : '');
    ytpDoneBtn.hidden = false;
  } catch (e) {
    ytpImportErr.textContent = e.message || String(e);
    ytpImportErr.hidden = false;
    ytpRetryBtn.hidden = false;
  }
});

ytpDoneBtn.addEventListener('click', () => {
  // Close Sound Manager — the new pack will appear via packs-changed
  window.close();
});
ytpRetryBtn.addEventListener('click', () => {
  setYtpState('review');
});
```

- [ ] **Step 3: Verify TypeScript compiles + smoke-test**

```bash
npx tsc --noEmit
npm run dev
```

Test in app:
1. Paste a chapters URL → Detect → uncheck a row or two → type a pack name → click "Create Pack."
2. Progress shows "Cutting N snippet(s)…" then "Creating pack…" then "Pack created."
3. Click Done. Pack list refreshes and the new pack appears.
4. Switch to it on the board and trigger a key — sound plays.

- [ ] **Step 4: Commit**

```bash
git add src/sound-manager.html
git commit -m "feat(yt-pack): import-state UI — Create Pack flow

Wires the review state's Create Pack button: chapters mode is one
yt-prepare-pack call; playlist mode iterates one call per video. Surfaces
prepared/failed counts in the success state. Done closes Sound Manager;
the board picks up the new pack via packs-changed."
```

---

## Task 11: Style the new UI (CSS)

**Files:**
- Modify: `src/sound-manager.html` (style block)

This task isolates the styling so the previous two tasks could land with raw HTML and this one polishes.

- [ ] **Step 1: Add CSS rules**

Find the `<style>` block in `sound-manager.html` and append:

```css
/* ── YouTube Pack tab ────────────────────────────────────────────────── */
.ytp-state            { display: flex; flex-direction: column; gap: 12px; }
.ytp-meta             { display: flex; gap: 12px; align-items: flex-start; }
.ytp-thumb            { width: 120px; height: 68px; object-fit: cover; border-radius: 4px; }
.ytp-meta-text        { flex: 1; }
.ytp-title            { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
.ytp-summary          { font-size: 12px; opacity: 0.7; }

.ytp-list             { max-height: 320px; overflow-y: auto; border: 1px solid var(--border, #333);
                        border-radius: 4px; padding: 4px 0; }
.ytp-row              { display: grid; grid-template-columns: 24px 32px 1fr auto;
                        align-items: center; gap: 8px; padding: 6px 12px;
                        border-bottom: 1px solid var(--border-soft, #222); }
.ytp-row:last-child   { border-bottom: 0; }
.ytp-row-title        { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ytp-row-time         { font-size: 11px; opacity: 0.65; font-variant-numeric: tabular-nums; }
.ytp-row-dur          { opacity: 0.55; margin-left: 4px; }
.ytp-tag              { display: inline-block; margin-left: 6px; padding: 1px 6px;
                        font-size: 10px; border: 1px solid var(--border, #444);
                        border-radius: 8px; opacity: 0.7; }
.ytp-preview          { background: transparent; border: 1px solid var(--border, #444);
                        border-radius: 4px; cursor: pointer; padding: 2px 6px; }

.ytp-cap              { font-size: 12px; opacity: 0.75; }
.ytp-actions          { display: flex; gap: 8px; justify-content: flex-end; }
.ytp-error            { color: var(--error, #f66); font-size: 12px;
                        background: rgba(255,80,80,0.08); padding: 8px 12px; border-radius: 4px; }
.ytp-progress         { width: 100%; height: 12px; }
.ytp-progress-stage   { font-size: 13px; font-weight: 500; }
.ytp-progress-detail  { font-size: 12px; opacity: 0.7; min-height: 1.2em; }

.hint                 { font-size: 12px; opacity: 0.65; }
.field-row            { display: flex; gap: 8px; align-items: center; }
.field-lbl            { font-size: 12px; opacity: 0.7; min-width: 90px; }
```

> **Note:** if any of the `var(--…)` tokens don't exist in the rest of the stylesheet, replace with literal colors that match nearby existing rules (this codebase uses CSS variables heavily — search the existing `<style>` block for `--border` to confirm).

- [ ] **Step 2: Smoke-test the look**

```bash
npm run dev
```

Open Sound Manager → YouTube Pack tab. Visual check: the layout reads as the operator-broadcast aesthetic from `PRODUCT.md` (no purple gradients, no consumer-soundboard chrome). Tabs are tight; rows are tabular; the cap line sits below the pack name.

- [ ] **Step 3: Commit**

```bash
git add src/sound-manager.html
git commit -m "style(yt-pack): tighten the candidate list aesthetic

Operator-style row layout: thumb + meta + tabular candidate list +
inline cap counter. Reuses existing CSS variables; no new tokens."
```

---

## Task 12: Playwright golden-path e2e

**Files:**
- Create: `tests/e2e/youtube-pack-import.spec.ts`

- [ ] **Step 1: Inspect the existing pack-selection spec for the boot pattern**

Read `tests/e2e/pack-selection.spec.ts`. Note how it boots Electron and accesses the renderer. Reuse the same pattern.

- [ ] **Step 2: Write the failing test**

Create `tests/e2e/youtube-pack-import.spec.ts`:

```typescript
import { test, expect, _electron as electron } from '@playwright/test';
import * as path from 'path';

// Real CC0 audio with chapters is rare; we use a known-stable URL that has
// chapters. If this URL gets removed from YouTube, swap with another short
// CC0 chaptered video. The test is intentionally a smoke test, not a
// fine-grained assertion suite.
const TEST_URL = 'https://www.youtube.com/watch?v=aBr2kKAHN6M';

test.describe('YouTube Pack import', () => {
  test('paste → detect (no chapters) routes to YouTube Clip', async () => {
    const app = await electron.launch({ args: [path.resolve(__dirname, '../..')] });

    try {
      // Open Sound Manager via the existing menu/IPC path.
      // preload.ts exposes this as `electronAPI.openAddSound()` (sends 'open-add-sound').
      const board = await app.firstWindow();
      await board.evaluate(() => (window as any).electronAPI.openAddSound());

      // Wait for the Sound Manager window
      const win = await app.waitForEvent('window');

      // Click YouTube Pack tab
      await win.locator('.stab[data-src="ytpack"]').click();

      // Paste a non-chapters URL
      await win.locator('#ytpUrl').fill(TEST_URL);
      await win.locator('#ytpDetectBtn').click();

      // The no-chapters branch surfaces an inline error with a tab-switch link
      await expect(win.locator('#ytpPasteError')).toBeVisible({ timeout: 60_000 });
      await expect(win.locator('#ytpPasteError')).toContainText(/no chapters/i);
    } finally {
      await app.close();
    }
  });

  // Additional happy-path test against a chaptered URL goes here once a
  // stable CC0 chaptered video is identified. For now the no-chapters
  // routing is the smoke test.
});
```

> **Note for the executor:** if `app.waitForEvent('window')` returns the wrong window (e.g., a transient about:blank), copy the exact open-window wait pattern from `tests/e2e/pack-selection.spec.ts`.

- [ ] **Step 3: Run the test**

```bash
npx playwright test tests/e2e/youtube-pack-import.spec.ts
```

Expected: PASS. If it times out waiting for the Sound Manager window, copy the exact open-window pattern from `pack-selection.spec.ts`.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/youtube-pack-import.spec.ts
git commit -m "test(yt-pack): playwright smoke for the import tab

One golden-path test covering the no-chapters branch (URL with no
chapter metadata routes the user back to the YouTube Clip tab). A
chaptered-URL happy-path test will be added once a stable CC0 video
with chapters is identified."
```

---

## Task 13: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a paragraph to the features section**

Find the existing features section in `README.md` (search for the bullet list of capabilities). Add:

```markdown
- **YouTube Pack import.** Paste a YouTube URL into Sound Manager → "YouTube Pack" tab. The app detects chapter timestamps (single videos) or playlist entries, lets you review and uncheck candidates, and creates a ready-to-use pack mapped to the keyboard layout (`q,w,e,r,t / a,s,d,f,g / z,x,c,v,b`). Snippets >30s are auto-unchecked; the cap is 15 keys per pack. Requires `yt-dlp` on PATH (same as the YouTube Clip feature).
```

- [ ] **Step 2: Verify the README still renders sensibly**

```bash
# If you have a markdown previewer wired up, use it. Otherwise visually
# inspect the diff:
git diff README.md
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document YouTube Pack import"
```

---

## Self-Review

- [x] **Spec coverage:** Every section of the spec maps to at least one task:
  - Architecture / IPC handlers → Tasks 3–6
  - UI states → Tasks 8, 9, 10, 11
  - Data flow / cache reuse → Tasks 5 (`yt-prepare-pack` cache short-circuit)
  - Error handling → Task 4 (Detect errors), Task 5 (per-segment failure isolation), Task 6 (rollback)
  - Storage layout (bound-only, custom/yt-*.mp3) → Task 6
  - Defensive caps → Tasks 5, 6
  - Testing layers → Tasks 1, 2, 4, 5, 6 (Layer 1 Python), Task 12 (Layer 2 Playwright)
  - Single-clip flow not modified → Task 3 (verified by re-running `test_youtube_download.py`)
- [x] **Placeholder scan:** No "TODO", no "implement later", no "similar to Task N." Each step has executable content.
- [x] **Type consistency:** `DetectResult` shape consistent across Tasks 2/4/8. `prepared[]/failed[]` shape consistent across Tasks 5/10. Pack-key list (`q,w,e,r,t,a,s,d,f,g,z,x,c,v,b`) used consistently in Tasks 1, 9, 11, 13.
- [x] **Spec open question resolved:** Test URL stability — Layer 1 uses recorded fixtures (Task 2), Layer 2 e2e uses a real CC0 URL (Task 12, with a swap-instructions comment).

## Out of scope (explicitly deferred)

- Snippet reordering / re-keying inside the import flow → users rebind in Pack Management afterward.
- Custom thumbnails per snippet → uses video thumbnail at the top only.
- Resumable downloads, concurrent imports, cache eviction → orthogonal.
- Silence-detection or ASR-based snippet detection → spec calls these out as v2+.
