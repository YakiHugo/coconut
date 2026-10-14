import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {startDevelopmentBridge} from '../desktop/dev.mjs';
import {startBridge} from '../desktop/server.mjs';
import {parseDoctorArgs, readDoctorMetadata, diagnoseDevelopment, formatDoctorReport} from '../desktop/doctor.mjs';

const CLI = fileURLToPath(new URL('../desktop/doctor.mjs', import.meta.url));
const execute = promisify(execFile);
const PRIVATE = '/private/authored-person/source.txt?token=AUTHORED_SECRET';
const bridgeHealth = (capabilities = {}) => ({runtime:'desktop-bridge', local_worker:false, paid_processing:false,
  max_upload_bytes:0, capabilities:{reader:true, persistent_tasks:true, ...capabilities}});
const executor = (patch = {}) => ({protocolVersion:1, executor:{type:'local-node', online:true},
  enabled:true, supportedTaskKinds:['summary'], remoteSubmission:false, ...patch});
const pythonHealth = {local_worker:true, paid_processing:false, max_upload_bytes:200 * 1024 * 1024};

function fakeHTTP(specs) {
  const calls = [], requests = [];
  const request = (options, callback) => {
    calls.push(options);
    const req = new EventEmitter(); requests.push(req);
    req.destroy = () => { req.destroyed = true; };
    req.end = () => queueMicrotask(() => {
      const spec = specs.shift();
      if (spec?.error) return req.emit('error', spec.error);
      if (spec?.hang) return;
      assert.ok(spec, 'No unexpected metadata request');
      const response = Readable.from(spec.chunks || [Buffer.from(spec.body ?? JSON.stringify(spec.data))]);
      response.statusCode = spec.status ?? 200;
      response.headers = {'content-type':'application/json', ...spec.headers};
      callback(response);
    });
    return req;
  };
  return {request, calls, requests};
}

async function inspect(specs, options = {}) {
  const transport = fakeHTTP(specs);
  const report = await diagnoseDevelopment({nodeVersion:'22.0.0', ...options, request:transport.request});
  return {report, text:formatDoctorReport(report), ...transport};
}

async function loopback(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return {server, port:server.address().port};
}

async function cli(args, env = {}) {
  try {
    const result = await execute(process.execPath, [CLI, ...args], {timeout:6000, maxBuffer:64 * 1024, env:{...process.env, ...env}});
    return {...result, code:0};
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return {stdout:error.stdout, stderr:error.stderr, code:error.code};
  }
}

test('arguments allow one explicit loopback port, never URLs, hostnames, zero or coercions', () => {
  assert.deepEqual(parseDoctorArgs([]), {port:8080});
  assert.deepEqual(parseDoctorArgs(['--port', '65535']), {port:65535});
  assert.deepEqual(parseDoctorArgs(['--help']), {help:true});
  for (const args of [['--port'], ['--port', '0'], ['--port', '-1'], ['--port', '65536'], ['--port', '8e3'],
    ['--port', '08080'], ['--port', '8080.0'], ['--port', ' 8080'], ['--port', 'http://127.0.0.1:8080'],
    ['--host', 'localhost'], ['http://example.com'], ['--port', '8080', '--port', '8081'], ['--help', '--port', '8080']]) {
    assert.throws(() => parseDoctorArgs(args), /用法/);
  }
  for (const port of [0, -1, 65536, '8080', NaN]) assert.throws(() => readDoctorMetadata({port, route:'/api/health', deadline:performance.now() + 100}));
  assert.throws(() => readDoctorMetadata({port:8080, route:'/api/language-tools', deadline:performance.now() + 100}));
  assert.throws(() => readDoctorMetadata({port:8080, route:'https://example.com', deadline:performance.now() + 100}));
});

