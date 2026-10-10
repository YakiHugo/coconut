"use strict";
// Feed discovery and media acquisition are always explicit clicks, never page-load work.
let podcastReady=false,podcastRequest=null,podcastMediaRequest=null,podcastMediaKey=null,podcastDiscovery=null,podcastPreviewURL=null,podcastPreview=null;
let podcastTargetRows=[];
function podcastMessage(message){$('podcast-status').textContent=message;}
function setPodcastBusy(busy){
 $('discover-podcast').disabled=busy||!podcastReady;$('process-url').disabled=busy;$('cancel-podcast').hidden=!busy;
 for(const button of $('podcast-results').querySelectorAll('button,select'))button.disabled=busy||!podcastReady;
}
async function podcastAPI(action,payload,signal){
 const response=await fetch('api/podcasts/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal});
 if(!response.ok){let message='播客来源暂时不可用';try{message=(await response.json()).error||message;}catch{}throw new Error(message);}
 return response;
}
function episodeDescription(episode){
 const media=episode.media||[],kind=media.some(item=>item.kind==='video')?'视频内容':media.length?'音频内容':'未发现公开媒体';
 const duration=Number.isFinite(episode.duration)&&episode.duration>0?' · '+Coconut.time(episode.duration):'';
 const supported=episode.transcripts?.filter(track=>track.supported).length||0;
 const captions=supported?' · '+supported+' 份可导入的发布者文字稿':episode.transcripts?.length?' · 仅发现不支持的文字稿格式':' · 未发现公开文字稿';
 return kind+duration+captions;
}
function renderPodcastResults(result){
 const host=$('podcast-results');clearPodcastPreview();host.replaceChildren();podcastTargetRows=[];
 if(result.title)host.append(el('h2','',result.title));
 if(result.episode_selection?.status==='matched')host.append(el('p','hint','已匹配分享的这一集，请核对标题后保存或导入。'));
 if(result.episode_selection?.status==='choice_required')host.append(el('p','hint','未能唯一匹配分享单集。下面是节目列表，请先核对标题和来源并手动选择。'));
 if(result.truncated)host.append(el('p','hint podcast-truncation',result.source_type==='xiaoyuzhou_public_page'?'这里只显示公开页面当前提供的部分单集，不是完整节目列表；找不到时请打开原站。':'本次最多列出 200 集，当前列表不是完整节目存档；更早内容请使用发布者的单集页面、分期订阅源或合法字幕文件。'));
 if(result.kind==='choices'){
  host.append(el('p','hint','此页面列出多个公开订阅源，请选择要导入的节目。'));
  for(const feed of result.feeds||[]){
   const url=typeof feed==='string'?feed:feed.url;if(!Coconut.podcastURL(url))continue;
   const button=el('button','',typeof feed==='string'?'查看订阅源':feed.title||'查看订阅源');button.onclick=()=>{ $('podcast-url').value=url;$('podcast-form').requestSubmit();};host.append(button);
  }
 }
 const episodes=result.kind==='media'&&result.media?[{id:'',title:result.title,media:[result.media],transcripts:[],source_url:result.media.url,direct:true}]:(result.episodes||[]);
 const rows=[];
 let applyEpisodeFilters=()=>{};
 if(episodes.length>1){
  const filters=el('form','podcast-filters');filters.setAttribute('aria-label','筛选本次发现的单集');
  const searchLabel=el('label','','查找单集');const search=el('input');search.type='search';search.id='podcast-episode-search';search.placeholder='按本次列表中的标题查找';search.maxLength=200;searchLabel.append(search);
  const trackLabel=el('label','','文字稿');const availability=el('select');availability.id='podcast-episode-availability';
  for(const [value,label] of [['all','全部单集'],['supported','有可导入文字稿']]){const option=el('option','',label);option.value=value;availability.append(option);}trackLabel.append(availability);
  const clear=el('input','podcast-clear');clear.type='reset';clear.value='清除筛选';
  const count=el('p','hint podcast-filter-count');count.id='podcast-episode-count';count.setAttribute('role','status');count.setAttribute('aria-live','polite');
  const empty=el('p','hint podcast-filter-empty','没有匹配的单集。换个标题关键词，或清除筛选查看本次列表。');empty.hidden=true;
  filters.append(searchLabel,trackLabel,clear,count,empty);host.append(filters);
  applyEpisodeFilters=()=>{
   const query=search.value.trim().toLocaleLowerCase();let visible=0;
   for(const {episode,section} of rows){
    const matches=(episode.title||'未命名单集').toLocaleLowerCase().includes(query)&&(availability.value!=='supported'||episode.transcripts?.some(track=>track.supported));
    if(!matches&&!section.hidden)section.querySelectorAll('audio,video').forEach(player=>player.pause());
    section.hidden=!matches;if(matches)visible++;
   }
   count.textContent='本次列表 '+visible+' / '+episodes.length+' 集'+(result.truncated?' · 来源列表不完整':'');
   empty.hidden=visible>0;clear.disabled=!query&&availability.value==='all';
  };
  search.oninput=applyEpisodeFilters;availability.onchange=applyEpisodeFilters;
  filters.onsubmit=event=>event.preventDefault();
  filters.onreset=event=>{event.preventDefault();search.value='';availability.value='all';applyEpisodeFilters();search.focus();};
 }
 for(const episode of episodes){
  const section=el('section','podcast-episode');section.append(el('h3','',episode.title||'未命名单集'),el('p','hint',episodeDescription(episode)));
  let tracks;
  if(episode.transcripts?.some(track=>track.supported)){
   tracks=el('select');tracks.setAttribute('aria-label','选择文字稿版本');const auto=el('option','','按原语言选择');auto.value='';tracks.append(auto);
   for(const track of episode.transcripts.filter(item=>item.supported)){const option=el('option','',(track.language||'未标明语言')+' · '+track.type);option.value=track.url;tracks.append(option);}section.append(tracks);
  }
  const targetChoice=createPodcastTargetChoice(result.feed_url,episode,section);
  if(!episode.direct){const button=el('button','',episode.transcripts?.some(track=>track.supported)?'导入发布者文字稿':'检查本集文字稿');button.onclick=()=>importPodcastEpisode(result.feed_url,episode.id,tracks?.value||undefined,episode,targetChoice);section.append(button);}
  if(episode.media?.length){const listen=el('button','','回听原声（最多200 MiB）');listen.onclick=()=>previewPodcastEpisode(result.feed_url,episode,section);section.append(listen);}
  if(episode.media?.length){const keep=el('button','','保存原声项目');keep.onclick=()=>savePodcastProject(result.feed_url,episode,targetChoice);section.append(keep);}
  const url=Coconut.podcastURL(episode.source_url);
  if(url){const link=el('a','','打开原站');link.href=url;link.target='_blank';link.rel='noopener noreferrer';section.append(link);}
  host.append(section);rows.push({episode,section});
 }
 applyEpisodeFilters();refreshPodcastTargetChoices();
 for(const warning of result.warnings||[])if(typeof warning==='string')host.append(el('p','hint',warning));
 if(!episodes.length&&!result.feeds?.length)host.append(el('p','hint','未发现可导入的单集。可以使用发布者 RSS 或合法取得的字幕、音视频文件。'));
}
$('podcast-form').onsubmit=async event=>{
 event.preventDefault();if(!podcastReady)return;
 podcastRequest?.abort();const controller=new AbortController();podcastRequest=controller;setPodcastBusy(true);podcastMessage('正在读取公开节目资料；尚未下载音视频或发起转录。');
 try{
  const response=await podcastAPI('discover',{url:$('podcast-url').value.trim()},controller.signal),result=await response.json();
  if(controller!==podcastRequest)return;
  podcastDiscovery=result;renderPodcastResults(result);podcastMessage(result.episode_selection?.status==='matched'?'已匹配分享的这一集，请选择保存、导入文字稿或回听。':result.episode_selection?.status==='choice_required'?'未能唯一匹配分享单集，请先核对并手动选择。':'请选择一集。可先保存原声项目；文字稿、回听媒体分别由你点击后获取，不会发起模型请求。');
 }catch(error){if(controller===podcastRequest)podcastMessage(controller.signal.aborted?'已取消读取。':error.message);}
 finally{if(controller===podcastRequest){podcastRequest=null;setPodcastBusy(false);}}
};
$('cancel-podcast').onclick=()=>podcastRequest?.abort();
function podcastProject(feedUrl,episode,transcriptStatus='not_imported'){
 const medium=episode.media?.find(item=>Coconut.podcastURL(item.url)&&['audio','video'].includes(item.kind));
 if(!medium)throw new Error('未发现可保存的公开媒体来源，请打开原站核对。');
 return Coconut.validate({project_kind:'audio_only',transcript_status:transcriptStatus,title:episode.title||'未命名原声项目',language:episode.language||'',source_url:episode.source_url||feedUrl||medium.url,media_duration:episode.duration,
  podcast_source:feedUrl?{feed_url:feedUrl,episode_id:episode.id,media_url:medium.url,media_kind:medium.kind}:{kind:'direct_media',media_url:medium.url,media_kind:medium.kind},segments:[]});
}
function podcastEpisodeSource(feedUrl,episode){
 if(feedUrl)return {podcast_source:{feed_url:feedUrl,episode_id:episode.id}};
 return podcastProject(feedUrl,episode);
}
function podcastTargets(identity){return state.documents.filter(doc=>Coconut.audioProjectIdentity(doc)===identity);}
function createPodcastTargetChoice(feedUrl,episode,section){
 const identity=Coconut.audioProjectIdentity(podcastEpisodeSource(feedUrl,episode));
 const label=el('label','podcast-project-choice','书架项目'),select=el('select');select.setAttribute('aria-label','选择本集的书架项目');label.append(select);
 const hint=el('p','hint');section.append(label,hint);
 const row={identity,select,label,hint,explicit:false};select.onchange=()=>{row.explicit=true;};podcastTargetRows.push(row);return row;
}
function refreshPodcastTargetChoice(row,matches=podcastTargets(row.identity)){
 const prior=row.select.value;
 const options=[['','请选择要继续的版本'],...matches.map(doc=>['project:'+doc.key,(Coconut.isAudioProject(doc)?'补充原声项目：':'打开已有文字稿：')+doc.title+' · '+Coconut.projectAnnotationCount(doc)+' 条项目记录 · '+doc.key.slice(-8)]),['separate','单独导入']];
 const signature=JSON.stringify(options);
 if(row.signature!==signature){
  row.signature=signature;row.select.replaceChildren(...options.map(([value,title])=>{const option=el('option','',title);option.value=value;return option;}));
  row.select.value=row.explicit?(options.some(([value])=>value===prior)?prior:''):matches.length===1?'project:'+matches[0].key:'';
 }
 row.label.hidden=row.hint.hidden=!matches.length;row.select.disabled=!!podcastRequest;
 row.hint.textContent=matches.length>1?'本集有多个书架版本。请明确选择一个，或单独导入；不会覆盖其他版本。':matches.length?'继续同一项目会保留笔记、书签和当前媒体。已有文字稿只会重新打开；要导入另一份文字稿请选择「单独导入」。':'';
}
function resolvePodcastTarget(feedUrl,episode,row){
 const identity=Coconut.audioProjectIdentity(podcastEpisodeSource(feedUrl,episode)),matches=podcastTargets(identity);
 if(row)refreshPodcastTargetChoice(row);
 const choice=row?.select.value;
 if(choice==='separate')return {identity,target:null,separate:true};
 const doc=choice?matches.find(doc=>'project:'+doc.key===choice):!row?.explicit&&matches.length===1?matches[0]:null;
 if(matches.length&&!doc)throw new Error('本集有多个书架版本，请先选择目标项目，或选择「单独导入」');
 if(doc&&!contentIngressAllowed(doc))throw new Error('目标项目正在移除或恢复，请稍候再选择');
 return {identity,target:doc?{key:doc.key,document:doc,source:JSON.stringify(doc.podcast_source)}:null,separate:false};
}
function podcastDiscoveryOwner(controller,resolution){
 const selection=activeSelectionRevision,startingDocument=state.active;
 return ()=>controller===podcastRequest&&!controller.signal.aborted&&contentIngressAllowed()&&workspace==='add'&&state.active===startingDocument&&activeSelectionRevision===selection&&
  (resolution.target?contentIngressAllowed(resolution.target.document)&&state.documents.find(doc=>doc.key===resolution.target.key)===resolution.target.document&&JSON.stringify(resolution.target.document.podcast_source)===resolution.target.source:resolution.separate||podcastTargets(resolution.identity).length===0);
}
async function storePodcastProject(doc,resolution,canCommit,revision){
 return add(doc,canCommit,!!resolution.target,revision,doc.key,{target:resolution.target,separate:resolution.separate});
}
async function savePodcastProject(feedUrl,episode,row){
 if(!podcastReady||podcastRequest)return;
 let resolution;try{resolution=resolvePodcastTarget(feedUrl,episode,row);}catch(error){podcastMessage(error.message);return;}
 const revision=documentLifecycleRevision,controller=new AbortController(),preview=podcastPreview;podcastRequest=controller;setPodcastBusy(true);
 const canCommit=podcastDiscoveryOwner(controller,resolution);
 try{
  const persisted=await storePodcastProject(podcastProject(feedUrl,episode),resolution,canCommit,revision);
  if(controller===podcastRequest&&!controller.signal.aborted&&active()===persisted.identity&&workspace==='read'&&activeSelectionRevision===persisted.selectionRevision&&contentIngressAllowed(persisted.identity)){
   const transferred=transferPodcastPreview(preview,persisted.identity,persisted.mediaRevision);
   notice(persisted.ok?(Coconut.isAudioProject(persisted.identity)?'原声项目已保存在书架。可以写项目笔记和记录时间书签。':'已打开书架中的文字稿项目，已有内容和记录保留。')+(transferred?'已接续本次预览原声，未重复下载；请点击播放。':'尚未获取的媒体仍需单独点击下载。'): '原声项目已在本页打开，但尚未保存，请导出备份。');
  }
 }catch(error){if(controller===podcastRequest)podcastMessage(controller.signal.aborted?'已取消保存，已有书架不变。':error.message);}
 finally{if(controller===podcastRequest){podcastRequest=null;setPodcastBusy(false);refreshPodcastTargetChoices();}}
}
async function importPodcastEpisode(feedUrl,episodeId,transcriptUrl,discoveredEpisode,row){
 if(!podcastReady||podcastRequest)return;
 let resolution;try{resolution=resolvePodcastTarget(feedUrl,discoveredEpisode,row);}catch(error){podcastMessage(error.message);return;}
 const revision=documentLifecycleRevision,controller=new AbortController(),preview=podcastPreview;podcastRequest=controller;setPodcastBusy(true);
 const canCommit=podcastDiscoveryOwner(controller,resolution);
 podcastMessage('正在读取发布者提供的文字稿；不会另行下载音视频。');
 try{
  let persisted;
  if(resolution.target&&!Coconut.isAudioProject(resolution.target.document)){
   // Existing edited words/translation/history are never replaced by rediscovery.
   persisted=await storePodcastProject(resolution.target.document,resolution,canCommit,revision);
  }else{
   const response=await podcastAPI('import',{feedUrl,episodeId,...(transcriptUrl?{transcriptUrl}:{})},controller.signal),result=await response.json();
   if(!canCommit())throw new Error('目标项目或页面已改变，本次未导入文字稿，请重新选择');
   if(result.status!=='ready'||!result.document){
    if(result.status!=='needs_transcription')throw new Error('没有取得有效的文字稿结果，书架未改变，请重试。');
    const episode=result.episode||discoveredEpisode;
    if(episode?.media?.length){
     const project=podcastProject(result.feed_url||feedUrl,episode,'unavailable');
     if(Coconut.audioProjectIdentity(project)!==resolution.identity)throw new Error('返回单集与所选来源不一致，原项目保留。');
     persisted=await storePodcastProject(project,resolution,canCommit,revision);
     if(controller===podcastRequest&&!controller.signal.aborted&&active()===persisted.identity&&workspace==='read'&&activeSelectionRevision===persisted.selectionRevision&&contentIngressAllowed(persisted.identity)){
      transferPodcastPreview(preview,persisted.identity,persisted.mediaRevision);
      notice(persisted.ok?'这集没有可用的公开定时文字稿，已保存原声项目。可写笔记和记录时间书签，未启动识别或模型。':'原声项目已在本页打开，但尚未保存，请导出备份。');
     }
    }
    podcastMessage('这集没有可用的公开定时文字稿。节目简介不会代替原文；当前未启动识别、下载模型或扣费。');return;
   }
   const text=Coconut.validate(result.document);
   if(Coconut.isAudioProject(text))throw new Error('没有取得真正的定时文字稿，原项目保留。');
   if(Coconut.audioProjectIdentity(text)!==resolution.identity)throw new Error('返回文字稿与所选单集来源不一致，原项目保留。');
   persisted=resolution.target?await attachTranscriptToProject(text,resolution.target,{canCommit,activate:true,publisher:true}):await storePodcastProject(text,resolution,canCommit,revision);
  }
  if(controller===podcastRequest&&!controller.signal.aborted&&active()===persisted.identity&&workspace==='read'&&activeSelectionRevision===persisted.selectionRevision&&contentIngressAllowed(persisted.identity)){
   const transferred=transferPodcastPreview(preview,persisted.identity,persisted.mediaRevision);
   podcastMessage(persisted.ok?'文字稿已打开并保存。':'文字稿已在本页打开，尚未保存，请导出备份。');
   notice(persisted.ok?'文字稿项目已打开，原有笔记、书签和当前媒体保留。'+(transferred?'已接续预览原声，未重复下载。':'')+'发布者文字稿尚未经人工核对，未调用模型。':'文字稿已在本页附加，但尚未保存，请立即导出 JSON 备份。');
  }
 }catch(error){if(controller===podcastRequest)podcastMessage(controller.signal.aborted?'已取消导入，已有书架不变。':error.message);}
 finally{if(controller===podcastRequest){podcastRequest=null;setPodcastBusy(false);refreshPodcastTargetChoices();}}
}
function refreshPodcastTargetChoices(){
 if(!podcastTargetRows.length)return;
 // Discovery may contain 200 rows. Resolve library identities once per render,
 // not once for every row while the user is editing a reader note.
 const matches=new Map();
 for(const doc of state.documents){const identity=Coconut.audioProjectIdentity(doc);if(!identity)continue;if(!matches.has(identity))matches.set(identity,[]);matches.get(identity).push(doc);}
 for(const row of podcastTargetRows)refreshPodcastTargetChoice(row,matches.get(row.identity)||[]);
}
window.addEventListener('coconut-render',refreshPodcastTargetChoices);
window.addEventListener('coconut-workspace-change',()=>{podcastRequest?.abort();refreshPodcastTargetChoices();});
function clearPodcastPreview(){
 const preview=podcastPreview;podcastPreview=null;podcastPreviewURL=null;
 if(preview){preview.player.pause();preview.player.remove();URL.revokeObjectURL(preview.url);}
}
function transferPodcastPreview(preview,doc,revision){
 if(!preview||podcastPreview!==preview||mediaSelectionRevision(doc.key)!==revision||!contentIngressAllowed(doc)||Coconut.podcastMediaIdentity(doc)!==preview.mediaIdentity||browserMedia.has(doc.key))return false;
 const time=preview.player.currentTime;
 // Move the sole object-URL owner before rendering. New discovery cleanup can
 // only revoke its own preview, never media already owned by the reader.
 podcastPreview=null;podcastPreviewURL=null;preview.player.pause();preview.player.remove();
 changeMediaSelection(doc.key);
 const attachment={url:preview.url,kind:preview.kind,name:'本集发布者原声',origin:'publisher',identity:preview.identity,mediaIdentity:preview.mediaIdentity};
 browserMedia.set(doc.key,attachment);render();
 const player=$('source-media').querySelector('audio,video');
 const restoreTime=()=>{
  if(active()===doc&&browserMedia.get(doc.key)===attachment&&$('source-media').querySelector('audio,video')===player&&Number.isFinite(time)&&time>0&&Number.isFinite(player.duration)&&time<player.duration){try{player.currentTime=time;}catch{}}
 };
 if(player?.readyState)restoreTime();else player?.addEventListener('loadedmetadata',restoreTime,{once:true});
 return true;
}
async function readPodcastMedia(response){
 const blob=await response.blob();if(blob.size>200*1024*1024)throw new Error('媒体超过 200 MiB 限制');
 const kind=response.headers.get('X-Coconut-Media-Kind');
 if(!['audio','video'].includes(kind)||!blob.size)throw new Error('没有取得可播放的完整音视频');
 const prefix=await blob.slice(0,1024).text();
 if(/(?:mpegurl|scpls|dash\+xml)/i.test(blob.type)||/^\s*(?:#EXTM3U|\[playlist\]|<\?xml|<MPD|<SmoothStreamingMedia|<ASX|<smil)/i.test(prefix))throw new Error('不播放会连接其他远程地址的清单文件');
 return {blob,kind};
}
async function previewPodcastEpisode(feedUrl,episode,section){
 if(!podcastReady||podcastRequest)return;
 const controller=new AbortController(),project=podcastProject(feedUrl,episode),source=project.podcast_source;podcastRequest=controller;setPodcastBusy(true);podcastMessage('正在下载本集公开原声（最多200 MiB）。取消可停止本次获取；不会转录或调用模型。');
 try{
  const response=await podcastAPI('media',feedUrl?{feedUrl:source.feed_url,episodeId:source.episode_id,mediaUrl:source.media_url}:{url:source.media_url},controller.signal);
  const {blob,kind}=await readPodcastMedia(response);
  if(kind!==source.media_kind)throw new Error('下载媒体类型与所选来源不一致，未关联到项目，请重新发现来源。');
  const fingerprint=await fingerprintMedia(blob);
  if(controller.signal.aborted||controller!==podcastRequest||!section.isConnected||workspace!=='add')return;
  clearPodcastPreview();podcastPreviewURL=URL.createObjectURL(blob);
  const player=el(kind,'podcast-preview');player.controls=true;player.preload='metadata';player.src=podcastPreviewURL;player.setAttribute('aria-label','本集公开原声');player.onerror=()=>podcastMessage('浏览器无法播放该媒体。未运行转录，仍可打开原站。');section.append(player);
  podcastPreview={url:podcastPreviewURL,player,kind,identity:fingerprint?'publisher-v1:'+source.media_url+':'+fingerprint:null,mediaIdentity:Coconut.podcastMediaIdentity(project)};
  podcastMessage('原声已在本次页面就绪，尚未运行转录。可以直接播放；需要文字阅读时请导入真正的文字稿。');
 }catch(error){if(controller===podcastRequest)podcastMessage(controller.signal.aborted?'已取消原声下载。':error.message);}
 finally{if(controller===podcastRequest){podcastRequest=null;setPodcastBusy(false);}}
}
function renderPodcastPlayback(){
 const doc=active(),source=doc?.podcast_source;
 $('podcast-playback').hidden=!source?.media_url;
 $('download-podcast-media').disabled=!podcastReady||!!podcastMediaRequest;
 if(!podcastMediaRequest)$('podcast-media-status').textContent=podcastReady?'只在点击后下载（最多 200 MiB）。媒体仅保留在本次页面，刷新后需重新获取。':'请在 Coconut 桌面或轻量服务中重新获取原声；也可以选择已下载的本地音视频文件。';
 let link=$('podcast-origin');
 if(!link){link=el('a','podcast-origin');link.id='podcast-origin';link.target='_blank';link.rel='noopener noreferrer';$('provenance').after(link);}
 const url=source&&(Coconut.podcastURL(doc.source_url)||Coconut.podcastURL(source.feed_url));
 link.hidden=!url;if(url){link.href=url;link.textContent='打开节目原站（时间请手动定位）';}
 $('source').hidden=Boolean(source);
}
$('download-podcast-media').onclick=async()=>{
 const doc=active(),source=doc?.podcast_source;if(!podcastReady||podcastMediaRequest||!source?.media_url)return;
 const key=doc.key,revision=mediaSelectionRevision(key),mediaIdentity=Coconut.podcastMediaIdentity(doc),controller=new AbortController();podcastMediaRequest=controller;podcastMediaKey=key;$('cancel-podcast-media').hidden=false;renderPodcastPlayback();$('podcast-media-status').textContent='正在下载公开原声（最多 200 MiB），可随时取消；不会发起转录。';
 let url;
 try{
  const payload=source.kind==='direct_media'?{url:source.media_url}:{feedUrl:source.feed_url,episodeId:source.episode_id,mediaUrl:source.media_url};
  const response=await podcastAPI('media',payload,controller.signal);
  const {blob,kind}=await readPodcastMedia(response);
  if(kind!==source.media_kind)throw new Error('下载媒体类型与项目来源不一致，请重新发现来源。');
  const fingerprint=await fingerprintMedia(blob);
  const identity=fingerprint?'publisher-v1:'+source.media_url+':'+fingerprint:null;
  if(controller.signal.aborted||mediaSelectionRevision(key)!==revision||!state.documents.some(d=>d===doc)||Coconut.podcastMediaIdentity(doc)!==mediaIdentity){if(active()?.key===key)$('podcast-media-status').textContent='本次下载已取消，保留当前选择的媒体。';return;}
  changeMediaSelection(key,false);
  url=URL.createObjectURL(blob);const previous=browserMedia.get(key);
  if(active()?.key===key){stopRepeating();$('source-media').querySelector('audio,video')?.pause();}
  browserMedia.set(key,{url,kind,name:'本集发布者原声',origin:'publisher',identity,mediaIdentity});if(previous)URL.revokeObjectURL(previous.url);
  if(active()?.key===key){render();$('podcast-media-status').textContent='原声已在本次页面就绪。未发起转录；刷新后可重新获取。';}
  url=null;
 }catch(error){if(url)URL.revokeObjectURL(url);if(active()?.key===key)$('podcast-media-status').textContent=controller.signal.aborted?'已取消下载，文字稿和笔记保留。':error.message;}
 finally{podcastMediaRequest=null;podcastMediaKey=null;$('cancel-podcast-media').hidden=true;$('download-podcast-media').disabled=!podcastReady;}
};
$('cancel-podcast-media').onclick=()=>podcastMediaRequest?.abort();
window.addEventListener('coconut-media-selection-change',event=>{if(event.detail?.key===podcastMediaKey)podcastMediaRequest?.abort();});
window.addEventListener('coconut-render',renderPodcastPlayback);
window.addEventListener('coconut-worker-ready',event=>{podcastReady=event.detail?.podcast_import===true;$('podcast-import').hidden=!podcastReady;setPodcastBusy(!!podcastRequest);renderPodcastPlayback();});
window.addEventListener('coconut-worker-disconnected',()=>{podcastReady=false;podcastRequest?.abort();podcastMediaRequest?.abort();setPodcastBusy(false);renderPodcastPlayback();});
renderPodcastPlayback();

let projectCaptionRequest=null;
function renderProjectCaptionAction(){
 const doc=active(),source=doc?.podcast_source;
 const available=Coconut.isAudioProject(doc)&&source?.feed_url&&source?.episode_id;
 $('fetch-project-transcript').hidden=!available;$('fetch-project-transcript').disabled=!podcastReady||!!projectCaptionRequest;
 $('cancel-project-transcript').hidden=!projectCaptionRequest;
 if(projectCaptionRequest&&(active()?.key!==projectCaptionRequest.target.key||workspace!=='read'||!Coconut.isAudioProject(doc)))projectCaptionRequest.controller.abort();
}
$('fetch-project-transcript').onclick=async()=>{
 const doc=active(),source=doc?.podcast_source;if(!podcastReady||projectCaptionRequest||!Coconut.isAudioProject(doc)||!source?.feed_url)return;
 const target={key:doc.key,source:JSON.stringify(source),document:doc},controller=new AbortController();projectCaptionRequest={controller,target};renderProjectCaptionAction();$('audio-project-status').textContent='正在检查本集发布者文字稿，不会下载媒体或运行识别。';
 try{
  const response=await podcastAPI('import',{feedUrl:source.feed_url,episodeId:source.episode_id},controller.signal),result=await response.json();
  if(controller.signal.aborted||projectCaptionRequest?.controller!==controller)return;
  if(result.status==='needs_transcription'){$('audio-project-status').textContent='发布者仍未提供可用的定时文字稿。原项目保留；可以选择合法取得的字幕或已完成的 ASR JSON，未自动识别。';return;}
  if(result.status!=='ready'||!result.document)throw new Error('未取得有效文字稿，原项目保留。');
  const text=Coconut.validate(result.document);
  if(Coconut.audioProjectIdentity(text)!==Coconut.audioProjectIdentity(doc))throw new Error('返回文字稿与本项目来源不一致，未附加，请重新发现来源。');
  if(text.podcast_source?.media_url!==source.media_url||text.podcast_source?.media_kind!==source.media_kind||!['audio','video'].includes(source.media_kind))throw new Error('发布者媒体地址或类型已变化或无法核对，未把新文字稿配到旧原声。请重新发现来源并核对媒体后再补充。');
  const persisted=await attachTranscriptToProject(text,target);
  if(projectCaptionRequest?.controller===controller&&active()===persisted.identity&&workspace==='read'&&activeSelectionRevision===persisted.selectionRevision&&contentIngressAllowed(persisted.identity))notice(persisted.ok?'发布者文字稿已补充到原项目，笔记、书签和当前媒体保留。尚未经人工核对；未调用模型。':'文字稿已在本页附加，但未能保存，请立即导出 JSON 备份。');
 }catch(error){if(active()?.key===target.key)$('audio-project-status').textContent=controller.signal.aborted?'已取消获取文字稿，原项目保留。':error.message;}
 finally{if(projectCaptionRequest?.controller===controller){projectCaptionRequest=null;renderProjectCaptionAction();}}
};
$('cancel-project-transcript').onclick=()=>projectCaptionRequest?.controller.abort();
window.addEventListener('coconut-render',renderProjectCaptionAction);
window.addEventListener('coconut-worker-ready',renderProjectCaptionAction);
window.addEventListener('coconut-worker-disconnected',()=>{projectCaptionRequest?.controller.abort();renderProjectCaptionAction();});
renderProjectCaptionAction();

// Retire client-side imports; removing a reader entry never deletes server media or jobs.
window.addEventListener('coconut-document-retiring',event=>{
 if(projectCaptionRequest?.target.key===event.detail?.key){projectCaptionRequest.controller.abort();$('audio-project-status').textContent='已取消移除项目的文字稿请求，迟到结果不会覆盖恢复副本。';}
});
