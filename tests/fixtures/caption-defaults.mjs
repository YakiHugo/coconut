/** Authored publisher metadata and bytes through the real parser/coordinator. */
import {createPodcastSources} from '../../desktop/podcast-sources.mjs';
import {createIngestionService} from '../../desktop/ingestion-service.mjs';
export const feedUrl='https://publisher.example.org/source-discovery.xml';
export const trackUrl=name=>'https://publisher.example.org/'+name;
export function captionDefaultsFixture(){
 const state={language:'zh-Hans',itemLanguage:null,tracks:[['traditional.vtt','text/vtt','zh-Hant'],['simplified.srt','application/x-subrip','zh-Hans'],['simplified.vtt','text/vtt','ZH-hANS']],now:0,hold:null},calls=[];
 const sources=createPodcastSources({now:()=>state.now,fetchResource:async(url,{signal})=>{
  calls.push(url);if(state.hold)await state.hold;if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  if(url===feedUrl)return {url,type:'application/rss+xml',body:Buffer.from(`<rss xmlns:p="https://podcastindex.org/namespace/1.0"><channel><title>Caption defaults</title>${state.language===null?'':`<language>${state.language}</language>`}<item${state.itemLanguage===null?'':` xml:lang="${state.itemLanguage}"`}><guid>defaults</guid><title>Publisher choices</title><enclosure url="https://publisher.example.org/episode.mp3" type="audio/mpeg"/>${state.tracks.map(([name,type,language])=>`<p:transcript url="${trackUrl(name)}" type="${type}"${language===null?'':` language="${language}"`}/>`).join('')}</item></channel></rss>`)};
  const track=state.tracks.find(([name])=>trackUrl(name)===url);if(!track)throw Error('Unexpected fixture request '+url);
  return {url,type:track[1],body:Buffer.from(track[1]==='text/vtt'?`WEBVTT\n\n00:00.000 --> 00:02.000\nPublisher ${track[0]}\n`:`1\n00:00:00,000 --> 00:00:02,000\nPublisher ${track[0]}\n`)};
 }});
 return {state,calls,sources,service:createIngestionService({podcastSources:sources})};
}
