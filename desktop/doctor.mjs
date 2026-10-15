#!/usr/bin/env node
/** Read-only, bounded loopback diagnostics. No app, provider or storage imports. */
import http from 'node:http';
import {captionSetupGuidance,CAPTION_START_GUIDANCE} from './caption-setup-guidance.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const DEFAULT_PORT = 8080;
const DEADLINE_MS = 3000;
const RESPONSE_BYTES = 16 * 1024;
const ROUTES = new Set(['/api/health', '/api/v1/executor']);
const CAPABILITIES = {
  reader:'阅读', local_agents:'本地 AI 接口', subscription_ask:'订阅问答接口',
  subscription_translation:'订阅翻译接口', podcast_import:'公开播客导入',
  caption_import:'内置字幕获取', media_import:'高级媒体处理',
  local_translation:'离线翻译接口', persistent_tasks:'持久后台任务', canonical_library:'统一书架',
};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validPort = port => Number.isInteger(port) && port >= 1 && port <= 65535;
export const USAGE = '用法：npm run doctor [-- --port 8080]（只检查 127.0.0.1 的指定端口；不扫描其他端口）';

export function parseDoctorArgs(args) {
  if (args.length === 1 && args[0] === '--help') return {help:true};
  if (!args.length) return {port:DEFAULT_PORT};
  if (args.length === 2 && args[0] === '--port' && /^[1-9]\d{0,4}$/.test(args[1]) && validPort(Number(args[1]))) return {port:Number(args[1])};
  throw new Error(USAGE);
}

// One fixed IP, two fixed paths, no proxy, credentials, redirects or retries.
// The deadline bounds headers AND the entire body, including a trickling peer.
export function readDoctorMetadata({port, route, deadline, request = http.request}) {
  if (!validPort(port) || !ROUTES.has(route) || !Number.isFinite(deadline)) throw new Error('Invalid diagnostic request');
  return new Promise(resolve => {
    let req, response, timer, settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response?.destroy();
      req?.destroy();
      resolve(result);
    };
    const remaining = deadline - performance.now();
    if (remaining <= 0) return finish({kind:'timeout'});
    timer = setTimeout(() => finish({kind:'timeout'}), remaining);
    try {
      req = request({hostname:'127.0.0.1', port, path:route, method:'GET', agent:false,
        maxHeaderSize:8192, headers:{Accept:'application/json'}}, incoming => {
        response = incoming;
        response.on('error', () => finish({kind:'disconnected'}));
        if (settled) { response.destroy(); return; }
        const status = response.statusCode;
        if (status >= 300 && status < 400) return finish({kind:'redirect_rejected'});
        if (status !== 200) return finish({kind:'http_error', status});
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || '') ||
            (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) return finish({kind:'invalid_format'});
        const length = response.headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > RESPONSE_BYTES)) return finish({kind:'too_large'});
        const chunks = []; let bytes = 0;
        response.on('aborted', () => finish({kind:'disconnected'}));
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > RESPONSE_BYTES) return finish({kind:'too_large'});
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          try {
            const data = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks)));
            finish(record(data) ? {kind:'ok', data} : {kind:'invalid_json'});
          } catch { finish({kind:'invalid_json'}); }
        });
      });
      req.on('error', error => finish({kind:error.code === 'ECONNREFUSED' ? 'not_listening' : 'connection_error'}));
      req.end();
    } catch { finish({kind:'connection_error'}); }
  });
}

function serviceType(health) {
  // Do not silently accept a future version of either health protocol.
  if (Object.hasOwn(health, 'protocolVersion') || Object.hasOwn(health, 'version')) return 'unsupported';
  if (health.runtime === 'desktop-bridge' && health.local_worker === false && health.paid_processing === false &&
      health.max_upload_bytes === 0 && record(health.capabilities) && health.capabilities.reader === true) return 'desktop-bridge';
  // The legacy Python health endpoint has exactly this field combination;
  // local_worker alone is not an identity/capability contract.
  if (!Object.hasOwn(health, 'runtime') && !Object.hasOwn(health, 'capabilities') && health.local_worker === true &&
      health.paid_processing === false && health.max_upload_bytes === 200 * 1024 * 1024) return 'python';
  return 'unsupported';
}

