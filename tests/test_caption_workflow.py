"""Keep offline extractor/launcher CI dependencies aligned with the source runtime."""
import json
from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]


class CaptionWorkflowContracts(unittest.TestCase):
    def test_offline_contract_job_installs_exact_source_runtime_and_runs_all_guards(self):
        workflow = (ROOT / '.github/workflows/caption-helper-proof.yml').read_text()
        job = yaml.safe_load(workflow)['jobs']['public-video-extractor-contract']
        steps = job['steps']
        commands = [step['run'].strip() for step in steps if 'run' in step]
        install = ('python -m pip install --disable-pip-version-check --no-input '
                   '--require-hashes --only-binary=:all: --no-deps '
                   '-r desktop/development-caption-requirements.txt')
        suite = 'python -m unittest discover -s tests -p test_public_video_caption_guard.py -v'
        self.assertEqual(commands.count(install), 1)
        self.assertEqual(commands.count(suite), 1)
        self.assertLess(commands.index(install), commands.index(suite))
        proxy_suite = 'python -m unittest discover -s tests -p test_caption_proxy_transport.py -v'
        self.assertEqual(commands.count(proxy_suite), 1)
        self.assertEqual(commands.count('openssl version'), 1)
        self.assertLess(commands.index('openssl version'), commands.index(proxy_suite))
        self.assertLess(commands.index(install), commands.index(proxy_suite))
        self.assertTrue(all('continue-on-error' not in step for step in steps))
        self.assertFalse(any('prove_public' in command for command in commands))

    def test_regression_installs_parser_before_discovering_tests(self):
        workflow = yaml.safe_load((ROOT / '.github/workflows/test.yml').read_text())
        commands = [step['run'].strip() for step in workflow['jobs']['regression']['steps'] if 'run' in step]
        install = ('python -m pip install --disable-pip-version-check --no-input '
                   '--only-binary=:all: --no-deps PyYAML==6.0.3')
        self.assertEqual(commands.count(install), 1)
        self.assertLess(commands.index(install), commands.index('python -m unittest discover -s tests -v'))

    def test_unquoted_colon_install_regression_is_rejected_by_real_parser(self):
        malformed = 'steps:\n  - run: python -m pip install --only-binary=:all: --no-deps example\n'
        with self.assertRaises(yaml.YAMLError):
            yaml.safe_load(malformed)

    def test_source_runtime_contains_only_hash_locked_extractor_and_tls_roots(self):
        lock = json.loads((ROOT / 'desktop/caption-helper-lock.json').read_text())
        packages = {package['name']: package for package in lock['packages']}
        lines = [line for line in (ROOT / 'desktop/development-caption-requirements.txt').read_text().splitlines()
                 if line and not line.startswith('#')]
        expected = []
        for name in ('yt-dlp', 'certifi'):
            package = packages[name]
            wheels = [file for file in package['files'] if file['filename'].endswith('.whl')]
            self.assertEqual(len(wheels), 1)
            expected.append(name + '==' + package['version'] + ' --hash=sha256:' + wheels[0]['sha256'])
        self.assertEqual(lines, expected)
