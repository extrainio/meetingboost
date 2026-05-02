"""
Tests for the YouTube download + crop pipeline.

Uses a 5-second public-domain audio clip from YouTube to exercise
the real yt-dlp → ffmpeg → MP3 chain without mocking.

Run with: python3 -m pytest tests/test_youtube_download.py -v
(requires yt-dlp and ffmpeg to be installed on PATH)
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOUNDS_DIR = os.path.join(ROOT, 'src', 'sounds', 'custom')
PACKS_JSON = os.path.join(ROOT, 'src', 'packs.json')

# Short (5s) CC0 audio on YouTube used for integration testing
TEST_YOUTUBE_URL = 'https://www.youtube.com/watch?v=aBr2kKAHN6M'  # To Be Continued (short)
TEST_START = 0
TEST_END   = 3


def find_bin(name: str) -> str | None:
    return shutil.which(name)


def is_valid_mp3(path: str) -> bool:
    if not os.path.exists(path) or os.path.getsize(path) < 1000:
        return False
    with open(path, 'rb') as f:
        header = f.read(4)
    return header[:3] == b'ID3' or header[:2] in (b'\xff\xfb', b'\xff\xf3', b'\xff\xf2', b'\xff\xe3')


class TestToolAvailability(unittest.TestCase):
    """Check required CLI tools exist before attempting downloads."""

    def test_yt_dlp_is_installed(self):
        self.assertIsNotNone(find_bin('yt-dlp'), 'yt-dlp not found — install it to enable YouTube downloads')

    def test_ffmpeg_is_installed(self):
        self.assertIsNotNone(find_bin('ffmpeg'), 'ffmpeg not found — install it to enable audio cropping')


class TestTimeParsing(unittest.TestCase):
    """Test time string → seconds parsing (mirrors the JS parseSec() in sound-manager.html)."""

    def _parse(self, val: str) -> float:
        val = str(val).strip()
        parts = val.split(':')
        if len(parts) == 1:
            return float(parts[0])
        return int(parts[0]) * 60 + float(parts[1])

    def test_plain_seconds(self):
        self.assertAlmostEqual(self._parse('5'),    5.0)
        self.assertAlmostEqual(self._parse('1.5'),  1.5)
        self.assertAlmostEqual(self._parse('90'),  90.0)

    def test_minutes_seconds(self):
        self.assertAlmostEqual(self._parse('0:01.2'), 1.2)
        self.assertAlmostEqual(self._parse('1:30.5'), 90.5)
        self.assertAlmostEqual(self._parse('2:00'),  120.0)

    def test_zero(self):
        self.assertAlmostEqual(self._parse('0'), 0.0)


class TestYtdlpDownload(unittest.TestCase):
    """Integration: yt-dlp downloads audio from YouTube."""

    @classmethod
    def setUpClass(cls):
        if not find_bin('yt-dlp'):
            raise unittest.SkipTest('yt-dlp not installed')
        cls.tmp_dir = tempfile.mkdtemp(prefix='mb_test_')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp_dir, ignore_errors=True)

    def test_download_produces_mp3(self):
        out_tmpl = os.path.join(self.tmp_dir, 'test.%(ext)s')
        result = subprocess.run(
            ['yt-dlp', '-x', '--audio-format', 'mp3', '--audio-quality', '5',
             '--no-playlist', '-o', out_tmpl, TEST_YOUTUBE_URL],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, f'yt-dlp failed:\n{result.stderr[:300]}')

        out_mp3 = out_tmpl.replace('%(ext)s', 'mp3')
        self.assertTrue(os.path.exists(out_mp3), 'No MP3 output file found')
        self.assertGreater(os.path.getsize(out_mp3), 10_000, 'Output file suspiciously small')
        self.assertTrue(is_valid_mp3(out_mp3), 'Output file is not a valid MP3')


class TestFfmpegCrop(unittest.TestCase):
    """Integration: ffmpeg crops a downloaded MP3 to the requested range."""

    @classmethod
    def setUpClass(cls):
        if not find_bin('ffmpeg'):
            raise unittest.SkipTest('ffmpeg not installed')
        if not find_bin('yt-dlp'):
            raise unittest.SkipTest('yt-dlp not installed')

        cls.tmp_dir = tempfile.mkdtemp(prefix='mb_test_')

        # Download once for all crop tests
        out_tmpl = os.path.join(cls.tmp_dir, 'source.%(ext)s')
        subprocess.run(
            ['yt-dlp', '-x', '--audio-format', 'mp3', '--audio-quality', '5',
             '--no-playlist', '-o', out_tmpl, TEST_YOUTUBE_URL],
            capture_output=True, timeout=120, check=True,
        )
        cls.source_mp3 = out_tmpl.replace('%(ext)s', 'mp3')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp_dir, ignore_errors=True)

    def _crop(self, start: float, duration: float, suffix: str) -> str:
        out = os.path.join(self.tmp_dir, f'crop_{suffix}.mp3')
        subprocess.run(
            ['ffmpeg', '-y', '-ss', str(start), '-t', str(duration),
             '-i', self.source_mp3, '-acodec', 'libmp3lame', '-q:a', '2', out],
            capture_output=True, timeout=30, check=True,
        )
        return out

    def test_crop_produces_valid_mp3(self):
        out = self._crop(TEST_START, TEST_END - TEST_START, 'basic')
        self.assertTrue(is_valid_mp3(out), 'Cropped file is not a valid MP3')

    def test_crop_file_is_smaller_than_source(self):
        out = self._crop(TEST_START, TEST_END - TEST_START, 'size')
        self.assertLess(os.path.getsize(out), os.path.getsize(self.source_mp3))

    def test_crop_duration_is_approximate(self):
        """Verify the cropped file duration is roughly correct via ffprobe."""
        if not find_bin('ffprobe'):
            self.skipTest('ffprobe not installed')
        out = self._crop(TEST_START, TEST_END - TEST_START, 'dur')
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', out],
            capture_output=True, text=True, timeout=10,
        )
        info = json.loads(result.stdout)
        actual = float(info['format']['duration'])
        expected = TEST_END - TEST_START
        self.assertAlmostEqual(actual, expected, delta=0.5,
                               msg=f'Cropped duration {actual:.1f}s != expected {expected}s')


class TestPacksJsonUpdate(unittest.TestCase):
    """Unit: updating packs.json with a new custom sound entry."""

    def setUp(self):
        with open(PACKS_JSON) as f:
            self.original = f.read()

    def tearDown(self):
        with open(PACKS_JSON, 'w') as f:
            f.write(self.original)

    def _add_custom_sound(self, key: str, label: str, filename: str):
        with open(PACKS_JSON) as f:
            packs = json.load(f)
        custom = next((p for p in packs if p['id'] == 'custom'), None)
        if not custom:
            custom = {'id': 'custom', 'name': 'My Sounds', 'description': 'Custom sounds', 'keys': {}}
            packs.append(custom)
        custom['keys'][key] = {'label': label, 'file': f'custom/{filename}.mp3'}
        with open(PACKS_JSON, 'w') as f:
            json.dump(packs, f, indent=2)
        return packs

    def test_add_creates_custom_pack_if_missing(self):
        packs = self._add_custom_sound('y', 'Test Sound', 'test-sound')
        ids = [p['id'] for p in packs]
        self.assertIn('custom', ids)

    def test_add_sets_correct_key_entry(self):
        self._add_custom_sound('y', 'Test Sound', 'test-sound')
        with open(PACKS_JSON) as f:
            packs = json.load(f)
        custom = next(p for p in packs if p['id'] == 'custom')
        self.assertEqual(custom['keys']['y']['label'], 'Test Sound')
        self.assertEqual(custom['keys']['y']['file'], 'custom/test-sound.mp3')

    def test_add_preserves_existing_packs(self):
        packs_before = json.loads(self.original)
        self._add_custom_sound('y', 'Test Sound', 'test-sound')
        with open(PACKS_JSON) as f:
            packs_after = json.load(f)
        orig_ids = {p['id'] for p in packs_before}
        new_ids  = {p['id'] for p in packs_after}
        self.assertTrue(orig_ids.issubset(new_ids))

    def test_json_remains_valid_after_update(self):
        self._add_custom_sound('y', 'Test Sound', 'test-sound')
        try:
            with open(PACKS_JSON) as f:
                json.load(f)
        except json.JSONDecodeError as e:
            self.fail(f'packs.json is invalid after update: {e}')


if __name__ == '__main__':
    unittest.main(verbosity=2)
