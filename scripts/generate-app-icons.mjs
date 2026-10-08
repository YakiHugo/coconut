/** Build-format derivatives of the approved original B. No drawing or dependencies. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {deflateSync,inflateSync,constants} from 'node:zlib';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
export const ICON_DIRECTORY=path.join(ROOT,'desktop/icon-build');
export const ICON_SOURCE=path.join(ROOT,'reader/coconut-mark.png');
export const WEB_ORIGINAL_B_SHA256='921df977931a7aba1b24bb98a5d8962489f904cc0076aa25d24b1b3754d7b55f';
// Raw RGBA SHA-256 values from the independently reviewed original-B icons.
// Pixel identity is independent of lossless PNG encoding/container bytes.
export const APPROVED_PIXEL_SHA256=Object.freeze({
  16:'c28b78c73f2f16d2d493e147ed1ed094c02d7d232c6c0f3b7301c8135bd054a0',
  32:'ad1f7d3b731d776d38b7507bb66fac9928b781741a811c6b73f4fa26d0473461',
  64:'35e83a0e39759cac43a28186728811bb3ca56e80ea43fab7b67979f72b9a7f35',
  128:'6aeb27007342773557afe50d60db8d9af425dcb38e53cfb70edcb78c08ab18ac',
  256:'65e1cb30a0a7f37d49d5b8dbf50d96a1165525af754f39b5c56088b1f0c28534',
  512:'b40df7b7ad87ef386f891bf626450bf3f4a1e866015c1566ac7cafb28c70a846',
  1024:'b92ce52eec47b5149d44431edc4ed843ce95f02164be5f36e64685fd152ca45c',
});
export const ICNS_REPRESENTATIONS=[['icp4',16],['icp5',32],['icp6',64],['ic07',128],['ic08',256],['ic09',512],['ic10',1024],['ic11',32],['ic12',64],['ic13',256],['ic14',512]];
export const ICO_SIZES=[16,32,64,128,256];
const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

function crc32(bytes){
  let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
function pngChunk(type,data){
  const bytes=Buffer.alloc(data.length+12);
  bytes.writeUInt32BE(data.length);bytes.write(type,4,4,'ascii');data.copy(bytes,8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4,-4)),bytes.length-4);return bytes;
}
function paeth(a,b,c){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;}

// A deliberately narrow reader for this checked-in, non-interlaced RGBA master.
// Do not use this build utility as a general-purpose/untrusted image decoder.
export function decodeRgbaPng(bytes){
  if(!bytes.subarray(0,8).equals(PNG_SIGNATURE))throw new Error('Invalid PNG signature');
  let offset=8,width,height,ended=false;const compressed=[];
  while(offset+12<=bytes.length){
    const length=bytes.readUInt32BE(offset),end=offset+length+12;
    if(end>bytes.length)throw new Error('Truncated PNG chunk');
    const type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,end-4);
    if(crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))throw new Error('PNG checksum mismatch');
    if(type==='IHDR'){
      if(offset!==8||length!==13)throw new Error('Invalid PNG header');
      width=data.readUInt32BE(0);height=data.readUInt32BE(4);
      if(!width||!height||width>1024||height>1024||!data.subarray(8).equals(Buffer.from([8,6,0,0,0])))throw new Error('Expected 8-bit non-interlaced RGBA PNG');
    }else if(type==='IDAT'){if(!width)throw new Error('Missing PNG header');compressed.push(data);}
    else if(type==='IEND'){if(length||end!==bytes.length)throw new Error('Invalid PNG ending');ended=true;break;}
    else if(type[0]===type[0].toUpperCase())throw new Error('Unsupported critical PNG chunk');
    offset=end;
  }
  if(!ended||!width||!compressed.length)throw new Error('Incomplete PNG');
  const stride=width*4,raw=inflateSync(Buffer.concat(compressed),{maxOutputLength:height*(stride+1)});
  if(raw.length!==height*(stride+1))throw new Error('Invalid PNG pixels');
  const pixels=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++){
    const filter=raw[y*(stride+1)];if(filter>4)throw new Error('Unsupported PNG filter');
    for(let x=0;x<stride;x++){
      const i=y*stride+x,a=x>=4?pixels[i-4]:0,b=y?pixels[i-stride]:0,c=y&&x>=4?pixels[i-stride-4]:0;
      pixels[i]=(raw[y*(stride+1)+x+1]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter])&255;
    }
  }
  return {width,height,pixels};
}

export function encodeRgbaPng({width,height,pixels}){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>1024||height>1024||pixels.length!==width*height*4)throw new Error('Invalid RGBA image');
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const stride=width*4,raw=Buffer.alloc(height*(stride+1));
  for(let y=0;y<height;y++){
    raw[y*(stride+1)]=1; // Fixed Sub filter, without adaptive/platform choices.
    for(let x=0;x<stride;x++)raw[y*(stride+1)+x+1]=(pixels[y*stride+x]-(x>=4?pixels[y*stride+x-4]:0))&255;
  }
  return Buffer.concat([PNG_SIGNATURE,pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(raw,{level:9,strategy:constants.Z_FIXED})),pngChunk('IEND',Buffer.alloc(0))]);
}

export function downsampleRgba(image,size){
  const {width,height,pixels}=image,scale=width/size;
  if(width!==height||!Number.isInteger(size)||size<1||!Number.isInteger(scale)||scale<1)throw new Error('Expected an integer square downscale');
  const resized=Buffer.alloc(size*size*4);
  // Area averages with premultiplied alpha preserve edges, without pulling
  // hidden RGB from transparent pixels into the visible silhouette.
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    let alpha=0,red=0,green=0,blue=0;
    for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){
      const i=((y*scale+dy)*width+x*scale+dx)*4,a=pixels[i+3];
      alpha+=a;red+=pixels[i]*a;green+=pixels[i+1]*a;blue+=pixels[i+2]*a;
    }
    const i=(y*size+x)*4;
    if(alpha){resized[i]=Math.round(red/alpha);resized[i+1]=Math.round(green/alpha);resized[i+2]=Math.round(blue/alpha);}
    resized[i+3]=Math.round(alpha/(scale*scale));
  }
  return {width:size,height:size,pixels:resized};
}

// Reproduce the prior 396 -> 1024 Pillow Lanczos extraction exactly in RGBA:
// 8-bit premultiplication, separable Lanczos-3, signed 22-bit coefficients,
// rounding/clipping after each axis, then 8-bit unpremultiplication.
// Compatibility references: Pillow 12.3.0 Image.resize, Resample.c, Convert.c.
// This is deliberately restricted to the approved source, not a new art tool.
function originalBMaster(native){
  const {width,height}=native,size=1024,precision=2**22;
  if(width!==396||height!==396)throw new Error('Expected the approved 396px original-B source');
  const sinc=x=>x===0?1:Math.sin(x*Math.PI)/(x*Math.PI);
  const coefficients=Array.from({length:size},(_,index)=>{
    const center=(index+0.5)*width/size,start=Math.max(0,Math.trunc(center-2.5)),end=Math.min(width,Math.trunc(center+3.5));
    const weights=Array.from({length:end-start},(_,k)=>{const d=k+start-center+0.5;return d>=-3&&d<3?sinc(d)*sinc(d/3):0;});
    const sum=weights.reduce((a,b)=>a+b,0);
    return {start,weights:weights.map(weight=>{const scaled=weight/sum*precision;return Math.trunc(scaled+(scaled<0?-0.5:0.5));})};
  });
  const input=Buffer.from(native.pixels),horizontal=Buffer.alloc(size*height*4),pixels=Buffer.alloc(size*size*4);
  for(let i=0;i<input.length;i+=4)for(let c=0;c<3;c++)input[i+c]=Math.round(input[i+c]*input[i+3]/255);
  const clip=value=>Math.max(0,Math.min(255,Math.floor(value/precision)));
  for(let y=0;y<height;y++)for(let x=0;x<size;x++)for(let c=0;c<4;c++){
    const {start,weights}=coefficients[x];let sum=precision/2;
    for(let k=0;k<weights.length;k++)sum+=input[(y*width+start+k)*4+c]*weights[k];
    horizontal[(y*size+x)*4+c]=clip(sum);
  }
  for(let y=0;y<size;y++)for(let x=0;x<size;x++)for(let c=0;c<4;c++){
    const {start,weights}=coefficients[y];let sum=precision/2;
    for(let k=0;k<weights.length;k++)sum+=horizontal[((start+k)*size+x)*4+c]*weights[k];
    pixels[(y*size+x)*4+c]=clip(sum);
  }
  for(let i=0;i<pixels.length;i+=4){const alpha=pixels[i+3];if(alpha&&alpha!==255)for(let c=0;c<3;c++)pixels[i+c]=Math.min(255,Math.trunc(pixels[i+c]*255/alpha));}
  return {width:size,height:size,pixels};
}

function assertApprovedPixels(image){
  if(image.width!==image.height||sha256(image.pixels)!==APPROVED_PIXEL_SHA256[image.width])throw new Error(`Original-B ${image.width}px pixels differ from the approved icon`);
}

export function buildIconFiles(native){
  if(sha256(native)!==WEB_ORIGINAL_B_SHA256)throw new Error('The approved original-B web crop has changed');
  const source=originalBMaster(decodeRgbaPng(native));assertApprovedPixels(source);
  const master=encodeRgbaPng(source);
  const pngs=new Map([[1024,master]]);
  for(const size of new Set(ICNS_REPRESENTATIONS.map(([,size])=>size)))if(!pngs.has(size)){
    const image=downsampleRgba(source,size);assertApprovedPixels(image);pngs.set(size,encodeRgbaPng(image));
  }
  const entries=ICNS_REPRESENTATIONS.map(([type,size])=>{
    const png=pngs.get(size),header=Buffer.alloc(8);header.write(type,0,4,'ascii');header.writeUInt32BE(png.length+8,4);return Buffer.concat([header,png]);
  });
  const icnsHeader=Buffer.alloc(8);icnsHeader.write('icns');icnsHeader.writeUInt32BE(8+entries.reduce((sum,entry)=>sum+entry.length,0),4);
  // PNG-backed ICO entries retain full RGBA. A zero dimension means 256px.
  const icoHeader=Buffer.alloc(6+ICO_SIZES.length*16);icoHeader.writeUInt16LE(1,2);icoHeader.writeUInt16LE(ICO_SIZES.length,4);
  let offset=icoHeader.length;
  for(const [index,size] of ICO_SIZES.entries()){
    const i=6+index*16,png=pngs.get(size);icoHeader[i]=size%256;icoHeader[i+1]=size%256;
    icoHeader.writeUInt16LE(1,i+4);icoHeader.writeUInt16LE(32,i+6);icoHeader.writeUInt32LE(png.length,i+8);icoHeader.writeUInt32LE(offset,i+12);offset+=png.length;
  }
  return new Map([['coconut-icon.png',master],['coconut.icns',Buffer.concat([icnsHeader,...entries])],['coconut.ico',Buffer.concat([icoHeader,...ICO_SIZES.map(size=>pngs.get(size))])]]);
}

let cachedSource,cachedOutputs;
export async function readAppIconFiles(){
  const native=await readFile(ICON_SOURCE);
  if(!cachedSource?.equals(native)){cachedOutputs=buildIconFiles(native);cachedSource=native;}
  // Callers cannot mutate the cached expected bytes used by package verification.
  return new Map([...cachedOutputs].map(([name,bytes])=>[name,Buffer.from(bytes)]));
}

export async function generateAppIcons({check=false,directory=ICON_DIRECTORY}={}){
  const outputs=await readAppIconFiles();
  if(!check)await mkdir(directory,{recursive:true});
  for(const [name,bytes] of outputs){
    const filename=path.join(directory,name);
    if(check){if(!(await readFile(filename)).equals(bytes))throw new Error(`${name} is stale; run node scripts/generate-app-icons.mjs`);}
    else await writeFile(filename,bytes);
  }
  return outputs;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args=process.argv.slice(2),output=args.filter(arg=>arg.startsWith('--output='));
  if(output.length>1||output[0]==='--output='||args.some(arg=>arg!=='--check'&&!arg.startsWith('--output=')))throw new Error('Usage: node scripts/generate-app-icons.mjs [--check] [--output=directory]');
  await generateAppIcons({check:args.includes('--check'),directory:output.length?path.resolve(output[0].slice(9)):ICON_DIRECTORY});
  console.log('Original-B desktop icons '+(process.argv.includes('--check')?'verified':'generated'));
}
