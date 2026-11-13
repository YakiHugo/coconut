import test from 'node:test';
import assert from 'node:assert/strict';
import Coconut from '../reader/core.js';
import {createPodcastSources} from '../desktop/podcast-sources.mjs';
import {createIngestionService} from '../desktop/ingestion-service.mjs';
import {createCaptionService} from '../desktop/caption-service.mjs';
import {publisherContext} from '../desktop/transcription-context.mjs';
import {videoSourceHeader} from '../desktop/video-audio-service.mjs';

test('Xiaoyuzhou show notes reach a saved audio project and survive transcript attachment without becoming cues',async()=>{
 const eid='0123456789abcdef01234567',url='https://www.xiaoyuzhoufm.com/episode/'+eid;
 const episode={eid,title:'芯片访谈',duration:42,status:'NORMAL',payType:'FREE',isPrivateMedia:false,
  podcast:{title:'测试播客',author:'发布者'},pubDate:'2026-11-01',
  description:'较短的摘要',shownotes:'<p>嘉宾：张元 &amp; 陈旌</p><p>00:20 讨论 SGLang</p><script>bad()</script>',
  enclosure:{url:'https://media.example.org/source.m4a'},
  media:{mimeType:'audio/mp4',source:{mode:'PUBLIC',url:'https://media.example.org/source.m4a'}}};
 const sources=createPodcastSources({fetchResource:async()=>({url,type:'text/html',body:Buffer.from('<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({props:{pageProps:{episode}}}).replace(/</g,'\\u003c')+'</script>')})});
 const feed=await sources.discover({url}),service=createIngestionService({podcastSources:sources});
 const {ingestion}=await service.ingest({protocolVersion:1,source:{kind:'url',url},intent:'media_only',episode:{feed_url:url,episode_id:feed.episodes[0].id}});
 const saved=Coconut.validate(JSON.parse(JSON.stringify(ingestion.project.document)));
 assert.equal(saved.transcription_context.show,'测试播客');
 assert.equal(saved.transcription_context.publisher,'发布者');
 assert.equal(saved.transcription_context.description,'嘉宾：张元 & 陈旌\n00:20 讨论 SGLang');
 assert.deepEqual(saved.segments,[]);
 const attached=Coconut.attachProjectTranscript(saved,{title:'识别结果',segments:[{id:'one',start:0,end:1,text:'真实识别'}]});
 assert.deepEqual(attached.transcription_context,saved.transcription_context);
 assert.equal(attached.segments[0].text,'真实识别');
});

test('Bilibili publisher metadata survives caption validation; background remains outside the transcript',async()=>{
 const url='https://www.bilibili.com/video/BV1xx411c7mD';
 const captions=createCaptionService({enabledProviders:['bilibili'],helper:{extractCaptions:async()=>({
  source:{url,id:'BV1xx411c7mD',title:'芯片访谈',extractor:'BiliBili',language:'zh',automatic:false,duration:4,
   transcription_context:{source_url:url,platform:'bilibili',publisher:'原创 UP 主',published:'20261101',description:'<p>本期讨论 SGLang。</p>'}},
  format:'vtt',bytes:Buffer.from('WEBVTT\n\n00:00.000 --> 00:04.000\n这是原字幕。\n')
 })}});
 const {document}=await captions.importCaption({url});
 assert.equal(document.transcription_context.publisher,'原创 UP 主');
 assert.equal(document.transcription_context.description,'本期讨论 SGLang。');
 assert.equal(document.segments[0].text,'这是原字幕。');
});

test('long Unicode video descriptions fit the existing media header and retain source identity',()=>{
 const url='https://www.bilibili.com/video/BV1xx411c7mD';
 const context=publisherContext({source_url:url,platform:'bilibili',publisher:'作者',description:'技术术语与讨论。\n'.repeat(2000)});
 assert.equal(context.description.length,6000);
 const source={url,title:'标题'.repeat(250),id:'BV1xx411c7mD',transcription_context:context};
 const encoded=videoSourceHeader(source),decoded=JSON.parse(Buffer.from(encoded,'base64url').toString());
 assert.ok(encoded.length<=8192);
 assert.equal(decoded.url,url);
 assert.equal(decoded.transcription_context.publisher,'作者');
 assert.ok(decoded.transcription_context.description.length>0);
 assert.equal(context.description.length,6000);
});
