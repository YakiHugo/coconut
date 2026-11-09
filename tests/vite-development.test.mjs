import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {serviceConfig} from '../server/config.mjs';
import {startViteDevelopment} from '../scripts/dev.mjs';

test('Vite serves source and HMR on the authenticated service origin without exposing local files', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'coconut-vite-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const config = serviceConfig({COCONUT_PORT: '0', COCONUT_DATA_DIRECTORY: directory});
  const {server, origin} = await startViteDevelopment({config});
  t.after(() => server.shutdown());
  const response = await fetch(origin);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /\/@vite\/client/);
  assert.match(html, /\/@react-refresh/);
  assert.match(html, /\/frontend\/app\/main.tsx/);
  assert.doesNotMatch(html, /src="react-app.js|href="react-app.css| defer/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self' 'nonce-/);
  const source = await fetch(origin + '/frontend/app/main.tsx').then(r => r.text());
  assert.match(source, /createRoot/);
  // New shared CommonJS helpers must be prebundled for native browser ESM.
  const jobsPanel = await fetch(origin + '/frontend/app/source-jobs-panel.tsx').then(r => r.text());
  assert.match(jobsPanel, /node_modules\/\.vite\/deps\/.*source-alignment/);
  assert.doesNotMatch(jobsPanel, /from ["']\/shared\/source-alignment\.js["']/);
  assert.equal((await fetch(origin + '/@vite/client')).status, 200);
  assert.equal((await fetch(origin + '/core.js')).status, 200);
  const health = await fetch(origin + '/api/health').then(r => r.json());
  assert.equal(health.client.capabilities.libraryWrite, true);
  assert.equal(health.client.capabilities.sourceJobs, true);
  assert.equal((await fetch(origin + '/api/not-a-route')).status, 404);
  assert.doesNotMatch((await fetch(origin + '/api/health')).headers.get('content-security-policy'), /script-src[^;]*unsafe-inline/);
  for (const name of ['.env', '.git/config', '.coconut/dev/library/library.sqlite']) {
    const blocked = await fetch(origin + '/@fs/' + path.resolve(name));
    assert.ok([403, 404].includes(blocked.status), name);
  }
  for (const headers of [{Host: 'attacker.example'}, {Origin: 'https://attacker.example'}]) {
    const status = await new Promise((resolve, reject) => {
      http.get(origin + '/@vite/client', {headers}, res => {res.resume(); resolve(res.statusCode);}).on('error', reject);
    });
    assert.equal(status, 403);
  }
  await server.shutdown();
  // A second instance must reclaim the same library after Vite closes its sockets.
  const restarted = await startViteDevelopment({config});
  await restarted.server.shutdown();
});

test('Vite refuses remote deployment profiles before starting the service', async () => {
  await assert.rejects(startViteDevelopment({config: serviceConfig({COCONUT_HOST:'0.0.0.0', COCONUT_PUBLIC_ORIGIN:'https://reader.example', COCONUT_OWNER_TOKEN:'a'.repeat(64)})}), /loopback/);
});
