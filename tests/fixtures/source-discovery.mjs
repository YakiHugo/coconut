/** Authored bytes, real public-source parser and ingestion coordinator. No external I/O. */
import {createPodcastSources} from '../../desktop/podcast-sources.mjs';
import {createIngestionService} from '../../desktop/ingestion-service.mjs';
export const sourceFeed='https://publisher.example.org/source-discovery.xml';
export const frenchTrack='https://publisher.example.org/french.vtt';
export const unlabelledTrack='https://publisher.example.org/unlabelled.vtt';
export const upgradeTrack='https://publisher.example.org/upgrade.vtt';
export function sourceDiscoveryFixture(){
    const state={extraEpisodes:0,upgrade:false,failTrack:false,failFeed:false,hold:null,holdFeed:null,feedLanguage:'en',onlyFrench:false,now:Date.parse('2026-10-15T12:00:00Z')},calls=[],counts={feed:0,transcript:0};
    const rss=()=>`<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Authored discovery show</title>${state.feedLanguage?`<language>${state.feedLanguage}</language>`:''}
    <item><guid>episode-one</guid><pubDate>Thu, 15 Oct 2026 12:00:00 GMT</pubDate><itunes:duration>1:02:03</itunes:duration><title>Authored multilingual episode</title><link>https://publisher.example.org/one</link><enclosure url="https://publisher.example.org/one.mp3" type="audio/mpeg"/><podcast:transcript url="${frenchTrack}" type="text/vtt" language="fr"/>${state.onlyFrench?'':`<podcast:transcript url="${unlabelledTrack}" type="text/vtt"/>`}</item>
    <item><guid>episode-two</guid><title>Authored evolving episode</title><link>https://publisher.example.org/two</link><enclosure url="https://publisher.example.org/two.mp3" type="audio/mpeg"/>${state.upgrade?`<podcast:transcript url="${upgradeTrack}" type="text/vtt" language="en"/>`:''}</item>${Array.from({length:state.extraEpisodes},(_,i)=>`<item><guid>extra-${i}</guid><title>Archive episode ${String(i).padStart(3,'0')}</title><enclosure url="https://publisher.example.org/archive-${i}.mp3" type="audio/mpeg"/></item>`).join('')}</channel></rss>`;
    const sources=createPodcastSources({now:()=>state.now,fetchResource:async(url,options)=>{
        calls.push({url,signal:options.signal});
        if(url===sourceFeed)counts.feed++;
        if([frenchTrack,unlabelledTrack,upgradeTrack].includes(url))counts.transcript++;
        if(state.hold)await state.hold;
        if(url===sourceFeed&&state.holdFeed)await state.holdFeed;
        if(options.signal?.aborted)throw new DOMException('Cancelled','AbortError');
        if(url==='https://publisher.example.org/direct.mp3')return {url,type:'audio/mpeg',length:100,body:Buffer.alloc(0)};
        if(url===sourceFeed){
            if(state.failFeed)throw Error('Authored feed temporarily unavailable');
            return {url,type:'application/rss+xml',body:Buffer.from(rss())};
        }
        if([frenchTrack,unlabelledTrack,upgradeTrack].includes(url)){
            if(state.failTrack)throw Error('Authored transcript temporarily unavailable');
            return {url,type:'text/vtt',body:Buffer.from('WEBVTT\n\n00:00.000 --> 00:02.000\n'+(url===frenchTrack?'Bonjour, cette source reste intacte.':url===upgradeTrack?'The original project keeps its notes.':'A publisher track without language metadata.')+'\n')};
        }
        throw Error('Unapproved authored source: '+url);
    }});
    const service=createIngestionService({podcastSources:sources});
    return {state,calls,counts,service,sources};
}

export const audioFirstTrack='https://publisher.example.org/audio-first.vtt';
export const audioFirstMedia='https://publisher.example.org/audio-first.wav';
/** Broken advertised VTT and a valid 40-second WAV, both authored offline. */
export function audioFirstFixture(){
    const state={fixed:false,missingMedia:false,failFeed:false,failMedia:false,holdFeed:null,holdMedia:null,now:Date.parse('2026-10-15T12:00:00Z')},calls=[],counts={feed:0,transcript:0,media:0};
    const wav=Buffer.alloc(44+16000*40);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
    const rss=()=>`<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Authored audio-first show</title><language>en</language>
    <item><guid>audio-first</guid><title>Authored audio-first episode</title><link>https://publisher.example.org/audio-first</link>${state.missingMedia?'':`<enclosure url="${audioFirstMedia}" type="audio/wav" length="${wav.length}"/>`}<podcast:transcript url="${audioFirstTrack}" type="text/vtt" language="en"/></item>
    <item><guid>without-media</guid><title>Authored episode without audio</title><podcast:transcript url="${audioFirstTrack}" type="text/vtt" language="en"/></item></channel></rss>`;
    const sources=createPodcastSources({now:()=>state.now,fetchResource:async(url,options)=>{
        calls.push({url,signal:options.signal});
        if(url===sourceFeed){counts.feed++;if(state.holdFeed)await state.holdFeed;}
        if(url===audioFirstMedia){counts.media++;if(state.holdMedia)await state.holdMedia;}
        if(options.signal?.aborted)throw new DOMException('Cancelled','AbortError');
        if(url===sourceFeed){if(state.failFeed)throw Error('Authored feed temporarily unavailable');return {url,type:'application/rss+xml',body:Buffer.from(rss())};}
        if(url===audioFirstTrack){counts.transcript++;return {url,type:'text/vtt',body:Buffer.from(state.fixed?'WEBVTT\n\n00:05.000 --> 00:08.000\nThe same audio project now has a reviewed transcript.\n':'Advertised transcript is not valid WebVTT.\n')};}
        if(url===audioFirstMedia){if(state.failMedia)throw Error('Authored media unavailable');return {url,type:'audio/wav',body:wav};}
        throw Error('Unapproved authored source: '+url);
    }});
    return {state,calls,counts,sources,service:createIngestionService({podcastSources:sources})};
}
