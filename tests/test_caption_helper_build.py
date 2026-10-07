"""Pure build-contract regressions; do not download or execute helper dependencies."""
import hashlib
import json
from pathlib import Path
import unittest
from scripts.build_caption_helper import expand_macho_path, ROOT


class CaptionBuildContracts(unittest.TestCase):
    def test_exact_and_nested_loader_tokens(self):
        native=Path('/private/archive/libssl.3.dylib');executable=Path('/private/dist/coconut-caption')
        self.assertEqual(expand_macho_path('@loader_path',native,executable),native.parent)
        self.assertEqual(expand_macho_path('@loader_path/../lib',native,executable),native.parent/'../lib')
        self.assertEqual(expand_macho_path('@executable_path',native,executable),executable.parent)
        self.assertEqual(expand_macho_path('@executable_path/nested',native,executable),executable.parent/'nested')
        # Common top-level LC_RPATH must locate the sibling libcrypto binary.
        self.assertEqual(expand_macho_path('@loader_path',native,executable)/'libcrypto.3.dylib',Path('/private/archive/libcrypto.3.dylib'))

    def test_vendored_notice_and_source_hashes(self):
        root=ROOT/'desktop/vendor/caption-helper-notices'
        for entry in json.loads((root/'sources.json').read_text())['files']:
            with self.subTest(file=entry['file']):
                body=(root/entry['file']).read_bytes()
                self.assertEqual(len(body),entry['bytes'])
                self.assertEqual(hashlib.sha256(body).hexdigest(),entry['sha256'])

    def test_runtime_pin_is_exact_and_excludes_unapproved_optional_native_modules(self):
        root=ROOT/'desktop/vendor/caption-helper-notices'
        inputs=json.loads((root/'python-runtime-input.json').read_text())
        self.assertEqual(inputs['pythonVersion'],'3.14.8')
        self.assertEqual(inputs['observedInstallerComponents']['OpenSSL'],'3.5.9')
        self.assertGreater(len(inputs['expectedNativeInputs']),40)
        for name,value in inputs['expectedNativeInputs'].items():
            self.assertEqual(sorted(value['architectures']),['arm64','x86_64'])
            self.assertRegex(value['sha256'],r'^[0-9a-f]{64}$')
            self.assertNotIn('tkinter',name)
            self.assertNotIn('readline',name)
            self.assertNotIn('curses',name)


if __name__=='__main__':unittest.main()
