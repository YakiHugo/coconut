import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,copyFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {buildIconFiles,generateAppIcons,readAppIconFiles,decodeRgbaPng,encodeRgbaPng,downsampleRgba,ICNS_REPRESENTATIONS,ICO_SIZES,ICON_SOURCE} from '../scripts/generate-app-icons.mjs';
import {verifyMacAppIcon,verifyWindowIcon,MAC_ICON_FILE,WINDOW_ICON_FILE} from '../desktop/icon-package.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const execute=promisify(execFile);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const native=await readFile(ICON_SOURCE),outputs=await readAppIconFiles(),master=outputs.get(WINDOW_ICON_FILE);
// Independent golden pixel digests extracted from the previously reviewed
// ICNS, rather than calculated from the candidate resampler during this test.
const approvedPixels={
  16:'c28b78c73f2f16d2d493e147ed1ed094c02d7d232c6c0f3b7301c8135bd054a0',
  32:'ad1f7d3b731d776d38b7507bb66fac9928b781741a811c6b73f4fa26d0473461',
  64:'35e83a0e39759cac43a28186728811bb3ca56e80ea43fab7b67979f72b9a7f35',
  128:'6aeb27007342773557afe50d60db8d9af425dcb38e53cfb70edcb78c08ab18ac',
  256:'65e1cb30a0a7f37d49d5b8dbf50d96a1165525af754f39b5c56088b1f0c28534',
  512:'b40df7b7ad87ef386f891bf626450bf3f4a1e866015c1566ac7cafb28c70a846',
  1024:'b92ce52eec47b5149d44431edc4ed843ce95f02164be5f36e64685fd152ca45c',
};

test('one unchanged original-B source rebuilds the exact approved 1024px RGBA pixels',()=>{
  assert.equal(hash(native),'921df977931a7aba1b24bb98a5d8962489f904cc0076aa25d24b1b3754d7b55f');
  const image=decodeRgbaPng(master);assert.equal(image.width,1024);assert.equal(image.height,1024);
  assert.equal(hash(image.pixels),approvedPixels[1024]);
  assert.equal(image.pixels[3],0,'transparent master border is preserved');
  const changed=Buffer.from(native);changed[100]^=1;
  assert.throws(()=>buildIconFiles(changed),/web crop has changed/);
});

test('RGBA codec round-trips color/transparency and rejects damaged build input',()=>{
  const original={width:2,height:2,pixels:Buffer.from([255,4,8,0,21,56,81,80,0,255,96,180,120,10,0,255])};
  assert.deepEqual(decodeRgbaPng(encodeRgbaPng(original)),original);
  assert.throws(()=>decodeRgbaPng(Buffer.from('not a PNG')),/signature/);
  assert.throws(()=>decodeRgbaPng(master.subarray(0,master.length-4)),/Incomplete PNG/);
  const corrupted=Buffer.from(master);corrupted[100]^=1;
  assert.throws(()=>decodeRgbaPng(corrupted),/checksum/);
});

test('integer area downsampling is alpha-aware and never recrops or invents opaque borders',()=>{
  const source={width:2,height:2,pixels:Buffer.from([255,0,0,255,0,255,0,0,0,0,255,0,255,255,255,0])};
  assert.deepEqual(downsampleRgba(source,1),{width:1,height:1,pixels:Buffer.from([255,0,0,64])});
  assert.deepEqual(downsampleRgba({...source,pixels:Buffer.alloc(16)},1).pixels,Buffer.alloc(4));
  assert.throws(()=>downsampleRgba(source,3),/integer square downscale/);
  assert.throws(()=>downsampleRgba(source,0),/integer square downscale/);
});

test('generated ICNS retains every previously approved resolution and all RGBA pixel values',()=>{
  const bytes=outputs.get(MAC_ICON_FILE);
  assert.equal(bytes.toString('ascii',0,4),'icns');assert.equal(bytes.readUInt32BE(4),bytes.length);
  let offset=8;
  for(const [type,size] of ICNS_REPRESENTATIONS){
    assert.equal(bytes.toString('ascii',offset,offset+4),type);
    const length=bytes.readUInt32BE(offset+4),png=bytes.subarray(offset+8,offset+length),image=decodeRgbaPng(png);
    assert.equal(image.width,size);assert.equal(image.height,size);
    assert.equal(hash(image.pixels),approvedPixels[size],`${type} matches every approved RGBA channel value`);
    assert.equal(image.pixels[3],0,`${type} keeps the transparent outer border`);
    if(size===1024)assert.deepEqual(png,master);
    offset+=length;
  }
  assert.equal(offset,bytes.length,'all container bytes belong to verified representations');
});

