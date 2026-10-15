"""Keep offline extractor/launcher CI dependencies aligned with the source runtime."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class CaptionWorkflowContracts(unittest.TestCase):
    def test_offline_contract_job_installs_exact_source_runtime_and_runs_all_guards(self):
        workflow = (ROOT / '.github/workflows/caption-helper-proof.yml').read_text()
        job = workflow.split('  public-video-extractor-contract:\n', 1)[1]
        install = ('python -m pip install --disable-pip-version-check --no-input '
                   '--require-hashes --only-binary=:all: --no-deps '
                   '-r desktop/development-caption-requirements.txt')
        suite = 'python -m unittest discover -s tests -p test_public_video_caption_guard.py -v'
        self.assertEqual(job.count('run: ' + install), 1)
        self.assertEqual(job.count('run: ' + suite), 1)
        self.assertLess(job.index(install), job.index(suite))
        self.assertNotIn('continue-on-error', job)
        self.assertNotIn('prove_public', job)

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
