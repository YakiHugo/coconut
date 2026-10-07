"""Pure build-contract regressions; do not download or execute helper dependencies."""
import hashlib
import json
from pathlib import Path
import unittest
import tempfile
from scripts.build_caption_helper import expand_macho_path, analysis_record, validated_framework_link, ROOT


class CaptionBuildContracts(unittest.TestCase):
    def test_exact_and_nested_loader_tokens(self):
        native=Path('/private/archive/libssl.3.dylib');executable=Path('/private/dist/coconut-caption')
        self.assertEqual(expand_macho_path('@loader_path',native,executable),native.parent)
        self.assertEqual(expand_macho_path('@loader_path/../lib',native,executable),native.parent/'../lib')
        self.assertEqual(expand_macho_path('@executable_path',native,executable),executable.parent)
        self.assertEqual(expand_macho_path('@executable_path/nested',native,executable),executable.parent/'nested')
        # Common top-level LC_RPATH must locate the sibling libcrypto binary.
        self.assertEqual(expand_macho_path('@loader_path',native,executable)/'libcrypto.3.dylib',Path('/private/archive/libcrypto.3.dylib'))

    def test_macos_analysis_data_symlinks_are_not_opened_as_files(self):
        names={'Python.framework/Versions/3.14/Python',
               'Python.framework/Versions/3.14/Resources/Info.plist'}
        links=[('Python','Python.framework/Versions/3.14/Python'),
               ('Python.framework/Python','Versions/Current/Python'),
               ('Python.framework/Resources','Versions/Current/Resources'),
               ('Python.framework/Versions/Current','3.14')]
        for name,target in links:
            with self.subTest(name=name):
                record=analysis_record(name,target,'SYMLINK',names)
                self.assertEqual(record['target'],target)
                self.assertEqual(record['kind'],'SYMLINK')
                self.assertNotIn('sha256',record)
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'Info.plist';source.write_bytes(b'original framework metadata')
            record=analysis_record('Python.framework/Versions/3.14/Resources/Info.plist',str(source),'DATA',names)
            self.assertEqual(record['sha256'],hashlib.sha256(source.read_bytes()).hexdigest())
        with self.assertRaises(FileNotFoundError):
            analysis_record('ordinary.data','nonexistent-real-file','DATA',names)

    def test_framework_aliases_reject_external_missing_and_unapproved_targets(self):
        names={'Python.framework/Versions/3.14/Python'}
        for name,target in [('Python','/Library/Frameworks/Python.framework/Versions/3.14/Python'),
                            ('Python','../../private-file'),('Other','Python.framework/Versions/3.14/Python'),
                            ('Python.framework/Python','Versions/Current/Other')]:
            with self.subTest(name=name,target=target), self.assertRaises(RuntimeError):
                validated_framework_link(name,target,names)
        with self.assertRaises(RuntimeError):
            validated_framework_link('Python','Python.framework/Versions/3.14/Python',set())

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
