#!/usr/bin/env node
import {realpath, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer} from 'vite';
import {startService} from '../server/main.mjs';
import {serviceConfig} from '../server/config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Vite and the full service share one loopback listener, origin and library. */
export async function startViteDevelopment({config = serviceConfig(), projectRoot = root, ...options} = {}) {
  if (config.host !== '127.0.0.1' || config.publicOrigin) {
    throw new Error('Vite development requires local loopback access; use pnpm start for a public service.');
  }
  let vite;
  const started = await startService({...options, config, developmentAssets: async (req, res, {pathname, access}) => {
    if (!vite || access.mode !== 'local') return false;
    if (pathname === '/' || pathname === '/index.html') {
      const template = await readFile(path.join(projectRoot, 'reader/index.html'), 'utf8');
      // Blocking domain scripts initialize window.Coconut before the module entry.
      const html = template
        .replace(/<link\b[^>]*href="react-app\.css[^\"]*"[^>]*>/g, '')
        .replace(/<script\b[^>]*src="react-app\.js[^\"]*"[^>]*><\/script>/g, '')
        .replace(/ defer(?=[\s>])/g, '')
        .replace('</body>', '<script type="module" src="/frontend/app/main.tsx"></script></body>');
      // React Refresh injects an inline preamble, only on the development page.
      const nonce = randomBytes(18).toString('base64');
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${nonce}'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://${req.headers.host}; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const transformed = (await vite.transformIndexHtml(req.url, html))
        .replace(/<script\b/g, `<script nonce="${nonce}"`);
      res.end(req.method === 'HEAD' ? undefined : transformed);
      return true;
    }
    // Keep the bridge's allowlisted reader assets and every API on their original paths.
    if (!/^\/(?:@|node_modules\/|frontend\/|reader\/|shared\/)/.test(pathname)) return false;
    await new Promise((resolve, reject) => {
      res.once('finish', resolve);
      res.once('close', resolve);
      vite.middlewares(req, res, error => error ? reject(error) : resolve());
    });
    return res.writableEnded || res.destroyed;
  }});
  try {
    vite = await createServer({root: projectRoot, configFile: path.join(projectRoot, 'vite.config.mjs'),
      server: {ws: {server: started.server}}});
  } catch (error) {
    await started.server.shutdown();
    throw error;
  }
  const serviceShutdown = started.server.shutdown.bind(started.server);
  let stopping;
  started.server.shutdown = callback => {
    stopping ??= vite.close().finally(() => serviceShutdown());
    if (callback) void stopping.then(() => callback(), callback);
    return stopping;
  };
  return {...started, vite};
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error('Usage: pnpm dev (configure COCONUT_PORT in .env).');
  const {server, origin, libraryDirectory} = await startViteDevelopment();
  console.log(`Coconut Vite 开发服务：${origin}`);
  console.log(`书架目录：${libraryDirectory}`);
  console.log('React / CSS 修改会热更新；后端或 .env 修改后 Ctrl+C 再运行 pnpm dev。');
  const stop = () => void server.shutdown().catch(() => { process.exitCode = 1; });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
