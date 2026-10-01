import unittest
from polish import validate_polished_chunk

class PolishTests(unittest.TestCase):
    def test_preserves_anchor(self):
        source='[00:02](https://youtu.be/example?t=2) **SPEAKER_00**: 原话'
        validate_polished_chunk(source, source.replace('原话', '整理后的话'))
    def test_missing_anchor_fails(self):
        with self.assertRaises(ValueError):
            validate_polished_chunk('[00:02](https://youtu.be/example?t=2) 原话', '原话')
    def test_speaker_guess_fails(self):
        with self.assertRaises(ValueError):
            validate_polished_chunk('SPEAKER_00 原话', '某位人物 原话')
    def test_empty_output_fails(self):
        with self.assertRaises(ValueError):
            validate_polished_chunk('原话', '')
