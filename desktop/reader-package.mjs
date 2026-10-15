/** Read-only build verification; never changes staged or sealed reader resources. */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export async function verifyReaderResources(readerDirectory) {
  // Without this boundary, an app built under desktop/dist inherits desktop's
  // type:module. The same extracted ZIP can then appear healthy elsewhere.
  const manifest=JSON.parse(await readFile(path.join(readerDirectory,'package.json'),'utf8'));
  if(manifest.type!=='commonjs')throw new Error('Packaged reader must declare type:commonjs');
  const {default:Coconut}=await import(pathToFileURL(path.join(readerDirectory,'core.js')).href);
  if(!Coconut || ['parse','vttPayload','createPlaybackIndex','summaryReadiness'].some(name=>typeof Coconut[name]!=='function'))
    throw new Error('Packaged reader CommonJS exports are incomplete');
  // Verify the real page's dependency graph as well as its Node module boundary.
  // A new browser module must never be omitted from the explicit staging list.
  for(const entry of ['index.html']){
  const index=await readFile(path.join(readerDirectory,entry),'utf8');
  const assets=[...index.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)].map(match=>match[1].split('?')[0]);
  if(!assets.length)throw new Error('Packaged reader has no declared assets');
  for(const name of new Set(assets)){
    if(name!==path.basename(name)||!/\.(?:js|css|png)$/.test(name))throw new Error('Unexpected packaged reader asset: '+name);
    const bytes=await readFile(path.join(readerDirectory,name));
    const reference=[...index.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match=>match[1]).find(value=>value.startsWith(name+'?v='));
    if(reference&&reference.split('?v=')[1]!==createHash('sha256').update(bytes).digest('hex').slice(0,10))
      throw new Error('Packaged reader asset bytes do not match page token: '+name);
  }
  }
}
