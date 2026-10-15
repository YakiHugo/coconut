/** Authored bytes, real public-source parser and ingestion coordinator. No external I/O. */
import {createPodcastSources} from '../../desktop/podcast-sources.mjs';
import {createIngestionService} from '../../desktop/ingestion-service.mjs';
export const sourceFeed='https://publisher.example.org/source-discovery.xml';
export const frenchTrack='https://publisher.example.org/french.vtt';
export const unlabelledTrack='https://publisher.example.org/unlabelled.vtt';
export const upgradeTrack='https://publisher.example.org/upgrade.vtt';
export function sourceDiscoveryFixture(){
    const state={upgrade:false,failTrack:false,hold:null,feedLanguage:'en',onlyFrench:false},calls=[];
    const rss=()=>`<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Authored discovery show</title>${state.feedLanguage?`<language>${state.feedLanguage}</language>`:''}
    <item><guid>episode-one</guid><title>Authored multilingual episode</title><link>https://publisher.example.org/one</link><enclosure url="https://publisher.example.org/one.mp3" type="audio/mpeg"/><podcast:transcript url="${frenchTrack}" type="text/vtt" language="fr"/>${state.onlyFrench?'':`<podcast:transcript url="${unlabelledTrack}" type="text/vtt"/>`}</item>
    <item><guid>episode-two</guid><title>Authored evolving episode</title><link>https://publisher.example.org/two</link><enclosure url="https://publisher.example.org/two.mp3" type="audio/mpeg"/>${state.upgrade?`<podcast:transcript url="${upgradeTrack}" type="text/vtt" language="en"/>`:''}</item></channel></rss>`;
    const sources=createPodcastSources({fetchResource:async(url,options)=>{
        calls.push({url});
        if(state.hold)await state.hold;
        if(options.signal?.aborted)throw new DOMException('Cancelled','AbortError');
        if(url==='https://publisher.example.org/direct.mp3')return {url,type:'audio/mpeg',length:100,body:Buffer.alloc(0)};
        if(url===sourceFeed)return {url,type:'application/rss+xml',body:Buffer.from(rss())};
        if([frenchTrack,unlabelledTrack,upgradeTrack].includes(url)){
            if(state.failTrack)throw Error('Authored transcript temporarily unavailable');
            return {url,type:'text/vtt',body:Buffer.from('WEBVTT\n\n00:00.000 --> 00:02.000\n'+(url===frenchTrack?'Bonjour, cette source reste intacte.':url===upgradeTrack?'The original project keeps its notes.':'A publisher track without language metadata.')+'\n')};
        }
        throw Error('Unapproved authored source: '+url);
    }});
    const service=createIngestionService({podcastSources:sources});
    return {state,calls,service,sources};
}
