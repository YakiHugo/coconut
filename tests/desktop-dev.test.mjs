import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEVELOPMENT_TASK_DIRECTORY, startDevelopmentBridge} from '../desktop/dev.mjs';

test('development defaults anchor task data to the repository, independently of cwd and HOME', () => {
  assert.equal(DEVELOPMENT_TASK_DIRECTORY, fileURLToPath(new URL('../.coconut/dev/tasks', import.meta.url)));
});

test('development startup reports passive real capabilities and serves edited assets without restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coconut-dev-'));
  let started;
  t.after(async () => {
    if (started) await new Promise((resolve, reject) => started.shutdown(error => error ? reject(error) : resolve()));
    await fs.rm(directory, {recursive:true, force:true});
  });
  const readerDirectory = path.join(directory, 'reader');
  await fs.cp(new URL('../reader/', import.meta.url), readerDirectory, {recursive:true});
  let calls = 0;
  const providers = {ask:async () => { calls++; throw new Error('Unexpected inference'); }, status:async () => { calls++; throw new Error('Unexpected status probe'); }};
  const {server, origin, executor, taskDirectory} = await startDevelopmentBridge({port:0, libraryDirectory:path.join(directory,'library'), taskDirectory:path.join(directory, 'tasks'), readerDirectory, providers});
  started = server;
  assert.equal(server.address().address, '127.0.0.1');
  assert.equal(executor.enabled, true);
  assert.equal(executor.providers.codex.availability, 'not_checked');
  assert.equal(executor.remoteSubmission, false);
  assert.equal((await fetch(origin + '/')).status, 200);
  assert.deepEqual((await fetch(origin + '/api/v1/tasks').then(response => response.json())).tasks, []);
  const marker = '\n/* authored development reload fixture */\n';
  const before = await fetch(origin + '/react-app.css').then(response => response.text());
  await fs.appendFile(path.join(readerDirectory, 'react-app.css'), marker);
  const response = await fetch(origin + '/react-app.css');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), before + marker);
  assert.equal(calls, 0);
  assert.ok((await fs.stat(path.join(taskDirectory, 'writer.lock'))).isFile());
});

test('development status reports unavailable task storage while the reader still works', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coconut-dev-unavailable-'));
  let started;
  t.after(async () => {
    if (started) await new Promise((resolve, reject) => started.shutdown(error => error ? reject(error) : resolve()));
    await fs.rm(directory, {recursive:true, force:true});
  });
  await fs.writeFile(path.join(directory, 'tasks.json'), 'authored corrupt fixture');
  const {server, origin, executor} = await startDevelopmentBridge({port:0, libraryDirectory:path.join(directory,'library'), taskDirectory:directory});
  started = server;
  assert.equal(executor.enabled, false);
  assert.equal((await fetch(origin + '/')).status, 200);
  assert.equal(await fs.readFile(path.join(directory, 'tasks.json'), 'utf8'), 'authored corrupt fixture');
});