test('Windows ICO is byte-identical to the reviewed icon with valid PNG entries and dimensions',()=>{
  const bytes=outputs.get('coconut.ico');
  assert.equal(hash(bytes),'73681df663ca5098cdb363377b00f61f84b2421bbc1aee61fc9f8604730f35d8');
  assert.equal(bytes.readUInt16LE(0),0);assert.equal(bytes.readUInt16LE(2),1);assert.equal(bytes.readUInt16LE(4),ICO_SIZES.length);
  let offset=6+ICO_SIZES.length*16;
  for(const [index,size] of ICO_SIZES.entries()){
    const i=6+index*16;
    assert.equal(bytes[i]||256,size);assert.equal(bytes[i+1]||256,size);assert.equal(bytes[i+2],0);assert.equal(bytes[i+3],0);
    assert.equal(bytes.readUInt16LE(i+4),1);assert.equal(bytes.readUInt16LE(i+6),32);assert.equal(bytes.readUInt32LE(i+12),offset);
    const length=bytes.readUInt32LE(i+8),image=decodeRgbaPng(bytes.subarray(offset,offset+length));
    assert.equal(image.width,size);assert.equal(image.height,size);assert.equal(hash(image.pixels),approvedPixels[size]);offset+=length;
  }
  assert.equal(offset,bytes.length);
});

test('fresh generation is deterministic, check-only cannot repair stale assets, CLI is cwd-independent',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'coconut-icon-build-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await assert.rejects(generateAppIcons({directory,check:true}),{code:'ENOENT'});
  const first=await generateAppIcons({directory}),second=await generateAppIcons({directory,check:true});
  for(const [name,bytes] of first)assert.deepEqual(bytes,second.get(name),name);
  await generateAppIcons({directory,check:true});
  const filename=path.join(directory,MAC_ICON_FILE);await writeFile(filename,'stale');
  await assert.rejects(generateAppIcons({directory,check:true}),/stale/);
  assert.equal(await readFile(filename,'utf8'),'stale','check-only does not rewrite an asset');
  await generateAppIcons({directory});
  const result=await execute(process.execPath,[path.join(ROOT,'scripts/generate-app-icons.mjs'),'--check','--output='+directory],{cwd:os.tmpdir()});
  assert.match(result.stdout,/icons verified/);
});

test('clean source-only checkout generates all files without pre-existing desktop assets',async t=>{
  const checkout=await mkdtemp(path.join(os.tmpdir(),'coconut-icon-checkout-'));t.after(()=>rm(checkout,{recursive:true,force:true}));
  for(const folder of ['reader','scripts'])await mkdir(path.join(checkout,folder));
  await copyFile(ICON_SOURCE,path.join(checkout,'reader/coconut-mark.png'));
  const script=path.join(checkout,'scripts/generate-app-icons.mjs');await copyFile(path.join(ROOT,'scripts/generate-app-icons.mjs'),script);
  await execute(process.execPath,[script],{cwd:os.tmpdir()});
  const directory=path.join(checkout,'desktop/icon-build');
  for(const [name,bytes] of outputs)assert.deepEqual(await readFile(path.join(directory,name)),bytes);
  await execute(process.execPath,[script,'--check'],{cwd:os.tmpdir()});
  await writeFile(path.join(checkout,'reader/coconut-mark.png'),'changed source');
  await assert.rejects(execute(process.execPath,[script]),/web crop has changed/);
});

test('callers cannot poison expected package bytes by changing a returned output buffer',async()=>{
  const first=await readAppIconFiles();first.get(WINDOW_ICON_FILE)[0]^=1;first.delete(MAC_ICON_FILE);
  const fresh=await readAppIconFiles();assert.deepEqual(fresh.get(WINDOW_ICON_FILE),master);assert.deepEqual(fresh.get(MAC_ICON_FILE),outputs.get(MAC_ICON_FILE));
});

