"""
Unit tests for virtual audio driver detection.

Mirrors isVirtualAudioDevice() in main.ts (dual-implementation pattern —
matches test_record_pipeline.py). No binaries, no Electron.

Run with: python3 -m pytest tests/test_blackhole_detection.py -v
"""
import re
import unittest

VIRTUAL_DRIVER_RE = re.compile(
    r'BlackHole|VB-Cable|Soundflower|Loopback Audio', re.IGNORECASE
)

def is_virtual_audio_device(name: str) -> bool:
    """Return True if the device label matches a known virtual audio driver."""
    return bool(VIRTUAL_DRIVER_RE.search(name))


class TestIsVirtualAudioDevice(unittest.TestCase):
    def test_blackhole_variants(self):
        self.assertTrue(is_virtual_audio_device('BlackHole 2ch'))
        self.assertTrue(is_virtual_audio_device('blackhole 16ch'))
        self.assertTrue(is_virtual_audio_device('BLACKHOLE'))

    def test_other_virtual_drivers(self):
        self.assertTrue(is_virtual_audio_device('VB-Cable'))
        self.assertTrue(is_virtual_audio_device('Soundflower (2ch)'))
        self.assertTrue(is_virtual_audio_device('Loopback Audio'))

    def test_real_devices_excluded(self):
        self.assertFalse(is_virtual_audio_device('MacBook Pro Speakers'))
        self.assertFalse(is_virtual_audio_device('AirPods Pro'))
        self.assertFalse(is_virtual_audio_device('External Headphones'))
        self.assertFalse(is_virtual_audio_device(''))

    def test_partial_match_in_label(self):
        self.assertTrue(is_virtual_audio_device('Existential Audio BlackHole 2ch'))

    def test_case_insensitive(self):
        self.assertTrue(is_virtual_audio_device('soundflower'))
        self.assertTrue(is_virtual_audio_device('loopback audio'))


if __name__ == '__main__':
    unittest.main()