test('healthy bridge exposes only allowlisted booleans and passive metadata, without model or identity claims', async () => {
  const health = bridgeHealth({podcast_import:true, caption_import:false, local_translation:'yes', [PRIVATE]:true});
  const {report, text, calls, requests} = await inspect([{data:{...health, source:PRIVATE}},
    {data:executor({providers:{codex:{availability:PRIVATE}}, taskDirectory:PRIVATE, tasks:[{source:PRIVATE}]})}]);
  assert.equal(report.exitCode, 0);
  assert.equal(report.service, 'desktop-bridge'); assert.equal(report.executor, 'ready');
  assert.equal(report.capabilities.podcast_import, true); assert.equal(report.capabilities.local_translation, null);
  assert.deepEqual(calls.map(call => call.path), ['/api/health', '/api/v1/executor']);
  for (const call of calls) {
    assert.equal(call.hostname, '127.0.0.1'); assert.equal(call.port, 8080); assert.equal(call.method, 'GET');
    assert.equal(call.agent, false); assert.equal(call.maxHeaderSize, 8192);
    assert.deepEqual(call.headers, {Accept:'application/json'});
  }
  assert.ok(requests.every(req => req.destroyed));
  assert.ok(!JSON.stringify(report).includes(PRIVATE)); assert.ok(!text.includes(PRIVATE));
  assert.match(text, /无法区分 dev、start:light 与 app/); assert.match(text, /不代表模型可用/);
});

test('the full Python legacy health signature is online with unsupported summary metadata, never probed as a bridge', async () => {
  const {report, text, calls} = await inspect([{data:pythonHealth}]);
  assert.equal(report.exitCode, 0); assert.equal(report.service, 'python'); assert.equal(report.executor, 'not_supported');
  assert.deepEqual(calls.map(call => call.path), ['/api/health']);
  assert.match(text, /高级 Python 服务在线/); assert.match(text, /不等于服务离线/);
});

test('unknown runtimes, future versions, partial legacy signatures and unrelated JSON are unsupported, never queried further', async () => {
  for (const data of [{local_worker:true}, {...pythonHealth, paid_processing:true}, {...pythonHealth, max_upload_bytes:1},
    {...pythonHealth, runtime:'other-service'}, {...pythonHealth, version:2}, {...bridgeHealth(), protocolVersion:2},
    {...bridgeHealth(), runtime:'future-bridge'}, {...bridgeHealth(), local_worker:true}, {source:PRIVATE}]) {
    const {report, text, calls} = await inspect([{data}]);
    assert.equal(report.service, 'unsupported'); assert.equal(report.exitCode, 1); assert.equal(calls.length, 1);
    assert.match(text, /端口已响应/); assert.ok(!text.includes(PRIVATE));
  }
});

test('disabled storage is distinct from unavailable storage, offline execution and incompatible metadata', async () => {
  const cases = [
    [false, executor({enabled:false}), 'disabled', 0],
    [true, executor({enabled:false}), 'storage_unavailable', 1],
    [false, executor({enabled:false, unavailable:{code:PRIVATE, message:PRIVATE}}), 'storage_unavailable', 1],
    [true, executor({executor:{type:'local-node', online:false}}), 'offline', 1],
    [false, executor(), 'inconsistent', 1],
    [true, executor({protocolVersion:2}), 'unsupported', 1],
    [true, executor({enabled:'true'}), 'unsupported', 1],
    [true, executor({executor:{type:PRIVATE, online:true}}), 'unsupported', 1],
    [true, executor({remoteSubmission:true}), 'unsupported', 1],
    [true, executor({supportedTaskKinds:['other']}), 'unsupported', 1],
  ];
  for (const [persistent_tasks, data, state, exitCode] of cases) {
    const {report, text} = await inspect([{data:bridgeHealth({persistent_tasks})}, {data}]);
    assert.equal(report.executor, state); assert.equal(report.exitCode, exitCode); assert.ok(!text.includes(PRIVATE));
  }
});

test('refusal, wrong ports and transient failures give accurate next steps without autostart or unsupported dev flags', async () => {
  for (const port of [8080, 8081]) {
    const {report, text, calls} = await inspect([{error:Object.assign(new Error(PRIVATE), {code:'ECONNREFUSED'})}], {port});
    assert.equal(report.health, 'not_listening'); assert.equal(report.exitCode, 1); assert.equal(calls.length, 1);
    assert.match(text, /npm run dev/); assert.ok(!text.includes('npm run dev --')); assert.ok(!text.includes(PRIVATE));
    if (port === 8081) assert.match(text, /先运行 npm run doctor 检查 8080/);
  }
  const {report, text} = await inspect([{error:Object.assign(new Error(PRIVATE), {code:'ECONNRESET'})}]);
  assert.equal(report.health, 'connection_error'); assert.match(text, /不能据此判断服务离线/);
});

