import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
const license=await readFile('node_modules/react/LICENSE','utf8');
const result=await build({banner:{js:'/*! React, React DOM and Scheduler\n'+license+'*/'},entryPoints:['frontend/transcript-navigator/main.tsx'],bundle:true,format:'iife',platform:'browser',target:['es2022'],minify:true,legalComments:'eof',define:{'process.env.NODE_ENV':'"production"'},write:false});
const output=result.outputFiles[0].contents,path='reader/transcript-navigator.js';
if(process.argv.includes('--check')){
 const saved=await readFile(path);
 if(!saved.equals(Buffer.from(output)))throw Error('Reader UI bundle is stale. Run npm run build:reader-ui');
}else await writeFile(path,output);
