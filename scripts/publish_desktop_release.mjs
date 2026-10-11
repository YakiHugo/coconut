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
  body:`Ad-hoc signed macOS development builds for Apple Silicon (arm64) and Intel (x64). The -unsigned.zip suffix is retained for compatibility; there is no trusted Developer ID identity.\n\nSource commit: ${context.sha}\n\nBefore upgrading, export and verify a complete library JSON backup. Keep that untouched file and make a new backup after editing in this version. Bilingual records have used exact_excerpts v2 since 0.7.7; this release adds no schema. Version 0.7.6 rejects exact_excerpts v2 bilingual records, including those inside reading collections: JSON import/restore is refused, and same-profile legacy/IndexedDB startup can fail closed for the entire library. Checks using the actual 0.7.6 modules confirmed refusal preserves stored data for reopening in a supporting reader. This is not downgrade compatibility. Do not clear storage to make an older reader open it.\n\nChanges since 0.7.7:\n- Transcript-first local media association: retain the same transcript, notes and history, then explicitly confirm a candidate when reopening media. Metadata and limited sampled fingerprints are not full-file equality. Media bytes, disk paths and access grants are not stored; reselect the file after reload. Confirming replacement or unlinking clears old timing calibration and listening position while historical source snapshots remain unchanged.\n- Paste timed SRT/VTT, preview actual cues and timing, then open for reading. Input changes require a fresh preview. Untimed prose is refused, clipboard permission is not read, and the UTF-8 input limit is 15 MiB. Save failures retain the page's draft and document for retry or complete JSON rescue; unsubmitted drafts do not survive reload.\n- Bulk literal source correction with per-occurrence selection across preview pages and one latest-batch undo in the current page. Keep initial-source baselines and historical snapshots; stale previews and conflicting undo cannot overwrite later source edits. Save failures support retry and complete JSON rescue.\n- Search current saved translations across all library languages, navigate each language's hits and reveal the exact translated match. Exclude stale translations and unsubmitted drafts, preserve the saved reading bookmark and do not seek or play media. Current provenance does not guarantee semantic translation quality.\n- Displayed-language export fix: explicit TXT and SRT/VTT opt-in includes the actual visible language, including continuous reading's automatically shown language; Markdown reading notes use it too. Language or document changes clear the old opt-in. Hidden or stale translations are not included. Historical bilingual excerpts keep their snapshots; cross-library notes retain each document's saved language setting.\n\nThese operations do not require model calls or automatically play media. Applying or undoing source corrections stops later model batches and rejects late results; already-sent requests cannot be recalled and may consume quota. Sending again requires fresh confirmation. These operations do not upload subtitles or selected local media. JSON transcripts remain UTF-8; full recovery uses JSON, not Markdown or subtitle exports. Preserved characters do not imply universal font coverage, including extended Han glyphs such as U+20000.\n\nNo database or library-backup protocol migration is introduced. New edits remain in IndexedDB, not the old localStorage snapshot; v0.6.0 cannot read them. Backups omit media, account credentials and unsubmitted drafts. If saving fails, export and verify all unsaved documents and retain drafts before closing. Downloads do not acknowledge local persistence or clear unsaved warnings. Closing the paste dialog after a save starts does not cancel that write.\n\n[Release notes, earlier-version limits and verification boundaries](https://github.com/${repo.owner}/${repo.repo}/blob/${context.sha}/docs/release-notes.md)\n\nInstallation and upgrade on the user's own Mac have not been verified. Codex/Claude Code CLI require separate installation and login; AI requests require explicit consent and existing subscription quota. No real-account inference quality is claimed. Desktop publication does not update the Web preview.\n\nDevelopment signatures have no Developer ID or notarization and do not establish Gatekeeper trust. Do not bypass an OS security warning. Publication is gated on exact-commit regression, browser, public-source and native macOS checks, including strict signature/resource verification of the exact ZIPs. Verify the published tag, both ZIPs and SHA256SUMS.txt against the source commit; this text alone is not publication evidence.`})).data;
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
