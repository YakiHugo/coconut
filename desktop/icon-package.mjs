/** Build-time verification; never shipped as renderer or application code. */
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {readAppIconFiles} from '../scripts/generate-app-icons.mjs';

const execute=promisify(execFile);
export const MAC_ICON_FILE='coconut.icns';
export const WINDOW_ICON_FILE='coconut-icon.png';

async function metadataFromPlist(filename){
  const {stdout}=await execute('/usr/bin/plutil',['-convert','json','-o','-',filename]);
  return JSON.parse(stdout);
}

export async function verifyWindowIcon(resources){
  const actual=await readFile(path.join(resources,WINDOW_ICON_FILE)),expected=(await readAppIconFiles()).get(WINDOW_ICON_FILE);
  if(!actual.equals(expected))throw new Error('Packaged window icon does not match original B');
}

export async function verifyMacAppIcon(bundle,{readMetadata=metadataFromPlist}={}){
  const metadata=await readMetadata(path.join(bundle,'Contents/Info.plist'));
  const name=metadata.CFBundleIconFile;
  if(name!==MAC_ICON_FILE)throw new Error('CFBundleIconFile must name '+MAC_ICON_FILE);
  if(metadata.CFBundleIconName)throw new Error('An asset-catalog icon would override the approved ICNS');
  const resources=path.join(bundle,'Contents/Resources');
  const actual=await readFile(path.join(resources,name)),expected=(await readAppIconFiles()).get(MAC_ICON_FILE);
  if(!actual.equals(expected))throw new Error('Packaged macOS icon does not match original B');
  await verifyWindowIcon(resources);
}
