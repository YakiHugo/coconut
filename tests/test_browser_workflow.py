import unittest
import re
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / '.github/workflows/browser-acceptance.yml').read_text()

class BrowserWorkflowTests(unittest.TestCase):
    def test_react_job_is_separate_and_uploads_only_authored_allowlist(self):
        job = WORKFLOW.split('\n  react-source-first:', 1)[1]
        self.assertIn('run: npm run test:react-browser', job)
        self.assertIn('run: npm run test:react-matrix', job)
        self.assertEqual(job.count("if: ${{ !cancelled() && steps.react_setup.outcome == 'success' }}"), 3)
        self.assertIn('run: npm run check:reader-ui', job)
        self.assertNotIn('continue-on-error', job)
        paths = re.findall(r'^            \$\{\{ runner.temp \}\}/coconut-react-authored/(.+)$', job, re.M)
        self.assertEqual(paths, ['react-discover-1360.png', 'react-reading-1360.png',
                                'react-discover-390.png', 'react-reading-390.png',
                                'react-discover-320.png', 'react-reading-320.png',
                                'react-geometry.json', 'source-track-retry-1360.png', 'source-track-retry-390.png', 'source-choose-project-1360.png', 'source-choose-project-390.png', 'source-review-transcript-1360.png', 'source-review-transcript-390.png', 'source-feed-refreshed-1360.png', 'source-feed-refreshed-390.png', 'source-feed-refresh-failed-1360.png', 'source-feed-refresh-failed-390.png', 'source-discovery.json', 'caption-partial-review.png', 'caption-continuity.json', 'matrix-canonical-reading-1360.png', 'matrix-canonical-reading-390.png', 'matrix-ai-provider-unavailable-1360.png', 'matrix-ai-provider-unavailable-390.png', 'matrix-ai-provider-ready-1360.png', 'matrix-ai-provider-ready-390.png', 'matrix-ai-error-details-1360.png', 'matrix-ai-error-details-390.png', 'matrix-source-first-home-390.png', 'matrix-source-first-home-1360.png', 'matrix-attached-subtitle-390.png', 'matrix-summary-preferences-1360.png', 'matrix-summary-preferences-390.png', 'matrix-summary-evidence-1360.png', 'matrix-summary-evidence-390.png', 'react-production-matrix.json', 'react-production-matrix-failure.json'])

    def test_only_current_renderer_runs_and_sibling_failure_does_not_mask_checks(self):
        workflow = yaml.safe_load(WORKFLOW)
        self.assertEqual(set(workflow['jobs']), {'react-source-first'})
        job = workflow['jobs']['react-source-first']
        self.assertEqual(job['timeout-minutes'], 15)
        steps = job['steps']
        setup = next(i for i, step in enumerate(steps) if step.get('id') == 'react_setup')
        for step in steps[:setup + 1]:
            self.assertNotIn('if', step)
        suites = [step for step in steps if step.get('run', '').startswith('npm run test:')]
        self.assertEqual([step['run'] for step in suites], [
            'npm run test:react-browser', 'npm run test:react-matrix', 'npm run test:react-palette-browser'])
        for step in suites:
            self.assertEqual(step['if'], "${{ !cancelled() && steps.react_setup.outcome == 'success' }}")
        for step in steps:
            self.assertNotIn('continue-on-error', step)
        self.assertNotIn('compatibility', WORKFLOW)