function executorStatus(data, persistentTasks) {
  if (data.protocolVersion !== 1 || !record(data.executor) || data.executor.type !== 'local-node' ||
      typeof data.executor.online !== 'boolean' || typeof data.enabled !== 'boolean' || data.remoteSubmission !== false ||
      !Array.isArray(data.supportedTaskKinds) || !data.supportedTaskKinds.includes('summary')) return 'unsupported';
  if (!data.executor.online) return 'offline';
  if (Object.hasOwn(data, 'unavailable')) return 'storage_unavailable';
  if (data.enabled && persistentTasks === false) return 'inconsistent';
  if (data.enabled) return 'ready';
  return persistentTasks === true ? 'storage_unavailable' : 'disabled';
}

export async function diagnoseDevelopment({port = DEFAULT_PORT, nodeVersion = process.versions.node, timeoutMs = DEADLINE_MS, request = http.request} = {}) {
  if (!validPort(port) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEADLINE_MS) throw new Error('Invalid diagnostic options');
  const nodeSupported = /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(nodeVersion) && Number.parseInt(nodeVersion, 10) >= 22;
  const report = {port, nodeVersion, nodeSupported, service:'unconfirmed', capabilities:{}, executor:'not_checked', exitCode:1};
  const deadline = performance.now() + timeoutMs;
  const health = await readDoctorMetadata({port, route:'/api/health', deadline, request});
  report.health = health.kind;
  if (health.kind !== 'ok') { if (health.kind === 'http_error') report.httpStatus = health.status; return report; }
  report.service = serviceType(health.data);
  if (report.service === 'python') {
    report.executor = 'not_supported';
    report.exitCode = nodeSupported ? 0 : 1;
    return report;
  }
  if (report.service !== 'desktop-bridge') return report;
  for (const key of Object.keys(CAPABILITIES)) {
    const value = health.data.capabilities[key];
    report.capabilities[key] = typeof value === 'boolean' ? value : null;
  }
  const library=health.data.library_storage;
  if(record(library)&&['desktop','development','cli','embedded'].includes(library.mode)&&typeof library.directory==='string'&&library.directory.length<=4096&&!/[\x00-\x1f\x7f]/.test(library.directory))report.library={mode:library.mode,directory:library.directory,enabled:library.enabled===true,code:typeof library.unavailable?.code==='string'&&/^[a-z_]{1,60}$/.test(library.unavailable.code)?library.unavailable.code:null};
  const captions=health.data.caption_sources;
  if(record(captions)&&typeof captions.available==='boolean'&&typeof captions.code==='string')report.captions={available:captions.available,code:/^(?:ready|CAPTION_[A-Z_]{1,60})$/.test(captions.code)?captions.code:'CAPTION_UNKNOWN',providers:Array.isArray(captions.providers)?captions.providers.filter(p=>record(p)&&['x','youtube','bilibili'].includes(p.id)&&typeof p.available==='boolean').map(p=>({id:p.id,label:{x:'X / Twitter',youtube:'YouTube',bilibili:'Bilibili'}[p.id],available:p.available})):[]};
  const executor = await readDoctorMetadata({port, route:'/api/v1/executor', deadline, request});
  report.executor = executor.kind === 'ok' ? executorStatus(executor.data, report.capabilities.persistent_tasks) : 'metadata_unavailable';
  if (executor.kind !== 'ok') report.executorIssue = executor.kind;
  report.exitCode = nodeSupported && ['ready', 'disabled'].includes(report.executor) ? 0 : 1;
  return report;
}

const ISSUES = {
  not_listening:'指定端口未监听；服务可能未启动或使用了其他端口',
  timeout:'诊断超时；不能据此判断服务离线',
  connection_error:'连接未完成；不能据此判断服务离线',
  disconnected:'响应未完整收到；不能据此判断服务离线',
  redirect_rejected:'服务返回重定向；已停止，不跟随跳转',
  invalid_format:'响应不是支持的 JSON metadata',
  invalid_json:'响应 JSON 无效或结构不符',
  too_large:'响应超过 metadata 大小限制',
  http_error:'服务已响应，但 metadata 接口返回 HTTP 错误',
};

