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


class SourceOnlyWorkflowContracts(unittest.TestCase):
    def test_real_asr_and_weights_require_explicit_manual_boolean_opt_in(self):
        condition = "github.event_name == 'workflow_dispatch' && inputs.run_asr == true"
        asr_jobs = []
        for path in sorted((ROOT / '.github/workflows').glob('*.yml')):
            workflow = yaml.safe_load(path.read_text())
            for name, job in workflow['jobs'].items():
                commands = '\n'.join(step.get('run', '') for step in job.get('steps', []))
                if any(marker in commands for marker in ('live_ingestion_proof.mjs', 'faster-whisper==', 'snapshot_download(')):
                    asr_jobs.append((path.name, name))
                    self.assertEqual(job.get('if'), condition)
                    triggers = workflow.get('on', workflow.get(True))
                    option = triggers['workflow_dispatch']['inputs']['run_asr']
                    self.assertEqual(option['type'], 'boolean')
                    self.assertIs(option['default'], False)
        self.assertEqual(asr_jobs, [('ingestion-public-proof.yml', 'public-local-asr')])
        # Exact condition above admits only a real typed manual consent, not a PR
        # label, string from a request, normal push, or default dispatch.
        for event in ('pull_request', 'push', 'workflow_dispatch'):
            for consent in (None, False, 'true', True):
                allowed = event == 'workflow_dispatch' and consent is True
                self.assertEqual(allowed, (event, consent) == ('workflow_dispatch', True))
        workflow = yaml.safe_load((ROOT / '.github/workflows/ingestion-public-proof.yml').read_text())
        self.assertEqual(workflow['jobs']['source-preflight'].get('if'), condition)

    def test_python_receipt_and_node_package_verify_same_source_inputs(self):
        import ast
        import re
        tree = ast.parse((ROOT / 'scripts/build_caption_helper.py').read_text())
        node = (ROOT / 'desktop/caption-helper-package.mjs').read_text()
        js_names = re.search(r'const names=(\[.*?\]);', node, re.S).group(1)
        expected = ast.literal_eval(js_names)
        arrays = [ast.literal_eval(n.value) for n in ast.walk(tree)
                  if isinstance(n, ast.Assign) and isinstance(n.value, ast.List)
                  and all(isinstance(x, ast.Constant) and isinstance(x.value, str) for x in n.value.elts)]
        self.assertIn(expected, arrays)
        self.assertIn('scripts/owner_video_source.py', expected)

    def test_bilibili_retry_label_never_retries_the_other_restricted_source(self):
        workflow = yaml.safe_load((ROOT / '.github/workflows/source-acceptance.yml').read_text())
        job = workflow['jobs']['source-acquisition']
        expression = job['strategy']['matrix']['include']
        # Parse the literal matrix selected by the scoped label, not an arbitrary
        # condition evaluator. A Bilibili adapter fix must not re-request YouTube.
        import re
        match = re.search(r"github.event.label.name == 'live-source-bilibili' && fromJSON\('([^']+)'\)", expression)
        self.assertIsNotNone(match)
        matrix = json.loads(match.group(1))
        self.assertEqual(matrix, [{'name': 'bilibili', 'url': 'https://www.bilibili.com/video/BV1XNtJ6UEmm', 'language': 'zh'}])

    def test_youtube_only_label_selects_the_independent_yc_interview_once(self):
        import re
        workflow = yaml.safe_load((ROOT / '.github/workflows/source-acceptance.yml').read_text())
        job = workflow['jobs']['source-acquisition']
        expression = job['strategy']['matrix']['include']
        match = re.search(r"github.event.label.name == 'live-source-youtube' && fromJSON\('([^']+)'\)", expression)
        self.assertIsNotNone(match)
        self.assertEqual(json.loads(match.group(1)), [{'name': 'youtube', 'url': 'https://www.youtube.com/watch?v=sJ4VJWycX9M', 'language': 'en'}])
        self.assertNotIn('S6l3aRsecuE', expression, 'Never automatically retry the previously restricted resource')
        self.assertIn("github.event.label.name == 'live-source-youtube'", job['if'])
        commands = '\n'.join(step.get('run', '') for step in job['steps'])
        self.assertNotIn('live_ingestion_proof', commands)
        self.assertNotIn('faster-whisper', commands)
