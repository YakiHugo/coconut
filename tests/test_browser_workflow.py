"""Guard authored CI suites without launching a browser or changing test outcomes."""

from itertools import product
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / '.github/workflows/browser-acceptance.yml').read_text()
SMOKE = WORKFLOW.split('\n  original-sample:', 1)[0]
# Inspect only direct step fields, not nested environment or artifact configuration.
STEPS = [dict(re.findall(r'^(?:        )?(name|id|run|if|uses): (.+)$', block, re.M))
         for block in re.split(r'^      - ', SMOKE, flags=re.M)[1:]]
GUARD = "${{ !cancelled() && steps.browser_setup.outcome == 'success' }}"
MEDIA_GUARD = ("${{ !cancelled() && steps.browser_setup.outcome == 'success' && "
               "steps.synthetic_fixture.outcome == 'success' }}")
OUTCOMES = ('success', 'failure', 'skipped', 'cancelled', '')


def allows(condition, outcomes, cancelled=False, prior_success=True):
    """Evaluate only our conjunctions, including Actions' implicit success rule.

    An explicit status function overrides the implicit success() requirement:
    https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions
    This is a structural truth-table check, not a replacement for Actions CI.
    """
    terms = condition.removeprefix('${{ ').removesuffix(' }}').split(' && ')
    result = prior_success or '!cancelled()' in terms
    for term in terms:
        if term == '!cancelled()':
            result = result and not cancelled
        else:
            match = re.fullmatch(r"steps\.(\w+)\.outcome == 'success'", term)
            if not match:
                raise AssertionError(f'Unexpected guard term: {term}')
            result = result and outcomes.get(match[1], '') == 'success'
    return result


class BrowserWorkflowTests(unittest.TestCase):
    def test_setup_is_a_success_only_prefix(self):
        setup_index = next(i for i, step in enumerate(STEPS)
                           if step.get('id') == 'browser_setup')
        setup = STEPS[:setup_index + 1]
        self.assertEqual([step.get('uses', step.get('run')) for step in setup], [
            'actions/checkout@v4', 'actions/setup-python@v5', 'actions/setup-node@v4',
            'npm ci --ignore-scripts', 'npx playwright install --with-deps chromium',
            'sudo apt-get update && sudo apt-get install -y ffmpeg fonts-noto-cjk',
        ])
        for step in setup:
            self.assertNotIn('if', step)  # A failed earlier setup skips browser_setup.

    def test_every_authored_browser_suite_has_the_same_guard(self):
        suites = [step for step in STEPS if step.get('run', '').startswith('node tests/')]
        self.assertGreaterEqual(len(suites), 30)
        for step in suites:
            with self.subTest(suite=step['run']):
                self.assertEqual(step.get('if'), GUARD)
                self.assertRegex(step['run'], r'^node tests/[a-z-]+\.mjs$')
        # The newly integrated product suites must each be present exactly once;
        # future direct authored suites are also covered by the guard check above.
        for filename in ('reading-appearance-browser.mjs', 'multi-import-browser.mjs',
                         'large-library-browser.mjs'):
            self.assertTrue((ROOT / 'tests' / filename).is_file())
            self.assertEqual([step['run'] for step in suites].count('node tests/' + filename), 1)

    def test_sibling_failure_does_not_skip_suites_but_setup_and_cancellation_do(self):
        conditions = {step['if'] for step in STEPS
                      if step.get('run', '').startswith('node tests/')}
        for condition, setup, cancelled, prior_success in product(
                conditions, OUTCOMES, (False, True), (False, True)):
            with self.subTest(setup=setup, cancelled=cancelled, prior_success=prior_success):
                self.assertEqual(allows(condition, {'browser_setup': setup},
                                        cancelled, prior_success),
                                 setup == 'success' and not cancelled)

    def test_synthetic_media_requires_its_own_successful_preparation(self):
        prepare = next(step for step in STEPS if step.get('id') == 'synthetic_fixture')
        playback = next(step for step in STEPS if step.get('run') == 'npm run test:browser')
        self.assertEqual(prepare['if'], GUARD)
        self.assertEqual(prepare['run'], 'python scripts/prepare_browser_acceptance.py '
                         '--mode synthetic --directory "$RUNNER_TEMP/coconut-acceptance"')
        self.assertEqual(playback['if'], MEDIA_GUARD)
        self.assertLess(STEPS.index(prepare), STEPS.index(playback))
        for setup, fixture, cancelled, prior_success in product(
                OUTCOMES, OUTCOMES, (False, True), (False, True)):
            with self.subTest(setup=setup, fixture=fixture, cancelled=cancelled):
                outcomes = {'browser_setup': setup, 'synthetic_fixture': fixture}
                self.assertEqual(allows(playback['if'], outcomes, cancelled, prior_success),
                                 setup == fixture == 'success' and not cancelled)

    def test_no_failure_masks_and_existing_probe_and_cleanup_guards_are_preserved(self):
        self.assertNotRegex(WORKFLOW, re.compile(r'^\s*continue-on-error:', re.M))
        probe = next(step for step in STEPS
                     if step.get('run') == 'node scripts/probe_public_captions.mjs')
        self.assertEqual(probe['if'],
                         "github.event_name == 'pull_request' && github.head_ref == 'dot/primary-journey'")
        for name in ('Upload authored UI review images only', 'Remove temporary media and exports'):
            step = next(step for step in STEPS if step.get('name') == name)
            self.assertEqual(step['if'], 'always()')


if __name__ == '__main__':
    unittest.main()
