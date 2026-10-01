import tempfile
import unittest
from pathlib import Path
from transcribe import default_output_path

class OutputTests(unittest.TestCase):
    def test_distinct_urls_and_existing_outputs_are_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory=Path(tmp)
            one=default_output_path('https://youtu.be/first',directory,True)
            two=default_output_path('https://youtu.be/second',directory,True)
            self.assertNotEqual(one,two)
            one.write_text('Existing user document')
            again=default_output_path('https://youtu.be/first',directory,True)
            self.assertNotEqual(one,again)
            self.assertEqual(one.read_text(),'Existing user document')
