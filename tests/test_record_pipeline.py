"""
Integration test for the voice-recording ffmpeg pipeline.

main.ts handles voice recordings by:
  1. Receiving a WebM/Opus blob over IPC (from MediaRecorder in the renderer)
  2. Writing it to a temp file
  3. Running:  ffmpeg -y -i <tmp.webm> -acodec libmp3lame -q:a 2 <out.mp3>
  4. Merging the MP3 into packs.json

Step 3 is the only piece that touches a real binary. This test synthesizes
a small Opus-in-WebM file with ffmpeg (mirroring what Chromium's
MediaRecorder produces) and runs the exact same ffmpeg invocation the
main process uses, verifying the output is a valid MP3.

Run with: python3 -m pytest tests/test_record_pipeline.py -v
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest


def find_bin(name: str):
    return shutil.which(name)


def is_valid_mp3(path: str) -> bool:
    if not os.path.exists(path) or os.path.getsize(path) < 200:
        return False
    with open(path, 'rb') as f:
        header = f.read(4)
    return header[:3] == b'ID3' or header[:2] in (
        b'\xff\xfb', b'\xff\xf3', b'\xff\xf2', b'\xff\xe3',
    )


class TestRecordingPipeline(unittest.TestCase):
    """End-to-end ffmpeg call mirroring main.ts record-save."""

    @classmethod
    def setUpClass(cls):
        if not find_bin('ffmpeg'):
            raise unittest.SkipTest('ffmpeg not installed')
        if not find_bin('ffprobe'):
            raise unittest.SkipTest('ffprobe not installed')

        cls.tmp = tempfile.mkdtemp(prefix='mb_rec_')

        # Synthesize a 1.5-second Opus-in-WebM file — same container/codec
        # combo Chromium MediaRecorder produces with mimeType
        # 'audio/webm;codecs=opus'.
        cls.webm = os.path.join(cls.tmp, 'fake_recording.webm')
        result = subprocess.run(
            ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5',
             '-acodec', 'libopus', '-b:a', '64k', cls.webm],
            capture_output=True, timeout=15,
        )
        if result.returncode != 0:
            raise unittest.SkipTest(
                f'ffmpeg cannot encode Opus on this machine: {result.stderr[:200]!r}'
            )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_synthesized_webm_is_non_empty(self):
        self.assertTrue(os.path.exists(self.webm))
        self.assertGreater(os.path.getsize(self.webm), 100)

    def test_record_save_ffmpeg_command_produces_valid_mp3(self):
        """Replays the exact ffmpeg call from main.ts ipcMain.handle('record-save')."""
        out_mp3 = os.path.join(self.tmp, 'recording.mp3')

        # ↓ This list MUST match the args in main.ts. Update both together.
        result = subprocess.run(
            ['ffmpeg', '-y', '-i', self.webm,
             '-acodec', 'libmp3lame', '-q:a', '2',
             out_mp3],
            capture_output=True, timeout=15,
        )

        self.assertEqual(result.returncode, 0,
                         f'ffmpeg failed:\n{result.stderr.decode()[:400]}')
        self.assertTrue(os.path.exists(out_mp3), 'MP3 was not produced')
        self.assertTrue(is_valid_mp3(out_mp3),
                        'Output failed MP3 magic-byte check')
        self.assertGreater(os.path.getsize(out_mp3), 1000,
                           'Output MP3 is suspiciously small')

    def test_recorded_mp3_duration_is_preserved(self):
        out_mp3 = os.path.join(self.tmp, 'duration_check.mp3')
        subprocess.run(
            ['ffmpeg', '-y', '-i', self.webm,
             '-acodec', 'libmp3lame', '-q:a', '2', out_mp3],
            capture_output=True, check=True, timeout=15,
        )
        info = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', out_mp3],
            capture_output=True, text=True, check=True,
        )
        duration = float(json.loads(info.stdout)['format']['duration'])
        # Source is 1.5 s sine — MP3 reencode should be within ±0.3 s
        self.assertAlmostEqual(duration, 1.5, delta=0.3,
                               msg=f'Recorded MP3 duration {duration:.2f}s drifted from 1.5s source')


if __name__ == '__main__':
    unittest.main(verbosity=2)
