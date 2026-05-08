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
import re
import shutil
import subprocess
import tempfile
import time
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

    def test_keeps_exact_min_boundary(self):
        # dur == 0.3 is kept (guard is < 0.3, strictly less than)
        result = filter_snippets([
            {'title': 'edge', 'start': 0, 'end': 0.3},
        ])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['title'], 'edge')

    def test_exact_max_boundary_is_autocheck(self):
        # dur == 30.0 is autoCheck=True (guard is > 30, strictly greater than)
        result = filter_snippets([
            {'title': 'edge', 'start': 0, 'end': 30.0},
        ])
        self.assertTrue(result[0]['autoCheck'])
        self.assertIsNone(result[0]['reason'])


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

    def test_empty_input(self):
        result = map_snippets_to_keys([])
        self.assertEqual(result['mapped'], [])
        self.assertEqual(result['overflow_count'], 0)


def slugify_pack_name(name, existing_names):
    """
    Returns {'finalName': str, 'packId': str}.
    - Empty/whitespace name → 'YouTube Pack'.
    - On collision with existing_names: append ' (2)', ' (3)', ...
    - packId is the slug of finalName + a unix-ms suffix if slug is empty.
    """
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

    def test_slug_generation_basic(self):
        r = slugify_pack_name('Tom & Jerry', [])
        self.assertEqual(r['packId'], 'tom-jerry')

    def test_empty_slug_falls_back_to_yt_pack_prefix(self):
        # Title with no ASCII alphanumerics produces empty slug; fallback uses
        # a 'yt-pack-<timestamp>' shape. We assert the prefix only, since the
        # timestamp is non-deterministic by design.
        r = slugify_pack_name('한국어', [])
        self.assertTrue(r['packId'].startswith('yt-pack-'),
                        f"expected yt-pack-* prefix, got {r['packId']}")


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

    if raw.get('_type') == 'playlist' and isinstance(raw.get('entries'), list) and len(raw['entries']) > 0:
        items = []
        for e in raw['entries']:
            items.append({
                'videoId':  e.get('id', ''),
                'title':    e.get('title', ''),
                'duration': e.get('duration'),
            })
        return {'kind': 'playlist', 'items': items, 'meta': meta}

    chapters = raw.get('chapters')
    if isinstance(chapters, list) and len(chapters) > 0:
        out = []
        for c in chapters:
            st = c.get('start_time')
            et = c.get('end_time')
            out.append({
                'title': c.get('title') or 'Untitled',
                'start': float(st if st is not None else 0),
                'end':   float(et if et is not None else 0),
            })
        return {'kind': 'chapters', 'chapters': out, 'meta': meta}

    return {'kind': 'none', 'meta': meta}


class TestClassifyDetectResult(unittest.TestCase):
    def test_chapters_fixture(self):
        with open(os.path.join(FIXTURES_DIR, 'yt_detect_chapters.json')) as f:
            raw = json.load(f)
        result = classify_detect_result(raw)
        self.assertEqual(result['kind'], 'chapters')
        self.assertEqual(len(result['chapters']), 5)
        self.assertEqual(result['chapters'][0]['title'], 'Intro Sting')
        self.assertEqual(result['chapters'][0]['start'], 0.0)
        self.assertEqual(result['chapters'][0]['end'], 6.0)
        self.assertEqual(result['meta']['title'], 'Sound Effects Compilation')

    def test_playlist_fixture(self):
        with open(os.path.join(FIXTURES_DIR, 'yt_detect_playlist.json')) as f:
            raw = json.load(f)
        result = classify_detect_result(raw)
        self.assertEqual(result['kind'], 'playlist')
        self.assertEqual(len(result['items']), 3)
        self.assertEqual(result['items'][0]['videoId'], 'vidA')
        self.assertEqual(result['items'][0]['title'], 'Airhorn')
        self.assertEqual(result['items'][0]['duration'], 4)

    def test_none_fixture(self):
        with open(os.path.join(FIXTURES_DIR, 'yt_detect_none.json')) as f:
            raw = json.load(f)
        result = classify_detect_result(raw)
        self.assertEqual(result['kind'], 'none')
        self.assertEqual(result['meta']['title'], 'Single Plain Video')

    def test_empty_chapters_treated_as_none(self):
        # Defensive: yt-dlp can return chapters: [] for some videos.
        # Should classify as 'none', not as 'chapters' with zero entries.
        result = classify_detect_result({
            '_type': 'video', 'title': 'X', 'chapters': [],
        })
        self.assertEqual(result['kind'], 'none')

    def test_empty_playlist_treated_as_none(self):
        # Symmetric with test_empty_chapters_treated_as_none: an empty
        # playlist has no usable items, so we route it through to the
        # 'none' branch and let the UI surface a clean error.
        result = classify_detect_result({
            '_type': 'playlist', 'title': 'Empty', 'entries': [],
        })
        self.assertEqual(result['kind'], 'none')

    def test_chapters_with_null_timestamps_default_to_zero(self):
        # yt-dlp can emit chapters with null start_time/end_time on
        # malformed inputs. Both TS (Number(null ?? 0)) and Python should
        # normalize to 0 rather than crashing.
        result = classify_detect_result({
            '_type': 'video', 'title': 'X',
            'chapters': [
                {'title': None, 'start_time': None, 'end_time': None},
                {'title': 'Real', 'start_time': 5, 'end_time': 10},
            ],
        })
        self.assertEqual(result['kind'], 'chapters')
        self.assertEqual(result['chapters'][0]['title'], 'Untitled')
        self.assertEqual(result['chapters'][0]['start'], 0.0)
        self.assertEqual(result['chapters'][0]['end'], 0.0)
        self.assertEqual(result['chapters'][1]['title'], 'Real')


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
        classified = classify_detect_result(data)
        # This particular URL has no chapters
        self.assertEqual(classified['kind'], 'none')


if __name__ == '__main__':
    unittest.main()
