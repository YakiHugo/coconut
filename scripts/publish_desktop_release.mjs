/** Publish only this main run's verified development desktop artifacts. No credentials are read here. */
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
async function tagCommit(github,repo,tag){
 let object;
 try{object=(await github.rest.git.getRef({...repo,ref:'tags/'+tag})).data.object;}catch(error){if(error.status===404)return null;throw error;}
 for(let depth=0;depth<8;depth++){
  if(object?.type==='commit'&&/^[a-f0-9]{40}$/.test(object.sha))return object.sha;
  if(object?.type!=='tag'||!/^[a-f0-9]{40}$/.test(object.sha))throw new Error('Release tag is not a supported commit reference');
  object=(await github.rest.git.getTag({...repo,tag_sha:object.sha})).data.object;
 }
 throw new Error('Release tag nesting exceeds the verification limit');
}
export async function publishDesktopRelease({github,context,core,directory='release-assets',version,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=()=>Date.now()}){
 if(context.eventName!=='push'||context.ref!=='refs/heads/main'||!/^[a-f0-9]{40}$/.test(context.sha))throw new Error('Releases require an exact main push commit');
 if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Invalid release version');
 const repo=context.repo,required=['Regression tests','Browser acceptance','Public podcast acceptance'];
 const deadline=now()+10*60*1000;
 while(true){
  const {data}=await github.rest.actions.listWorkflowRunsForRepo({...repo,head_sha:context.sha,event:'push',per_page:100});
  const runs=required.map(name=>data.workflow_runs.find(run=>run.name===name&&run.head_sha===context.sha));
  if(runs.some(run=>run?.status==='completed'&&run.conclusion!=='success'))throw new Error('A required exact-commit workflow did not pass');
  if(runs.every(run=>run?.status==='completed'&&run.conclusion==='success'))break;
  if(now()>=deadline)throw new Error('Required main checks are still pending; release was not published');
  await wait(10000);
 }
 const latest=await github.rest.repos.getBranch({...repo,branch:'main'});
 if(latest.data.commit.sha!==context.sha){core.notice('Main advanced; only the newer verified build may publish');return null;}
 const names=['arm64','x64'].map(arch=>`Coconut-${version}-${arch}-unsigned.zip`);
 const entries=await readdir(directory);
 if(entries.length!==2||names.some(name=>!entries.includes(name)))throw new Error('Expected exactly the two current-run desktop ZIPs');
 const assets=[];
 for(const name of names){const bytes=await readFile(path.join(directory,name));if(!bytes.length)throw new Error('Empty build artifact');assets.push({name,bytes,digest:'sha256:'+sha256(bytes)});}
 const sums=assets.map(asset=>asset.digest.slice(7)+'  '+asset.name).join('\n')+'\n';
 const checksum={name:'SHA256SUMS.txt',bytes:Buffer.from(sums),digest:'sha256:'+sha256(Buffer.from(sums))};assets.push(checksum);
 await writeFile(path.join(directory,checksum.name),checksum.bytes);
 const tag='v'+version;
 let release;
 try{release=(await github.rest.repos.getReleaseByTag({...repo,tag})).data;}
 catch(error){if(error.status!==404)throw error;}
 // The tag endpoint can omit unpublished drafts. Authenticated listing is
 // needed to resume a prior upload safely rather than create another draft.
 if(!release){
  const matches=[];
  for(let page=1;page<=10;page++){
   const {data}=await github.rest.repos.listReleases({...repo,per_page:100,page});
   matches.push(...data.filter(item=>item.tag_name===tag));
   if(data.length<100)break;
   if(page===10)throw new Error('Release history exceeds the safe lookup limit; nothing was created');
  }
  if(matches.length>1)throw new Error('Multiple release drafts share this tag; nothing was changed');
  release=matches[0];
 }
 if(release&&!release.draft){core.notice('This version is already published; no published assets were changed');return null;}
 if(release&&release.target_commitish!==context.sha)throw new Error('This draft version belongs to another commit; nothing was overwritten');
 let tagged=await tagCommit(github,repo,tag);
 if(tagged&&tagged!==context.sha)throw new Error('Release tag points to another commit; nothing was published');
 if(!tagged){
  try{await github.rest.git.createRef({...repo,ref:'refs/tags/'+tag,sha:context.sha});}catch(error){if(error.status!==422)throw error;}
  tagged=await tagCommit(github,repo,tag);
  if(tagged!==context.sha)throw new Error('Could not reserve the exact verified release tag');
 }
 if(!release)release=(await github.rest.repos.createRelease({...repo,tag_name:tag,target_commitish:context.sha,name:`Coconut ${version} · ad-hoc developer build`,draft:true,prerelease:true,
  body:`Ad-hoc signed macOS development builds for Apple Silicon (arm64) and Intel (x64). The legacy -unsigned.zip suffix means there is no trusted Developer ID identity.\n\nSource commit: ${context.sha}\n\nReading improvements: faster long-transcript playback, a clearer reading header, source-backed cross-document search, explicit per-document listening resume, recoverable library removal, preserved WebVTT speakers, and unsaved draft protection across navigation. Listening resume never autoplays; removal has one in-page undo slot; drafts remain in memory until saved. Missing or stale translations remain explicit; passage composition never rewrites the source cues.\n\n[Release notes and verification boundaries](https://github.com/${repo.owner}/${repo.repo}/blob/${context.sha}/docs/release-notes.md)\n\nNo user-installed Python is required for reading, public podcast imports or the bundled guarded public-X caption route. The source-built helper includes pinned runtime components and their notices/source materials; it does not download media or run ASR. Codex/Claude Code CLI must already be installed and signed in separately; AI requests require explicit consent and use existing subscription quota. No real-account inference quality is claimed.\n\nThe exact ZIP bundles pass strict code-signature and resource-seal verification. These are development signatures, without Developer ID or notarization, and do not establish Gatekeeper trust. Do not bypass an OS security warning.\n\nAll exact-commit regression, browser, public-source and native macOS build checks passed. SHA256SUMS.txt accompanies the original verified ZIPs.`})).data;
 const existing=(await github.rest.repos.listReleaseAssets({...repo,release_id:release.id,per_page:100})).data;
 if(existing.some(item=>!assets.some(asset=>asset.name===item.name))||new Set(existing.map(item=>item.name)).size!==existing.length)throw new Error('Draft contains unexpected assets; it was not published');
 for(const uploaded of existing){const asset=assets.find(item=>item.name===uploaded.name);if(uploaded.digest!==asset.digest||uploaded.size!==asset.bytes.length)throw new Error('Existing draft asset differs; nothing was overwritten');}
 for(const asset of assets){
  let uploaded=existing.find(item=>item.name===asset.name);
  if(uploaded&&(uploaded.digest!==asset.digest||uploaded.size!==asset.bytes.length))throw new Error('Existing release asset differs; nothing was overwritten');
  if(!uploaded)uploaded=(await github.rest.repos.uploadReleaseAsset({...repo,release_id:release.id,name:asset.name,data:asset.bytes,
   headers:{'content-type':asset.name.endsWith('.zip')?'application/zip':'text/plain','content-length':asset.bytes.length}})).data;
  if(uploaded.digest!==asset.digest||uploaded.size!==asset.bytes.length)throw new Error('Uploaded asset checksum or size could not be verified; release remains draft');
 }
 if((await github.rest.repos.getBranch({...repo,branch:'main'})).data.commit.sha!==context.sha){core.notice('Main advanced during upload; release remains draft');return null;}
 if(await tagCommit(github,repo,tag)!==context.sha)throw new Error('Release tag changed during upload; release remains draft');
 if(release.draft)release=(await github.rest.repos.updateRelease({...repo,release_id:release.id,draft:false,prerelease:true})).data;
 core.setOutput('release_url',release.html_url);core.info('Published verified unsigned developer release: '+release.html_url);
 return release;
}
