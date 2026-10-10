import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {publishDesktopRelease} from '../scripts/publish_desktop_release.mjs';
const sha='a'.repeat(40),repo={owner:'owner',repo:'coconut'},context={eventName:'push',ref:'refs/heads/main',sha,repo};
const core={notice(){},info(){},setOutput(){}};
async function setup(t,{failed=false,head=sha,wrongDigest=false,existing,tag=null,moveMainOnUpload=false,existingAssets=[]}={}){
 const directory=await mkdtemp(path.join(os.tmpdir(),'coconut-release-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 for(const arch of ['arm64','x64'])await writeFile(path.join(directory,`Coconut-0.2.0-${arch}-unsigned.zip`),'synthetic '+arch);
 let currentTag=tag,currentHead=head;
 const calls=[];const release={id:1,draft:true,target_commitish:sha,html_url:'https://example.org/release'};
 const github={rest:{git:{getRef:async()=>{if(!currentTag)throw Object.assign(new Error('no tag'),{status:404});return {data:{object:{type:'commit',sha:currentTag}}};},createRef:async data=>{currentTag=data.sha;return {data:{}};}},actions:{listWorkflowRunsForRepo:async()=>({data:{workflow_runs:['Regression tests','Browser acceptance','Public podcast acceptance'].map(name=>({name,head_sha:sha,status:'completed',conclusion:failed?'failure':'success'}))}})},repos:{getBranch:async()=>({data:{commit:{sha:currentHead}}}),listReleases:async()=>({data:existing?[{tag_name:'v0.2.0',...existing}]:[]}),getReleaseByTag:async()=>{if(existing&&!existing.draft)return {data:existing};throw Object.assign(new Error('missing'),{status:404});},createRelease:async data=>{calls.push(['create',data]);return {data:release};},listReleaseAssets:async()=>({data:existingAssets}),uploadReleaseAsset:async data=>{calls.push(['upload',data.name]);if(moveMainOnUpload)currentHead='b'.repeat(40);return {data:{name:data.name,size:data.data.length,digest:wrongDigest?'sha256:wrong':'sha256:'+createHash('sha256').update(data.data).digest('hex')}};},updateRelease:async data=>{calls.push(['publish',data]);return {data:{...release,draft:false}};}}}};
 return {directory,calls,github};
}
test('release is main-only and publishes only after exact checks and asset digests',async t=>{
 const s=await setup(t);await assert.rejects(()=>publishDesktopRelease({...s,context:{...context,eventName:'pull_request'},core,version:'0.2.0'}),/main push/);assert.equal(s.calls.length,0);
 await publishDesktopRelease({...s,context,core,version:'0.2.0'});assert.equal(s.calls[0][0],'create');assert.equal(s.calls[0][1].draft,true);assert.deepEqual(s.calls.filter(c=>c[0]==='upload').map(c=>c[1]),['Coconut-0.2.0-arm64-unsigned.zip','Coconut-0.2.0-x64-unsigned.zip','SHA256SUMS.txt']);assert.equal(s.calls.at(-1)[0],'publish');
 const body=s.calls[0][1].body;
 for(const phrase of ['per-document IndexedDB storage','multi-file transcript import','cooperative full-library search','playback timing calibration','cross-library notes and excerpts','manual translation creation and review','optional playback-follow','reading appearance controls','Same-document stale writes fail visibly','other edits in that window may also be unable to save','export each unsaved document before refreshing','immutable legacy snapshot','new edits live in IndexedDB','Downgrading to v0.6.0 cannot read those new edits','Do not clear browser storage','not ordinary importable library backups'])assert.ok(body.includes(phrase),'Missing release scope or limitation: '+phrase);
 assert.match(body,/do not require model calls/);assert.match(body,/without Developer ID or notarization/);assert.match(body,/Do not bypass an OS security warning/);
 assert.ok(body.includes(`https://github.com/${repo.owner}/${repo.repo}/blob/${sha}/docs/release-notes.md`));assert.match(body,/No real-account inference quality is claimed/);
});
test('failed checks, moved main and foreign versions never publish',async t=>{
 for(const options of [{failed:true},{head:'b'.repeat(40)},{existing:{id:2,target_commitish:'b'.repeat(40),draft:true}}]){
  const s=await setup(t,options);if(options.head)assert.equal(await publishDesktopRelease({...s,context,core,version:'0.2.0'}),null);else await assert.rejects(()=>publishDesktopRelease({...s,context,core,version:'0.2.0'}));assert.equal(s.calls.length,0);
 }
});
test('mismatched uploaded checksum cannot publish a draft release',async t=>{
 const s=await setup(t,{wrongDigest:true});await assert.rejects(()=>publishDesktopRelease({...s,context,core,version:'0.2.0'}),/checksum/);assert.ok(!s.calls.some(c=>c[0]==='publish'));
});

test('later commits do not overwrite an already published version',async t=>{const s=await setup(t,{existing:{id:2,target_commitish:'b'.repeat(40),draft:false}});assert.equal(await publishDesktopRelease({...s,context,core,version:'0.2.0'}),null);assert.equal(s.calls.length,0);});

test('a foreign existing Git tag cannot receive this build even without a release',async t=>{const s=await setup(t,{tag:'b'.repeat(40)});await assert.rejects(()=>publishDesktopRelease({...s,context,core,version:'0.2.0'}),/tag points/);assert.equal(s.calls.length,0);});
test('main advancing during asset upload leaves the release unpublished',async t=>{const s=await setup(t,{moveMainOnUpload:true});assert.equal(await publishDesktopRelease({...s,context,core,version:'0.2.0'}),null);assert.ok(s.calls.some(c=>c[0]==='upload'));assert.ok(!s.calls.some(c=>c[0]==='publish'));});
test('already published versions are immutable even at the same source commit',async t=>{const s=await setup(t,{existing:{id:2,target_commitish:sha,draft:false}});assert.equal(await publishDesktopRelease({...s,context,core,version:'0.2.0'}),null);assert.equal(s.calls.length,0);});
test('unexpected draft assets cannot be published with the verified build',async t=>{const s=await setup(t,{existing:{id:2,target_commitish:sha,draft:true},existingAssets:[{name:'unreviewed.zip',size:1,digest:'sha256:unknown'}]});await assert.rejects(()=>publishDesktopRelease({...s,context,core,version:'0.2.0'}),/unexpected assets/);assert.equal(s.calls.length,0);});
test('annotated tags are peeled to the actual source commit',async t=>{const s=await setup(t);s.github.rest.git.getRef=async()=>({data:{object:{type:'tag',sha:'c'.repeat(40)}}});s.github.rest.git.getTag=async()=>({data:{object:{type:'commit',sha}}});await publishDesktopRelease({...s,context,core,version:'0.2.0'});assert.equal(s.calls.at(-1)[0],'publish');});

test('a draft omitted by tag lookup resumes via authenticated release listing',async t=>{const s=await setup(t,{existing:{id:9,target_commitish:sha,draft:true}});await publishDesktopRelease({...s,context,core,version:'0.2.0'});assert.ok(!s.calls.some(c=>c[0]==='create'));assert.equal(s.calls.at(-1)[0],'publish');});


test('desktop version, lock metadata and checked-in release notes agree',async()=>{
 const configuration=JSON.parse(await readFile(new URL('../desktop/package.json',import.meta.url),'utf8'));
 const lock=JSON.parse(await readFile(new URL('../desktop/package-lock.json',import.meta.url),'utf8'));
 const notes=await readFile(new URL('../docs/release-notes.md',import.meta.url),'utf8');
 assert.match(configuration.version,/^\d+\.\d+\.\d+$/);assert.equal(lock.version,configuration.version);assert.equal(lock.packages[''].version,configuration.version);
 assert.deepEqual(lock.packages[''].devDependencies,configuration.devDependencies);assert.ok(notes.includes('# Coconut '+configuration.version+' · macOS 开发版'));
 for(const phrase of ['IndexedDB','localStorage','v0.6.0','无法读取新版新增或修改的内容','其他文档修改也可能暂时无法保存','各篇未保存内容','导出未保存文档备份','本窗口所有待保存内容','未提交表单草稿需另行保留','不要为了重试而清空存储','新增的阅读、整理和导出操作不需要调用模型','不能直接当作普通书架备份导入'])assert.ok(notes.includes(phrase),'Missing release-note boundary: '+phrase);
 assert.match(notes,/真实 Codex \/ Claude Code/);assert.match(notes,/Developer ID/);assert.match(notes,/公证/);
});
