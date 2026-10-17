import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, copyFile, symlink, rm, readdir, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {refresh} from '../scripts/reader-assets.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 10);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'coconut-reader-build-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const dir of ['scripts', 'reader', 'frontend/app']) await mkdir(join(root, dir), {recursive: true});
  for (const script of ['build-reader-ui.mjs', 'reader-assets.mjs', 'reader_assets.py']) {
    await copyFile(resolve('scripts', script), join(root, 'scripts', script));
  }
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  await writeFile(join(root, 'frontend/app/main.tsx'), 'import "./style.css"; console.log("fixture");\n');
  await writeFile(join(root, 'frontend/app/style.css'), 'body { color: red; }\n');
  await writeFile(join(root, 'reader/shared.js'), Buffer.from([0, 255, 128, 10]));
  await writeFile(join(root, 'reader/index.html'), '<script src="shared.js?v=old"></script>\n<script src="react-app.js?v=old"></script>\n<link href="react-app.css">\n');
  return root;
}
function run(root, check = false) {
  return spawnSync(process.execPath, ['scripts/build-reader-ui.mjs', ...(check ? ['--check'] : [])], {cwd: root, encoding: 'utf8'});
}
function success(result) { assert.equal(result.status, 0, result.stderr || result.stdout); }
async function snapshot(root, metadata = false) {
  const entries = await readdir(join(root, 'reader'));
  return Promise.all(entries.sort().map(async name => {
    const path = join(root, 'reader', name);
    return [name, (await readFile(path)).toString('base64'), ...(metadata ? [(await stat(path)).mtimeMs] : [])];
  }));
}

test('one build refreshes every token with Python-compatible digests and checks without writes', async t => {
  const root = await fixture(t);
  success(run(root));
  const html = await readFile(join(root, 'reader/index.html'), 'utf8');
  for (const name of ['shared.js', 'react-app.js', 'react-app.css']) {
    assert.ok(html.includes(`${name}?v=${digest(await readFile(join(root, 'reader', name)))}`));
  }
  const before = await snapshot(root);
  const beforeCheck = await snapshot(root, true);
  success(run(root, true));
  assert.deepEqual(await snapshot(root, true), beforeCheck);
  success(spawnSync('python3', ['scripts/reader_assets.py', '--check'], {cwd: root, encoding: 'utf8'}));
  // The existing Python writer produces exactly the same manifest bytes.
  await writeFile(join(root, 'reader/index.html'), html.replace(/\?v=[a-f0-9]+/g, '?v=old'));
  success(spawnSync('python3', ['scripts/reader_assets.py'], {cwd: root, encoding: 'utf8'}));
  assert.equal(await readFile(join(root, 'reader/index.html'), 'utf8'), html);
  success(run(root));
  assert.deepEqual(await snapshot(root), before);
});

test('check catches stale manifest, stale bundle and missing assets without changing reader files', async t => {
  const root = await fixture(t);
  success(run(root));
  const index = join(root, 'reader/index.html');
  const html = await readFile(index, 'utf8');
  await writeFile(index, html.replace(/\?v=[a-f0-9]+/, '?v=stale'));
  let before = await snapshot(root, true);
  let result = run(root, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Reader asset tokens are stale/);
  assert.deepEqual(await snapshot(root, true), before);
  success(run(root));
  await writeFile(join(root, 'reader/react-app.js'), 'stale bundle');
  before = await snapshot(root, true);
  result = run(root, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /React app bundle is stale/);
  assert.deepEqual(await snapshot(root, true), before);
  success(run(root));
  await rm(join(root, 'reader/shared.js'));
  before = await snapshot(root, true);
  result = run(root, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT.*shared\.js/);
  assert.deepEqual(await snapshot(root, true), before);
  await writeFile(join(root, 'reader/shared.js'), 'restored');
  success(run(root));
  await rm(join(root, 'reader/react-app.css'));
  before = await snapshot(root, true);
  result = run(root, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT.*react-app\.css/);
  assert.deepEqual(await snapshot(root, true), before);
});

test('reference grammar remains compatible with Python, including ignored external URLs', async t => {
  const root = await fixture(t);
  const reader = join(root, 'reader');
  const html = '<script src="shared.js?v=old"></script><a href="shared.js">again</a>' +
    '<script src="https://example.org/external.js"></script><link href="//example.org/style.css">' +
    '<script src="./ignored.js"></script><script src="sub/ignored.js"></script>' +
    '<script src="number1.js"></script><script src="other.js?x=1"></script>' +
    "<script src='single.js'></script>";
  await writeFile(join(reader, 'index.html'), html);
  const expected = await refresh(html, reader);
  success(spawnSync('python3', ['scripts/reader_assets.py'], {cwd: root, encoding: 'utf8'}));
  assert.equal(await readFile(join(reader, 'index.html'), 'utf8'), expected);
  assert.equal(await refresh(expected, reader), expected);
  await assert.rejects(refresh('<script src="missing.js?v=old">', reader), {code: 'ENOENT'});
});
