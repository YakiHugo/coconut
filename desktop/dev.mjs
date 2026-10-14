#!/usr/bin/env node
/** Source-only development entry. Never installs dependencies or starts a model. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startBridge} from './server.mjs';
import {createDevelopmentCaptionHelper} from './development-captions.mjs';
import {createCaptionService} from './caption-service.mjs';

export const DEVELOPMENT_TASK_DIRECTORY = fileURLToPath(new URL('../.coconut/dev/tasks', import.meta.url));

export async function startDevelopmentBridge({port = 8080, taskDirectory = DEVELOPMENT_TASK_DIRECTORY, captionPython = process.env.COCONUT_CAPTION_PYTHON, ...options} = {}) {
  if (Number.parseInt(process.versions.node, 10) < 22) throw new Error('Coconut development requires Node.js 22+.');
  let helper=null;
  if(captionPython && !options.captionService){
    try{
      helper=createDevelopmentCaptionHelper({python:captionPython});
      const status=await helper.status();
      options.captionStatus={code:status.ready?'ready':status.code,mode:'development-python'};
      if(status.ready)options.captionService=createCaptionService({helper,readerDirectory:options.readerDirectory,enabledProviders:status.providers});
    }catch(error){options.captionStatus={code:error.code||'CAPTION_UNAVAILABLE',mode:'development-python'};}
  }
  let server;
  try{server=await startBridge({...options, port, taskDirectory});}
  catch(error){await helper?.shutdown();throw error;}
  if(helper){
    const shutdown=server.shutdown.bind(server);
    server.shutdown=callback=>{
      const stopping=helper.shutdown();
      return new Promise((resolve,reject)=>shutdown(error=>void stopping.then(()=>{callback?.(error);error?reject(error):resolve();},failure=>{callback?.(failure);reject(failure);}))).catch(error=>{if(!callback)throw error;});
    };
    server.on('close',()=>void helper.shutdown());
  }
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    // Passive capability read: does not probe authentication or invoke a provider.
    const executor = await fetch(`${origin}/api/v1/executor`).then(response => response.json());
    const captions=await fetch(`${origin}/api/captions/status`).then(response=>response.json());
    return {server, origin, taskDirectory, executor, captions};
  } catch (error) {
    await new Promise(resolve => server.shutdown(resolve));
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error('Usage: npm run dev (fixed development port 8080)');
  const {server, origin, taskDirectory, executor, captions} = await startDevelopmentBridge();
  console.log(`Coconut 开发阅读器：${origin}`);
  console.log(`开发任务目录：${taskDirectory}`);
  console.log(`本机后台任务：${executor.enabled ? '可用；提供商尚未检查' : '不可用；请检查开发任务目录，阅读仍可使用'}`);
  console.log(`字幕获取：${captions.available?'公开 X / YouTube / Bilibili 字幕入口已就绪（能否取得字幕取决于来源访问状态）':`${captions.message}（${captions.code}）`}`);
  console.log('未发起模型请求。reader 修改后刷新页面；desktop 服务修改后 Ctrl+C 再运行 npm run dev。');
  const stop = () => server.shutdown().catch(() => { process.exitCode = 1; });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
