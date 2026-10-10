/** Optional live acceptance: no models, accounts, source text or upstream URLs in logs. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPodcastSources } from '../desktop/podcast-sources.mjs';
const sources=createPodcastSources(),signal=AbortSignal.timeout(180000);
async function verifyAudioPlayback(media) {
 const { chromium }=await import('./helpers/browser-storage.mjs');
 // This test serves only the already downloaded buffer; no arbitrary proxy,
 // source URL, saved transcript or filesystem path is exposed to the browser.
 const server=http.createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'none'; media-src 'self'; frame-ancestors 'none'");
  if(req.headers.host!==`127.0.0.1:${server.address().port}`){res.writeHead(403);res.end();return;}
  if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><meta charset="utf-8"><audio id="sample" controls></audio>');return;}
  if(req.url!=='/media'||!['GET','HEAD'].includes(req.method)){res.writeHead(404);res.end();return;}
  let start=0,end=media.body.length-1;
  if(req.headers.range){
   const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
   if(!range){res.writeHead(416);res.end();return;}
   start=Number(range[1]);end=range[2]?Math.min(Number(range[2]),end):end;
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=media.body.length){res.writeHead(416);res.end();return;}
  }
  res.writeHead(req.headers.range?206:200,{'Content-Type':media.type,'Content-Length':end-start+1,'Accept-Ranges':'bytes',...(req.headers.range?{'Content-Range':`bytes ${start}-${end}/${media.body.length}`}:{})});
  res.end(req.method==='HEAD'?undefined:media.body.subarray(start,end+1));
 });
 let browser;
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  const duration=await page.evaluate(async()=>{
   const audio=document.getElementById('sample');
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('metadata timeout')),20000);
    audio.addEventListener('loadedmetadata',()=>{clearTimeout(timer);resolve();},{once:true});
    audio.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('decode failed'));},{once:true});
    audio.src='/media';audio.load();
   });
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('play timeout')),20000);
    audio.play().then(()=>{clearTimeout(timer);resolve();},()=>{clearTimeout(timer);reject(new Error('play failed'));});
   });return audio.duration;
  });
  assert.ok(Number.isFinite(duration)&&duration>10&&duration<=21600);
  await page.waitForFunction(()=>document.getElementById('sample').currentTime>=1,{},{timeout:15000});
  const target=Math.min(30,duration/2);
  const seek=await page.evaluate(async target=>{
   const audio=document.getElementById('sample');audio.pause();
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('seek timeout')),20000);
    audio.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true});
    audio.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('seek failed'));},{once:true});audio.currentTime=target;
   });
   return audio.currentTime;
  },target);
  assert.ok(Math.abs(seek-target)<0.5);
  return {duration_seconds:Math.round(duration),playback_verified:true,seek_verified:true};
 }finally{
  try{await browser?.close();}finally{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
 }
}
let stage='public feed discovery';
try {
 const feed=await sources.discover({url:'https://mp3s.nashownotes.com/pc20rss.xml'},{signal});
 assert.equal(feed.kind,'feed');assert.ok(feed.episodes.length>0);
 const episode=feed.episodes.find(item=>item.transcripts.some(track=>track.supported&&['en','en-us'].includes(track.language)));
 assert.ok(episode,'The live feed must provide a supported original-language timed transcript');
 stage='publisher transcript import';
 const result=await sources.importEpisode({feedUrl:feed.feed_url,episodeId:episode.id},{signal});
 assert.equal(result.status,'ready');assert.equal(result.document.provenance.kind,'publisher_transcript');assert.equal(result.document.provenance.caption_method,'publisher_provided');assert.equal(result.document.provenance.review_status,'unreviewed');
 assert.ok(result.document.segments.length>10);assert.ok(result.document.segments.at(-1).end>60);
 assert.equal(result.document.podcast_source.episode_id,episode.id);
 console.log(JSON.stringify({check:'native_public_feed_and_transcript',passed:true,episodes:feed.episodes.length,segments:result.document.segments.length,language:result.document.language,kind:result.document.provenance.kind,review_status:result.document.provenance.review_status}));
 stage='Apple publisher feed resolution';
 const apple=await sources.discover({url:'https://podcasts.apple.com/us/podcast/the-changelog-software-development-open-source/id341623264'},{signal});
 assert.equal(apple.kind,'feed');assert.equal(apple.feed_url,'https://changelog.com/podcast/feed');assert.ok(apple.episodes.length>0);
 console.log(JSON.stringify({check:'apple_public_feed_resolution',passed:true,episodes:apple.episodes.length}));
 stage='Apple exact shared episode resolution';
 const shared=await sources.discover({url:'https://podcasts.apple.com/us/podcast/the-changelog-software-development-open-source/id341623264?i=1000785837067'},{signal});
 assert.equal(shared.episode_selection?.status,'matched');assert.equal(shared.episode_selection.apple_episode_id,'1000785837067');assert.equal(shared.episodes.length,1);assert.equal(shared.episodes[0].title,'Postgres at PlanetScale (Interview)');assert.equal(shared.episode_selection.matched_by,'publisher_guid');assert.notEqual(shared.episodes[0].id,apple.episodes[0].id);
 console.log(JSON.stringify({check:'apple_exact_shared_episode_resolution',passed:true,episodes:1,identity:shared.episode_selection.matched_by}));
 stage='Xiaoyuzhou public episode gates';
 const xy=await sources.discover({url:'https://www.xiaoyuzhoufm.com/episode/6ab0922a0916f6f8b4468234'},{signal});
 assert.equal(xy.source_type,'xiaoyuzhou_public_page');assert.equal(xy.episodes.length,1);assert.equal(xy.episodes[0].transcripts.length,0);
 console.log(JSON.stringify({check:'xiaoyuzhou_public_episode',passed:true,episodes:1,transcript_available:false}));
 // Explicit opt-in only: at most one source-declared <=100 MiB public audio file.
 if(process.env.COCONUT_LIVE_PODCAST_MEDIA==='1') {
  stage='bounded public media download';
  const selected=xy.episodes[0],media=selected.media.find(item=>item.kind==='audio'&&item.length>0&&item.length<=100*1024*1024);
  assert.ok(media,'The reviewed sample must remain below the live media budget');
  const downloaded=await sources.downloadMedia({feedUrl:xy.feed_url,episodeId:selected.id,mediaUrl:media.url,maxBytes:100*1024*1024},{signal});
  assert.equal(downloaded.kind,'audio');assert.ok(downloaded.body.length>1000);assert.ok(downloaded.body.length<=100*1024*1024);
  console.log(JSON.stringify({check:'native_public_media_download',passed:true,bytes:downloaded.body.length,kind:downloaded.kind}));
  stage='Chromium public audio decode, playback and seek';
  const playback=await verifyAudioPlayback(downloaded);
  console.log(JSON.stringify({check:'chromium_public_audio_playback',passed:true,...playback}));
 }
} catch {
 console.error(JSON.stringify({check:stage,passed:false,message:'Live source, access, schema or transport verification failed. No ASR, account, proxy workaround or paid fallback was attempted.'}));
 process.exitCode=1;
}
