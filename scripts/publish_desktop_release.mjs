/** Publish only this main run's verified, unsigned desktop artifacts. No credentials are read here. */
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
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
 if(release&&release.target_commitish!==context.sha){if(!release.draft){core.notice('This version is already published from another commit; increment the desktop version for a new release');return null;}throw new Error('This draft version belongs to another commit; nothing was overwritten');}
 if(!release)release=(await github.rest.repos.createRelease({...repo,tag_name:tag,target_commitish:context.sha,name:`Coconut ${version} · unsigned developer build`,draft:true,prerelease:true,
  body:`Unsigned macOS development builds for Apple Silicon (arm64) and Intel (x64).\n\nSource commit: ${context.sha}\n\nNo Python is required for reading and public podcast imports. Codex/Claude Code CLI must already be installed and signed in separately; AI requests require explicit consent and use existing subscription quota. No real-account inference quality is claimed.\n\nThese builds are not signed or notarized and have not been tested on the user's Mac. Do not bypass an OS security warning.\n\nAll exact-commit regression, browser, public-source and native macOS build checks passed. SHA256SUMS.txt accompanies the original verified ZIPs.`})).data;
 const existing=(await github.rest.repos.listReleaseAssets({...repo,release_id:release.id,per_page:100})).data;
 for(const asset of assets){
  let uploaded=existing.find(item=>item.name===asset.name);
  if(uploaded&&(uploaded.digest!==asset.digest||uploaded.size!==asset.bytes.length))throw new Error('Existing release asset differs; nothing was overwritten');
  if(!uploaded)uploaded=(await github.rest.repos.uploadReleaseAsset({...repo,release_id:release.id,name:asset.name,data:asset.bytes,
   headers:{'content-type':asset.name.endsWith('.zip')?'application/zip':'text/plain','content-length':asset.bytes.length}})).data;
  if(uploaded.digest!==asset.digest||uploaded.size!==asset.bytes.length)throw new Error('Uploaded asset checksum or size could not be verified; release remains draft');
 }
 if(release.draft)release=(await github.rest.repos.updateRelease({...repo,release_id:release.id,draft:false,prerelease:true})).data;
 core.setOutput('release_url',release.html_url);core.info('Published verified unsigned developer release: '+release.html_url);
 return release;
}
