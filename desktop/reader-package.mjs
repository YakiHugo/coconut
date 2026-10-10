/** Read-only build verification; never changes staged or sealed reader resources. */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export async function verifyReaderResources(readerDirectory) {
  // Without this boundary, an app built under desktop/dist inherits desktop's
  // type:module. The same extracted ZIP can then appear healthy elsewhere.
  const manifest=JSON.parse(await readFile(path.join(readerDirectory,'package.json'),'utf8'));
  if(manifest.type!=='commonjs')throw new Error('Packaged reader must declare type:commonjs');
  const {default:Coconut}=await import(pathToFileURL(path.join(readerDirectory,'core.js')).href);
  if(!Coconut || ['parse','vttPayload','createPlaybackIndex','summaryReadiness'].some(name=>typeof Coconut[name]!=='function'))
    throw new Error('Packaged reader CommonJS exports are incomplete');
}
