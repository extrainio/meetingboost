"""Tests for MeetingBoost sound assets and pack manifest."""

import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOUNDS_DIR = os.path.join(ROOT, 'src', 'sounds')
PACKS_JSON = os.path.join(ROOT, 'src', 'packs.json')

MIN_BYTES = 5_000  # anything under this is a CDN error page or silent placeholder

MP3_MAGIC = (
    b'ID3',          # ID3v2 tag (most common)
    b'\xff\xfb',     # MPEG1 Layer3 CBR
    b'\xff\xf3',     # MPEG2 Layer3
    b'\xff\xf2',     # MPEG2.5 Layer3
    b'\xff\xe3',     # MPEG2 Layer3 (alt)
    b'\xff\xe2',
)


def is_valid_mp3(path: str) -> tuple[bool, str]:
    if not os.path.exists(path):
        return False, 'missing'
    size = os.path.getsize(path)
    if size < MIN_BYTES:
        return False, f'too small ({size}B — likely CDN error page)'
    with open(path, 'rb') as f:
        header = f.read(10)
    if not any(header.startswith(m) for m in MP3_MAGIC):
        return False, f'bad header: {header[:4].hex()}'
    return True, 'ok'


class TestPackManifest(unittest.TestCase):

    def setUp(self):
        with open(PACKS_JSON) as f:
            self.packs = json.load(f)

    def test_has_three_packs(self):
        self.assertEqual(len(self.packs), 3)

    def test_pack_ids(self):
        ids = {p['id'] for p in self.packs}
        self.assertEqual(ids, {'classics', 'corporate', 'hype'})

    def test_required_fields(self):
        for pack in self.packs:
            for field in ('id', 'name', 'description', 'keys'):
                self.assertIn(field, pack, f"pack '{pack.get('id')}' missing '{field}'")

    def test_key_entries_have_label_and_file(self):
        for pack in self.packs:
            for key, entry in pack['keys'].items():
                self.assertIn('label', entry, f"{pack['id']}/{key} missing label")
                self.assertIn('file', entry,  f"{pack['id']}/{key} missing file")

    def test_all_referenced_files_exist(self):
        missing = []
        for pack in self.packs:
            for key, entry in pack['keys'].items():
                path = os.path.join(SOUNDS_DIR, entry['file'])
                if not os.path.exists(path):
                    missing.append(entry['file'])
        self.assertEqual(missing, [], f"Missing files: {missing}")


class TestSoundFiles(unittest.TestCase):

    def _load_all_paths(self):
        with open(PACKS_JSON) as f:
            packs = json.load(f)
        return [(p['id'], k, e['file']) for p in packs for k, e in p['keys'].items()]

    def test_all_mp3s_are_valid(self):
        failures = []
        for pack_id, key, rel_path in self._load_all_paths():
            full = os.path.join(SOUNDS_DIR, rel_path)
            ok, reason = is_valid_mp3(full)
            if not ok:
                failures.append(f'{pack_id}/{key} ({rel_path}): {reason}')
        self.assertEqual(failures, [], '\n'.join(failures))

    def test_no_unexpectedly_large_files(self):
        MAX_BYTES = 5_000_000  # 5MB — full albums shouldn't slip in
        oversized = []
        for _, _, rel_path in self._load_all_paths():
            full = os.path.join(SOUNDS_DIR, rel_path)
            if os.path.exists(full) and os.path.getsize(full) > MAX_BYTES:
                oversized.append(f'{rel_path} ({os.path.getsize(full)//1024}KB)')
        self.assertEqual(oversized, [], f"Oversized: {oversized}")

    def test_sound_count_per_pack(self):
        with open(PACKS_JSON) as f:
            packs = json.load(f)
        for pack in packs:
            count = len(pack['keys'])
            self.assertGreaterEqual(count, 5, f"Pack '{pack['id']}' only has {count} sounds")


class TestTypeScriptBuild(unittest.TestCase):

    def test_tsc_compiles_without_errors(self):
        result = subprocess.run(
            ['./node_modules/.bin/tsc', '--noEmit'],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            result.returncode, 0,
            f"TypeScript errors:\n{result.stdout}\n{result.stderr}"
        )

    def test_compiled_files_exist(self):
        for fname in ('main.js', 'preload.js'):
            self.assertTrue(
                os.path.exists(os.path.join(ROOT, fname)),
                f"{fname} not found — run `npm run build`"
            )


class TestPacksJsonSyntax(unittest.TestCase):

    def test_valid_json(self):
        try:
            with open(PACKS_JSON) as f:
                json.load(f)
        except json.JSONDecodeError as e:
            self.fail(f'packs.json is not valid JSON: {e}')

    def test_no_duplicate_keys_within_pack(self):
        with open(PACKS_JSON) as f:
            packs = json.load(f)
        for pack in packs:
            keys = list(pack['keys'].keys())
            self.assertEqual(len(keys), len(set(keys)),
                             f"Duplicate keys in pack '{pack['id']}'")

    def test_all_keys_are_single_lowercase_letters(self):
        with open(PACKS_JSON) as f:
            packs = json.load(f)
        for pack in packs:
            for k in pack['keys']:
                self.assertRegex(k, r'^[a-z]$',
                                 f"Invalid key '{k}' in pack '{pack['id']}'")


if __name__ == '__main__':
    unittest.main(verbosity=2)
