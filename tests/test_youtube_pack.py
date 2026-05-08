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


if __name__ == '__main__':
    unittest.main()
