#!/usr/bin/env node
/** Source-only development entry. Never installs dependencies or starts a model. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startBridge} from './server.mjs';

export const DEVELOPMENT_TASK_DIRECTORY = fileURLToPath(new URL('../.coconut/dev/tasks', import.meta.url));

export async function startDevelopmentBridge({port = 8080, taskDirectory = DEVELOPMENT_TASK_DIRECTORY, ...options} = {}) {
  if (Number.parseInt(process.versions.node, 10) < 22) throw new Error('Coconut development requires Node.js 22+.');
  const server = await startBridge({...options, port, taskDirectory});
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    // Passive capability read: does not probe authentication or invoke a provider.
    const executor = await fetch(`${origin}/api/v1/executor`).then(response => response.json());
    return {server, origin, taskDirectory, executor};
  } catch (error) {
    await new Promise(resolve => server.shutdown(resolve));
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error('Usage: npm run dev (fixed development port 8080)');
  const {server, origin, taskDirectory, executor} = await startDevelopmentBridge();
  console.log(`Coconut 开发阅读器：${origin}`);
  console.log(`开发任务目录：${taskDirectory}`);
  console.log(`本机后台任务：${executor.enabled ? '可用；提供商尚未检查' : '不可用；请检查开发任务目录，阅读仍可使用'}`);
  console.log('未发起模型请求。reader 修改后刷新页面；desktop 服务修改后 Ctrl+C 再运行 npm run dev。');
  const stop = () => server.shutdown().catch(() => { process.exitCode = 1; });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