async function packageFixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'coconut-icon-bundle-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const bundle=path.join(directory,'Coconut.app'),resources=path.join(bundle,'Contents/Resources');await mkdir(resources,{recursive:true});
  await writeFile(path.join(resources,MAC_ICON_FILE),outputs.get(MAC_ICON_FILE));
  await writeFile(path.join(resources,WINDOW_ICON_FILE),master);
  const readMetadata=async filename=>{assert.equal(filename,path.join(bundle,'Contents/Info.plist'));return {CFBundleIconFile:MAC_ICON_FILE};};
  return {bundle,resources,readMetadata};
}

test('package verification accepts only the intended icon metadata and exact original-B bytes',async t=>{
  const {bundle,resources,readMetadata}=await packageFixture(t);
  await verifyMacAppIcon(bundle,{readMetadata});await verifyWindowIcon(resources);
  for(const name of ['electron.icns','../coconut.icns','','Coconut.icns'])await assert.rejects(verifyMacAppIcon(bundle,{readMetadata:async()=>({CFBundleIconFile:name})}),/CFBundleIconFile/);
  await assert.rejects(verifyMacAppIcon(bundle,{readMetadata:async()=>({CFBundleIconFile:MAC_ICON_FILE,CFBundleIconName:'Electron'})}),/override/);
  await writeFile(path.join(resources,MAC_ICON_FILE),'Electron placeholder');
  await assert.rejects(verifyMacAppIcon(bundle,{readMetadata}),/macOS icon does not match/);
});

test('package verification rejects missing or changed runtime window PNGs',async t=>{
  const {bundle,resources,readMetadata}=await packageFixture(t);
  await writeFile(path.join(resources,WINDOW_ICON_FILE),'different art');
  await assert.rejects(verifyMacAppIcon(bundle,{readMetadata}),/window icon does not match/);
  await rm(path.join(resources,WINDOW_ICON_FILE));await assert.rejects(verifyWindowIcon(resources),{code:'ENOENT'});
});

test('packaging verifies approved icons before final signing and keeps runtime security intact',async()=>{
  const source=await readFile(path.join(ROOT,'desktop/package.mjs'),'utf8');
  const generate=source.indexOf('await generateAppIcons({directory:icons})'),check=source.indexOf('await generateAppIcons({directory:icons,check:true})'),pack=source.indexOf('await packager('),verify=source.indexOf('await verifyMacAppIcon('),sign=source.indexOf('await signDevelopmentBundle(');
  assert.ok(generate>=0&&generate<check&&check<pack&&pack<verify&&verify<sign);
  assert.match(source,/const icons=path\.join\(work,'icons'\)/);
  assert.match(source,/extendInfo:\{CFBundleIconFile:MAC_ICON_FILE\}/);
  assert.match(source,/icon:platform==='darwin'\?path\.join\(icons,MAC_ICON_FILE\)/);
  assert.match(source,/extraResource:\[reader,license,windowIcon\]/);
  assert.match(source,/await verifyWindowIcon\(path\.join\(directory,'resources'\)\)/);
  const main=await readFile(path.join(ROOT,'desktop/main.mjs'),'utf8');
  assert.match(main,/app\.isPackaged\?path\.join\(process\.resourcesPath,'coconut-icon.png'\):path\.join\(readerDirectory,'coconut-mark.png'\)/);
  assert.match(main,/!app\.isPackaged&&process\.platform==='darwin'\)app\.dock\?\.setIcon\(windowIcon\)/);
  assert.match(main,/title:'Coconut',icon:windowIcon/);
  assert.match(main,/nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true/);
  const proof=await readFile(path.join(ROOT,'tests/desktop-mac-signature-proof.mjs'),'utf8');
  assert.match(proof,/await verifyMacAppIcon\(app\)/);assert.match(proof,/_changed_app_icon_rejected/);
  assert.match(await readFile(path.join(ROOT,'desktop/.gitignore'),'utf8'),/^icon-build\/$/m);
});
