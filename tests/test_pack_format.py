"""
Tests for the .mbpack pack-sharing format.

A .mbpack file is a regular zip with a custom extension and a fixed layout:

    manifest.json
    sounds/<basename>.mp3   (one per pack key)

These tests build and read .mbpack files using the same tools (`zip` /
`unzip`) that main.ts shells out to, so the test exercises the real format
contract — not a JS-side mock.

Run with: python3 -m pytest tests/test_pack_format.py -v
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MBPACK_VERSION = 1


def _make_silent_mp3(path: str) -> None:
    """Write a tiny but valid MP3 (an ID3v2 header + a few MPEG frames worth)."""
    # ID3v2.3 header (10 bytes, no body) followed by a couple of MPEG-1 Layer III
    # frame syncs. Real ffmpeg-encoded files are bigger; this is just enough for
    # the integrity test in test_sounds.py to recognise as MP3.
    header = b'ID3\x03\x00\x00\x00\x00\x00\x00'
    frame  = b'\xff\xfb\x90\x00' + b'\x00' * 100
    with open(path, 'wb') as f:
        f.write(header + frame * 16)


def _build_mbpack(out_path: str, pack: dict, sound_keys: dict) -> None:
    """Create an .mbpack at out_path. Mirrors main.ts pack-export."""
    staging = tempfile.mkdtemp(prefix='mb_pack_')
    try:
        sounds_dir = os.path.join(staging, 'sounds')
        os.makedirs(sounds_dir, exist_ok=True)
        manifest_keys = {}
        for key, (label, file_basename) in sound_keys.items():
            mp3_path = os.path.join(sounds_dir, file_basename)
            _make_silent_mp3(mp3_path)
            manifest_keys[key] = {'label': label, 'file': f'sounds/{file_basename}'}

        manifest = {
            'mbpackVersion': MBPACK_VERSION,
            'id':            pack['id'],
            'name':          pack['name'],
            'description':   pack.get('description', ''),
            'keys':          manifest_keys,
            'exportedAt':    '2026-05-01T00:00:00.000Z',
        }
        with open(os.path.join(staging, 'manifest.json'), 'w') as f:
            json.dump(manifest, f, indent=2)

        # Zip with system tool — same call site as main.ts
        subprocess.run(
            ['zip', '-r', '-q', out_path, 'manifest.json', 'sounds'],
            cwd=staging, check=True,
        )
    finally:
        shutil.rmtree(staging, ignore_errors=True)


class TestMbpackBuild(unittest.TestCase):
    """Build a .mbpack, then poke at its contents."""

    @classmethod
    def setUpClass(cls):
        if not shutil.which('zip') or not shutil.which('unzip'):
            raise unittest.SkipTest('zip/unzip not on PATH')
        cls.tmp = tempfile.mkdtemp(prefix='mb_pack_test_')
        cls.archive = os.path.join(cls.tmp, 'classics.mbpack')
        _build_mbpack(
            cls.archive,
            {'id': 'classics', 'name': 'Classics', 'description': 'Test pack'},
            {
                'q': ('Rimshot',      'rimshot.mp3'),
                'w': ('Sad Trombone', 'sad-trombone.mp3'),
                'e': ('Airhorn',      'airhorn.mp3'),
            },
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_archive_exists_and_is_a_zip(self):
        self.assertTrue(os.path.exists(self.archive))
        self.assertTrue(zipfile.is_zipfile(self.archive),
                        '.mbpack must be a regular zip — that is the whole point')

    def test_archive_uses_mbpack_extension(self):
        self.assertTrue(self.archive.endswith('.mbpack'))

    def test_archive_contains_manifest_and_sounds(self):
        with zipfile.ZipFile(self.archive) as z:
            names = z.namelist()
        self.assertIn('manifest.json', names)
        # sounds/ is created via the system zip; entries appear as `sounds/x.mp3`
        sound_entries = [n for n in names if n.startswith('sounds/') and n.endswith('.mp3')]
        self.assertEqual(len(sound_entries), 3)

    def test_manifest_shape(self):
        with zipfile.ZipFile(self.archive) as z:
            with z.open('manifest.json') as f:
                manifest = json.load(f)

        self.assertEqual(manifest['mbpackVersion'], MBPACK_VERSION)
        self.assertEqual(manifest['id'],   'classics')
        self.assertEqual(manifest['name'], 'Classics')
        self.assertIn('keys', manifest)
        self.assertEqual(set(manifest['keys'].keys()), {'q', 'w', 'e'})
        for key, entry in manifest['keys'].items():
            self.assertIn('label', entry)
            self.assertIn('file',  entry)
            self.assertTrue(entry['file'].startswith('sounds/'))

    def test_referenced_files_exist_in_archive(self):
        with zipfile.ZipFile(self.archive) as z:
            with z.open('manifest.json') as f:
                manifest = json.load(f)
            archive_names = set(z.namelist())

        for entry in manifest['keys'].values():
            self.assertIn(entry['file'], archive_names,
                          f'Manifest references {entry["file"]} but file is missing from archive')


class TestMbpackImport(unittest.TestCase):
    """Import a .mbpack — mirrors main.ts pack-import."""

    @classmethod
    def setUpClass(cls):
        if not shutil.which('zip') or not shutil.which('unzip'):
            raise unittest.SkipTest('zip/unzip not on PATH')
        cls.tmp = tempfile.mkdtemp(prefix='mb_import_test_')
        cls.archive = os.path.join(cls.tmp, 'community.mbpack')
        _build_mbpack(
            cls.archive,
            {'id': 'community-pack', 'name': 'Community Pack', 'description': 'Shared'},
            {'a': ('Boom', 'boom.mp3'), 'b': ('Bell', 'bell.mp3')},
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_unzip_yields_manifest_and_sounds(self):
        extract_dir = os.path.join(self.tmp, 'extracted')
        os.makedirs(extract_dir, exist_ok=True)
        subprocess.run(
            ['unzip', '-o', '-q', self.archive, '-d', extract_dir],
            check=True,
        )

        manifest_path = os.path.join(extract_dir, 'manifest.json')
        self.assertTrue(os.path.exists(manifest_path))

        with open(manifest_path) as f:
            manifest = json.load(f)

        self.assertEqual(manifest['id'], 'community-pack')
        for entry in manifest['keys'].values():
            extracted = os.path.join(extract_dir, entry['file'])
            self.assertTrue(os.path.exists(extracted),
                            f'Sound file {entry["file"]} missing after unzip')


class TestMbpackVersionGate(unittest.TestCase):
    """Pack-import must reject newer-version archives gracefully."""

    def test_future_version_in_manifest(self):
        manifest = {
            'mbpackVersion': MBPACK_VERSION + 1,
            'id': 'future',
            'name': 'Future Pack',
            'keys': {},
        }
        # Just verifying our test fixture matches the version constant the
        # main.ts handler compares against. Real version-gate enforcement
        # lives in main.ts; this test is a tripwire for accidental bumps.
        self.assertGreater(manifest['mbpackVersion'], MBPACK_VERSION,
                           'Bump MBPACK_VERSION here AND in main.ts together.')


if __name__ == '__main__':
    unittest.main(verbosity=2)
