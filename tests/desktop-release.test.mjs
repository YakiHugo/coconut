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
 for(const phrase of ["Changes since 0.7.8", "Wide library search", "40-document pages", "per-language previous/next hits", "Search sessions are not persisted", "semantic translation quality", "Direct reading-language picker", "Missing or stale translations", "IME state", "AI task target or consent", "do not steal a newer display choice", "Source-only hiding is page-local", "clears old bilingual export opt-ins", "Rewind 10 seconds", "keep paused media paused and playing media playing", "Rewinding exits cue loops and bounded passage previews", "seeking event is acknowledged", "a new external seek still exits the loop", "not sample-accurate", "Version 0.7.6 rejects exact_excerpts v2", "including those inside reading collections", "fail closed for the entire library", "actual 0.7.6 modules", "not downgrade compatibility", "Do not clear storage", "complete library JSON backup", "JSON transcripts remain UTF-8", "universal font coverage", "U+20000", "New edits remain in IndexedDB", "v0.6.0 cannot read them", "all unsaved documents", "clear unsaved warnings", "already-sent requests cannot be recalled", "does not remember or restore local-media disk access", "reselect local media after reload", "Publication is gated on exact-commit"])assert.ok(body.includes(phrase),'Missing release scope or limitation: '+phrase);
 assert.match(body,/do not require model calls/);assert.match(body,/no Developer ID or notarization/);assert.match(body,/Do not bypass an OS security warning/);
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
 for(const phrase of ['IndexedDB','localStorage','v0.6.0','无法读取新版新增或修改的内容','其他独立文档仍可自动保存','全局未保存警告与关闭保护','导出未保存文档备份','本窗口所有待保存内容','未提交表单草稿需另行保留','不要为了重试而清空存储','这些操作不调用模型','不能直接当作普通书架备份导入'])assert.ok(notes.includes(phrase),'Missing release-note boundary: '+phrase);
 assert.ok(notes.includes('尚未在用户自己的 Mac'));
 assert.match(notes,/真实 Codex \/ Claude Code/);assert.match(notes,/Developer ID/);assert.match(notes,/公证/);
});


test('prior release notes remain byte-identical historical records',async()=>{
 for(const [version,digest] of [['0.7.0','2ec4424bcef49240abcdd009e1fe7d80ad2b4e19d9ae6d803193e101a86d995b'],['0.7.1','c2605dbe061b84462c64f720b620e6db57a7cbb558bc67adf015e3a2bd896ea4'],['0.7.2','22a0d76936b6bc0e0cc7b82eddad1a0fd72037fcc7c2199a2c2d355d8d63b506'],['0.7.3','ee9fcb6f9db134b2bc0cf0f451ee9cd1afe6ad4e9bb2422fcac0882bb0ac0445'],['0.7.4','4baf322d872ddadd1fa2aec95fbb691f5f5653864acc248ce866032757136a3d'],['0.7.5','8c16bfa15b60452be90e2386342fff7b44302ae33435d6cfea13bc545f71b29c'],['0.7.6','fd460ec5aef6f45469447617e6089b9c07278a70c1626a52ef0911a3e65ab930'],['0.7.7','412a12bf4a31118c7af82d16e0eac6d6d655cbd999536684dd49ae97930b7e60'],['0.7.8','3daf269faa3f50a5c09b5dad62020da266c948cd7191dc62b5a6f61d749fcd00']]){
  const bytes=await readFile(new URL('../docs/release-notes-'+version+'.md',import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),digest);
 }
});


test('0.7.9 notes retain three-change scope, recovery and existing v2 refusal boundaries',async()=>{
 const notes=await readFile(new URL('../docs/release-notes.md',import.meta.url),'utf8');
 const compatibility=await readFile(new URL('../docs/bilingual-excerpts.md',import.meta.url),'utf8');
 const readme=await readFile(new URL('../README.md',import.meta.url),'utf8');
 const publisher=await readFile(new URL('../scripts/publish_desktop_release.mjs',import.meta.url),'utf8');
 assert.ok(readme.includes('目标版本为 `0.7.9`'));
 assert.ok(readme.includes('https://github.com/YakiHugo/coconut/releases'));
 for(const phrase of ['升级前','完整书架 JSON','0.7.6','整个书架','不要清数据绕过'])assert.ok(readme.includes(phrase),phrase);
 for(const phrase of ["宽幅书架查找", "每页40篇", "返回书架结果", "搜索会话不写入备份或持久存储", "不保证译文语义正确", "直接选择阅读语言", "阅读显示", "缺失或过期译文明示", "未提交笔记与输入法状态", "不修改 AI 任务目标或发送同意", "不抢回已重新选择的显示语言", "「仅原文」的隐藏选择只在本页", "清除旧的双语导出勾选", "浮动原声栏后退10秒", "暂停时仍暂停，播放时继续播放", "后退退出当前片段循环或有边界的段落回听", "后续新的外部跳转仍会解除循环", "不承诺逐采样精度", "不会记住或恢复本地媒体的磁盘访问权", "刷新后仍须重选媒体", "exact_excerpts v2", "本版沿用它，不新增 schema", "包括成果集中的双语摘录", "legacy／IndexedDB", "拒绝打开整个书架", "实际 0.7.6 模块", "保留原数据", "支持版本可重新打开完整记录", "这不代表降级兼容", "不要为了让旧版打开而清数据", "原始 JSON", "不代表所有字体都能显示", "U+20000", "不构成发布或验证完成凭证"])assert.ok(notes.includes(phrase),phrase);
 for(const phrase of ['0.7.6','拒绝 v2','嵌入成果集','拒绝整个书架','保留原数据'])assert.ok(compatibility.includes(phrase),phrase);
 for(const phrase of ['Changes since 0.7.8','same-profile legacy/IndexedDB startup can fail closed','This is not downgrade compatibility','No database or library-backup protocol migration','this release adds no schema'])assert.ok(publisher.includes(phrase),phrase);
 assert.ok(notes.includes('已交付的 v0.7.8'));
 assert.ok(notes.includes('release-notes-0.7.8.md'));
 assert.ok(notes.includes('release-notes-0.7.7.md'));
 assert.ok(notes.includes('release-notes-0.7.6.md'));
 assert.ok(notes.includes('本文不表示构建、验收或发布已完成'));
});
