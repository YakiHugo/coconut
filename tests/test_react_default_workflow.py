import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class ReactDefaultWorkflowTests(unittest.TestCase):
    def test_native_default_is_the_only_packaged_renderer_journey(self):
        workflow = (ROOT / '.github/workflows/desktop.yml').read_text()
        self.assertIn('run: node tests/desktop-react-packaged-acceptance.mjs', workflow)
        self.assertNotIn('compatibility', workflow)
        self.assertIn('run: node tests/desktop-caption-helper-packaged-proof.mjs --live', workflow)
        self.assertIn('run: node tests/desktop-mac-signature-proof.mjs', workflow)
        block = workflow.split('name: Coconut-React-native-authored', 1)[1].split('if-no-files-found:', 1)[0]
        paths = [line.strip().split('/')[-1] for line in block.splitlines() if '${{ runner.temp }}' in line]
        self.assertEqual(paths, ['react-packaged-report.json', 'react-packaged-home.png', 'react-packaged-reading.png', 'react-packaged-failure.png'])
        self.assertNotIn('*', block)
        source = (ROOT / 'tests/desktop-react-packaged-acceptance.mjs').read_text()
        self.assertNotIn('compatibility.html', source)
        self.assertIn('Actual native quit stops the packaged bridge', source)
