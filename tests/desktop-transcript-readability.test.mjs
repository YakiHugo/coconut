import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCaptionReadability} from '../desktop/transcript-readability.mjs';

test('offline caption worker preserves input, bounds failures, and cancels its real subprocess',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'coconut-punctuation-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const python=path.join(directory,'authored-worker'),model=path.join(directory,'model.onnx');
 const original={segments:[{id:'one',start:0,end:2,text:'你好世界'}]};
 const worker=async body=>writeFile(python,`#!${process.execPath}\n${body}`,{mode:0o700});
 await worker("let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{const d=JSON.parse(raw);d.segments[0].text+='。';process.stdout.write(JSON.stringify(d));});");
 const enhance=createCaptionReadability({python,model});
 const result=await enhance(original);
 assert.equal(result.segments[0].text,'你好世界。');assert.equal(original.segments[0].text,'你好世界');
 assert.equal(createCaptionReadability({python:null,model:null}),null);
 assert.throws(()=>createCaptionReadability({python:'relative',model}));
 await worker('process.stdout.write("invalid JSON");');await assert.rejects(enhance(original),SyntaxError);
 await worker('process.exit(1);');await assert.rejects(enhance(original),/失败/);
 await worker('setInterval(()=>{},1000);');
 await assert.rejects(createCaptionReadability({python,model,timeoutMs:50})(original),/超时/);
 const controller=new AbortController(),pending=enhance(original,{signal:controller.signal});controller.abort();
 await assert.rejects(pending,error=>error.code==='READABILITY_CANCELLED');
 await assert.rejects(enhance(original,{signal:controller.signal}),error=>error.code==='READABILITY_CANCELLED');
});