test('bad JSON, invalid UTF-8, wrong MIME, compression and excessive bodies are bounded and not printed', async () => {
  for (const [spec, kind] of [
    [{body:PRIVATE}, 'invalid_json'], [{data:[]}, 'invalid_json'], [{data:null}, 'invalid_json'],
    [{chunks:[Buffer.from('{"private":"'), Buffer.from([0xff]), Buffer.from('"}')]}, 'invalid_json'],
    [{data:bridgeHealth(), headers:{'content-type':'text/html'}}, 'invalid_format'],
    [{data:bridgeHealth(), headers:{'content-encoding':'gzip'}}, 'invalid_format'],
    [{body:PRIVATE, headers:{'content-length':'16385'}}, 'too_large'],
    [{chunks:[Buffer.alloc(8192), Buffer.alloc(8193)]}, 'too_large'],
  ]) {
    const {report, text, calls} = await inspect([spec]);
    assert.equal(report.health, kind); assert.equal(report.exitCode, 1); assert.equal(calls.length, 1); assert.ok(!text.includes(PRIVATE));
  }
});

test('redirects and HTTP errors never print response bodies, locations or authentication headers', async () => {
  for (const status of [301, 302, 307, 308, 401, 403, 404, 500, 503]) {
    const {report, text, calls} = await inspect([{status, body:PRIVATE, headers:{location:PRIVATE, 'www-authenticate':PRIVATE}}]);
    assert.equal(report.health, status < 400 ? 'redirect_rejected' : 'http_error');
    assert.equal(report.exitCode, 1); assert.equal(calls.length, 1); assert.ok(!text.includes(PRIVATE));
  }
  const {report, text} = await inspect([{data:bridgeHealth()}, {status:404, body:PRIVATE}]);
  assert.equal(report.service, 'desktop-bridge'); assert.equal(report.executor, 'metadata_unavailable');
  assert.match(text, /阅读服务仍在线/); assert.ok(!text.includes(PRIVATE));
});

test('Node version reflects the actual runtime requirement independently of a healthy service', async () => {
  for (const nodeVersion of ['20.18.0', '22.0.0', '24.19.0']) {
    const {report, text} = await inspect([{data:pythonHealth}], {nodeVersion});
    assert.equal(report.nodeVersion, nodeVersion); assert.equal(report.exitCode, nodeVersion.startsWith('20') ? 1 : 0);
    assert.match(text, new RegExp(`Node.js ${nodeVersion}`));
  }
});

test('a shared absolute deadline ends stalled headers and does not retry', async () => {
  const {report, calls, requests} = await inspect([{hang:true}], {timeoutMs:20});
  assert.equal(report.health, 'timeout'); assert.equal(calls.length, 1); assert.equal(requests[0].destroyed, true);
  const transport = fakeHTTP([{data:bridgeHealth()}, {hang:true}]);
  const second = await diagnoseDevelopment({request:transport.request, timeoutMs:20});
  assert.equal(second.executorIssue, 'timeout'); assert.equal(second.exitCode, 1);
  let callsAfterDeadline = 0;
  assert.deepEqual(await readDoctorMetadata({port:8080, route:'/api/health', deadline:performance.now() - 1,
    request:() => { callsAfterDeadline++; }}), {kind:'timeout'});
  assert.equal(callsAfterDeadline, 0);
});

test('real development bridge diagnostics are passive and leave its authored task ledger unchanged', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coconut-doctor-'));
  t.after(() => fs.rm(directory, {recursive:true, force:true}));
  let providerCalls = 0;
  const providers = {status:async () => { providerCalls++; throw new Error('No authentication probe'); },
    ask:async () => { providerCalls++; throw new Error('No inference'); }};
  const {server} = await startDevelopmentBridge({port:0, taskDirectory:directory, providers});
  t.after(() => new Promise(resolve => server.shutdown(resolve)));
  const paths = []; server.on('request', req => paths.push([req.method, req.url]));
  const snapshot = async () => Object.fromEntries(await Promise.all((await fs.readdir(directory)).map(async name => [name, await fs.readFile(path.join(directory, name), 'utf8')])));
  const before = await snapshot();
  const report = await diagnoseDevelopment({port:server.address().port});
  assert.equal(report.exitCode, 0); assert.equal(report.executor, 'ready');
  assert.equal(providerCalls, 0); assert.deepEqual(await snapshot(), before);
  assert.deepEqual(paths, [['GET', '/api/health'], ['GET', '/api/v1/executor']]);
});

