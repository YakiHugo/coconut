/** Original public-page state and a one-second WAV; all source I/O is allowlisted. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPodcastSources} from '../../desktop/podcast-sources.mjs';
import {createIngestionService} from '../../desktop/ingestion-service.mjs';

export const directEpisodeEid='6ab0922a0916f6f8b4468234';
export const directEpisodeId=createHash('sha256').update(directEpisodeEid).digest('hex');
export const directEpisodeURL=`https://www.xiaoyuzhoufm.com/episode/${directEpisodeEid}`;
export const directShowURL='https://www.xiaoyuzhoufm.com/podcast/699921e13ae08cdf3348fdd6';
export const directRSSURL='https://publisher.example.org/one-episode.xml';
export const directMediaURL='https://media.example.org/authored-direct-episode.wav';
export const directEpisodeTitle='Authored one-click direct episode';

export function directEpisodeFixture(){
 const calls=[],counts={page:0,media:0},state={holdMedia:null};
 const wav=Buffer.alloc(32044);
 wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
 wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
 wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
 wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
 // A quiet authored tone exercises actual decoding and playback rather than a stub audio element.
 for(let sample=0;sample<16000;sample++)wav.writeInt16LE(Math.round(Math.sin(sample*2*Math.PI*440/16000)*1000),44+sample*2);
 const episode={eid:directEpisodeEid,pid:'699921e13ae08cdf3348fdd6',title:directEpisodeTitle,duration:1,status:'NORMAL',payType:'FREE',isPrivateMedia:false,
  media:{size:wav.length,mimeType:'audio/wav',source:{mode:'PUBLIC',url:directMediaURL}},enclosure:{url:directMediaURL}};
 const page=pageProps=>'<!doctype html><html><head><title>Authored public episode</title></head><body><script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({props:{pageProps}})+'</script></body></html>';
 const rss=`<rss><channel><title>Authored single-item RSS</title><item><guid>authored-single-item</guid><title>${directEpisodeTitle}</title><link>https://publisher.example.org/episode</link><enclosure url="${directMediaURL}" type="audio/wav" length="${wav.length}"/></item></channel></rss>`;
 const sources=createPodcastSources({fetchResource:async(url,options)=>{
  calls.push({url,signal:options.signal});
  if(options.signal?.aborted)throw new DOMException('Cancelled','AbortError');
  if(url===directEpisodeURL||url===directShowURL){counts.page++;return {url,type:'text/html',body:Buffer.from(page(url===directEpisodeURL?{episode}:{podcast:{pid:episode.pid,title:'Authored single-item show',episodes:[episode]}}))};}
  if(url===directRSSURL)return {url,type:'application/rss+xml',body:Buffer.from(rss)};
  assert.equal(url,directMediaURL,'No external source requests are permitted');
  counts.media++;if(state.holdMedia)await state.holdMedia;
  return {url,type:'audio/wav',length:wav.length,body:Buffer.from(wav)};
 }});
 return {calls,counts,state,wav,sources,service:createIngestionService({podcastSources:sources})};
}
