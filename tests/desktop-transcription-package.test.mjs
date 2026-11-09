/** Validate the packaged worker, not the repository's importable Python files. No model or network calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {TRANSCRIPTION_RESOURCES,stageTranscriptionResources,verifyTranscriptionResources} from '../desktop/transcription-package.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),execute=promisify(execFile);
async function stage(t){const dir=await mkdtemp(path.join(tmpdir(),'coconut-worker-resources-'));t.after(()=>rm(dir,{recursive:true,force:true}));await stageTranscriptionResources(root,dir);return dir;}

test('transcription package contains only its explicit Python source closure',async t=>{
 const dir=await stage(t);
 assert.deepEqual((await readdir(dir)).sort(),[...TRANSCRIPTION_RESOURCES].sort());
 for(const name of TRANSCRIPTION_RESOURCES){assert.match(name,/^[a-z_]+\.py$/);assert.deepEqual(await readFile(path.join(dir,name)),await readFile(path.join(root,name)));}
 const packageSource=await readFile(path.join(root,'desktop/package.mjs'),'utf8');
 assert.match(packageSource,/stageTranscriptionResources\(path\.join\(ROOT,'\.\.'\),resources\)/);
 assert.match(packageSource,/extraResource:.*TRANSCRIPTION_RESOURCES\.map/s);
 assert.match(packageSource,/verifyTranscriptionResources\(path\.dirname\(readerResources\)\)/);
});

test('staged Python source imports are closed over every local dependency, including lazy backends',async t=>{
 const dir=await stage(t);
 // Parse imports without importing third-party packages, reading config, or loading weights.
 const script=`import ast,json,pathlib,sys
root,stage=map(pathlib.Path,sys.argv[1:])
local={p.stem for p in root.glob('*.py')}
missing=[]
for file in stage.glob('*.py'):
 tree=ast.parse(file.read_text(),filename=str(file))
 for node in ast.walk(tree):
  names=[node.module] if isinstance(node,ast.ImportFrom) and node.module else [n.name for n in node.names] if isinstance(node,ast.Import) else []
  for name in names:
   module=name.split('.')[0]
   if module in local and not (stage/(module+'.py')).is_file(): missing.append([file.name,module])
print(json.dumps(missing))`;
 const {stdout}=await execute('python3',['-B','-c',script,root,dir],{timeout:15000});
 assert.deepEqual(JSON.parse(stdout),[]);
 // Negative control: the formerly omitted lazy existing-transcript module is detected.
 await rm(path.join(dir,'existing_alignment.py'));
 const missing=await execute('python3',['-B','-c',script,root,dir],{timeout:15000});
 assert.ok(JSON.parse(missing.stdout).some(([file,module])=>file==='transcription.py'&&module==='existing_alignment'));
});

test('worker modules import from resources without repository cwd or configured model environment',async t=>{
 const dir=await stage(t);
 const script=`import sys
sys.path.insert(0,sys.argv[1])
import transcription,existing_alignment,audio_pipeline,audio_speakers,transcript,transcript_readability,moss_asr,transcribe,local_asr,subtitle_import
assert transcription.__file__.startswith(sys.argv[1])
print('packaged worker source imports passed')`;
 const {stdout}=await execute('python3',['-I','-B','-c',script,dir],{cwd:tmpdir(),timeout:15000});
 assert.match(stdout,/packaged worker source imports passed/);
});

test('missing or empty packaged worker resources fail verification',async t=>{
 const dir=await stage(t);
 await writeFile(path.join(dir,'transcription.py'),'');
 await assert.rejects(verifyTranscriptionResources(dir),/transcription\.py/);
 await rm(path.join(dir,'transcription.py'));
 await assert.rejects(verifyTranscriptionResources(dir),/ENOENT/);
});
