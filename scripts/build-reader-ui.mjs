import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {updateReaderAssets} from './reader-assets.mjs';
const check=process.argv.includes('--check');
const license=await readFile('node_modules/react/LICENSE','utf8');
const app=await build({banner:{js:'/*! React, React DOM and Scheduler\n'+license+'*/'},entryPoints:['frontend/app/main.tsx'],bundle:true,format:'iife',platform:'browser',target:['es2022'],minify:true,define:{'process.env.NODE_ENV':'"production"'},outdir:'reader',entryNames:'react-app',write:false});
for(const file of app.outputFiles){const path=file.path;if(check){const saved=await readFile(path);if(!saved.equals(Buffer.from(file.contents)))throw Error('React app bundle is stale. Run npm run build:reader-ui');}else await writeFile(path,file.contents);}
await updateReaderAssets('reader',{check});