export function formatDoctorReport(report) {
  const origin = `http://127.0.0.1:${report.port}`;
  const lines = ['Coconut 只读开发诊断', `Node.js ${report.nodeVersion}：${report.nodeSupported ? '满足 Node.js 22+' : '需要切换到 Node.js 22+'}`,
    `检查地址：${origin}（只检查此端口，不扫描或自动启动）`];
  if (report.health !== 'ok') lines.push(`服务：${ISSUES[report.health]}${report.httpStatus ? `（HTTP ${report.httpStatus}）` : ''}`);
  else if (report.service === 'python') {
    lines.push('服务：高级 Python 服务在线（匹配现有旧版 health 协议）',
      '能力：health 声明本地处理 worker、上传上限 200 MiB、无付费处理；其他能力未报告',
      '后台摘要 metadata：此服务不支持 Node 后台摘要 v1 协议，不等于服务离线');
  } else if (report.service === 'desktop-bridge') {
    lines.push(report.library?'服务：desktop-bridge 在线（入口与统一书架目录见下方；不验证任务目录）':'服务：desktop-bridge 在线（旧版 health 未报告启动入口，也不验证任务目录）');
    lines.push('接口能力：' + Object.entries(CAPABILITIES).map(([key, label]) => `${label}=${report.capabilities[key] === true ? '已声明' : report.capabilities[key] === false ? '未启用' : '未报告'}`).join('；'));
    if(report.library)lines.push(`统一书架：${report.library.mode} · ${report.library.directory} · ${report.library.enabled?'可用，需在书架工具明确确认迁移':`不可用（${report.library.code||'unknown'}），阅读仍可使用`}`,'桌面、开发、轻量 CLI 默认书架目录不同；切换入口不会自动迁移数据。显式 COCONUT_LIBRARY_DIRECTORY 必须为绝对路径。');
    if(report.captions)lines.push(`字幕获取：${report.captions.available?`已启用：${report.captions.providers?.filter(p=>p.available).map(p=>p.label).join(' / ')||'公开字幕'}；平台访问限制仍可能阻止获取`:`未就绪（${report.captions.code}）；${captionSetupGuidance(report.captions.code)}`}`);
    if(report.captions&&!report.captions.available)lines.push(CAPTION_START_GUIDANCE);
    const states = {ready:'就绪（仅 metadata，未读取任务内容）', disabled:'未配置持久任务存储；服务仍在线',
      offline:'执行器报告离线；阅读服务仍在线', storage_unavailable:'任务存储不可用；阅读服务仍在线',
      inconsistent:'health 与 executor 声明不一致', unsupported:'不支持的 executor 协议或字段',
      metadata_unavailable:`无法读取（${ISSUES[report.executorIssue]}）；阅读服务仍在线`};
    lines.push(`后台摘要 metadata：${states[report.executor]}`);
  } else lines.push('服务：端口已响应，但不是已支持的 Coconut health 协议；可能是其他服务或不兼容版本');
  lines.push('提供商安装、登录和额度均未检查；接口能力不代表模型可用。');
  if (!report.nodeSupported) lines.push('下一步：切换到 Node.js 22+，再运行 npm run doctor。');
  if (report.health === 'not_listening' && report.port === DEFAULT_PORT) {
    lines.push('下一步：在仓库根目录另开终端运行 npm run dev，保持运行后再执行 npm run doctor。');
  } else if (report.health === 'not_listening') {
    lines.push('下一步：核对你要检查的服务端口。npm run dev 固定使用 8080；先运行 npm run doctor 检查 8080，再决定是否运行 npm run dev。');
  } else if (report.service === 'desktop-bridge' && report.executor === 'ready') {
    lines.push(`下一步：用开发专用浏览器配置打开 ${origin}；reader 修改后刷新，服务代码修改后再手动重启。`);
  } else if (report.service === 'desktop-bridge' && report.executor === 'storage_unavailable') {
    lines.push('下一步：检查启动终端的任务存储提示，不要删除或覆盖任务数据。确认进行中任务后再决定重启；源码开发命令为 npm run dev。');
  } else if (report.service === 'python' || report.executor === 'disabled') {
    lines.push(`下一步：可继续在 ${origin} 使用该服务。若要源码开发后台摘要，先确认并手动停止占用 8080 的服务，再从仓库根目录运行 npm run dev。`);
  } else {
    lines.push('下一步：核对所选端口的服务与启动终端。不要登录或重试未知接口；若要源码开发，确认 8080 空闲后从仓库根目录运行 npm run dev。');
  }
  lines.push('提示：不同 origin 的浏览器书架彼此独立；同一 8080 地址也可能已有书架，切换前先导出备份。');
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseDoctorArgs(process.argv.slice(2));
    if (options.help) console.log(USAGE);
    else { const report = await diagnoseDevelopment(options); console.log(formatDoctorReport(report)); process.exitCode = report.exitCode; }
  } catch { console.error(USAGE); process.exitCode = 2; }
}