test('real bridge storage failure is actionable without echoing or modifying authored corrupt data', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coconut-doctor-broken-'));
  t.after(() => fs.rm(directory, {recursive:true, force:true}));
  await fs.writeFile(path.join(directory, 'tasks.json'), PRIVATE);
  const server = await startBridge({port:0, taskDirectory:directory, providers:{}});
  t.after(() => new Promise(resolve => server.shutdown(resolve)));
  const report = await diagnoseDevelopment({port:server.address().port});
  assert.equal(report.executor, 'storage_unavailable'); assert.equal(report.exitCode, 1);
  assert.equal(await fs.readFile(path.join(directory, 'tasks.json'), 'utf8'), PRIVATE);
  assert.ok(!formatDoctorReport(report).includes(PRIVATE));
});

test('real HTTP streaming and oversized headers cannot extend or escape the response budget', async t => {
  const {port} = await loopback(t, (_req, res) => {
    res.writeHead(200, {'content-type':'application/json'}); res.write('{');
    const interval = setInterval(() => res.write(' '), 5);
    res.on('close', () => clearInterval(interval));
  });
  const report = await diagnoseDevelopment({port, timeoutMs:50});
  assert.equal(report.health, 'timeout');
  const large = await loopback(t, (_req, res) => { res.writeHead(200, {'x-private':PRIVATE.repeat(300)}); res.end('{}'); });
  assert.equal((await diagnoseDevelopment({port:large.port})).health, 'connection_error');
});

test('real redirects never visit their target and unsupported services get no second request', async t => {
  let redirected = 0;
  const target = await loopback(t, (_req, res) => { redirected++; res.end('unexpected'); });
  const source = await loopback(t, (_req, res) => { res.writeHead(302, {location:`http://127.0.0.1:${target.port}/${PRIVATE}`}); res.end(PRIVATE); });
  assert.equal((await diagnoseDevelopment({port:source.port})).health, 'redirect_rejected'); assert.equal(redirected, 0);
  const seen = [];
  const unknown = await loopback(t, (req, res) => { seen.push(req.url); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({local_worker:true})); });
  assert.equal((await diagnoseDevelopment({port:unknown.port})).service, 'unsupported'); assert.deepEqual(seen, ['/api/health']);
});

test('CLI processes report real Node and honor port/exit status without consulting proxy or private HOME', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'coconut-doctor-cli-'));
  t.after(() => fs.rm(home, {recursive:true, force:true}));
  await fs.writeFile(path.join(home, '.authored-do-not-read'), PRIVATE);
  let proxyCalls = 0;
  const proxy = await loopback(t, (_req, res) => { proxyCalls++; res.writeHead(500); res.end(PRIVATE); });
  const seen = [];
  const python = await loopback(t, (req, res) => {
    seen.push(req.url); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(pythonHealth));
  });
  const proxyURL = `http://127.0.0.1:${proxy.port}`;
  const result = await cli(['--port', String(python.port)], {HOME:home, HTTP_PROXY:proxyURL, http_proxy:proxyURL,
    HTTPS_PROXY:proxyURL, https_proxy:proxyURL, ALL_PROXY:proxyURL, NO_PROXY:'', no_proxy:'', NODE_USE_ENV_PROXY:'1'});
  assert.equal(result.code, 0); assert.match(result.stdout, /高级 Python 服务在线/);
  assert.ok(result.stdout.includes(process.versions.node)); assert.ok(!result.stdout.includes(PRIVATE));
  assert.equal(proxyCalls, 0); assert.deepEqual(seen, ['/api/health']);
  const invalid = await cli(['--port', 'http://example.com']);
  assert.equal(invalid.code, 2); assert.match(invalid.stderr, /用法/); assert.equal(invalid.stdout, '');
  const help = await cli(['--help']); assert.equal(help.code, 0); assert.match(help.stdout, /不扫描/);
  const unknown = await loopback(t, (_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{}'); });
  assert.equal((await cli(['--port', String(unknown.port)])).code, 1);
});
