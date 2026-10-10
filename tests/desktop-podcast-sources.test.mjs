import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPodcastSources, parsePodcastFeed, parsePublisherTranscript, publisherFeeds, parseXiaoyuzhouPage, matchAppleEpisode, PODCAST_LIMITS } from '../desktop/podcast-sources.mjs';
import { parseXml } from '../desktop/podcast-xml.mjs';
const dir=new URL('./fixtures/podcasts/',import.meta.url);
const fixture=name=>readFile(new URL(name,dir),'utf8');
const feedUrl='https://publisher.example.org/feed.xml';
const rss=await fixture('rss.xml'),atom=await fixture('atom.xml'),vtt=await fixture('one.vtt'),json=await fixture('one.json');
function service(overrides={}) {
 const calls=[];const resources={[feedUrl]:{type:'application/rss+xml',body:Buffer.from(rss)},'https://publisher.example.org/one.vtt':{type:'text/vtt',body:Buffer.from(vtt)},'https://media.example.org/one.mp3':{type:'audio/mpeg',body:Buffer.from('audio fixture')},...overrides};
 const sources=createPodcastSources({fetchResource:async(url,options)=>{calls.push({url,options});const response=resources[url];if(response instanceof Error)throw response;if(!response)throw new Error('Fixture missing');return {url,...response};}});
 return {sources,calls};
}
test('RSS namespaces, language, duration, distinct episodes and publisher transcript links',()=>{
 const feed=parsePodcastFeed(rss,feedUrl);assert.equal(feed.title,'公开技术播客 & Audio');assert.equal(feed.episodes.length,2);
 const one=feed.episodes[0];assert.equal(one.title,'第一集 可核对原文');assert.equal(one.duration,3723);assert.equal(one.transcripts[0].url,'https://publisher.example.org/one.vtt');assert.equal(one.transcripts[0].language,'zh-cn');assert.equal(one.media[0].kind,'audio');assert.equal(feed.episodes[1].media[0].kind,'video');assert.equal(one.id.length,64);
});
test('Atom enclosure, inherited xml:base/xml:lang, and standalone entry',()=>{
 const feed=parsePodcastFeed(atom,feedUrl);const one=feed.episodes[0];assert.equal(one.source_url,'https://publisher.example.org/episodes/one');assert.equal(one.media[0].url,'https://publisher.example.org/episodes/one.ogg');assert.equal(one.language,'en');
 assert.equal(parsePodcastFeed('<entry xmlns="http://www.w3.org/2005/Atom"><title>Entry</title><id>x</id><link rel="enclosure" href="a.mp3" type="audio/mpeg"/></entry>',feedUrl).episodes.length,1);
});
test('XML rejects DTD/entity expansion, nesting, malformed tags, attributes and non-feeds',()=>{
 for(const text of ['<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>','<rss>&xx;</rss>','<rss><channel></rss>','<rss><channel a="x" a="y"/></rss>','<rss a=x/>','<rss/>','<html/>','<rss/>garbage','<rss>'+ '<x>'.repeat(50)])assert.throws(()=>parsePodcastFeed(text,feedUrl));
 assert.throws(()=>parseXml('<rss xmlns:q=""><q:x/></rss>',feedUrl));
});
test('untrusted feed links cannot address loopback, credentials, token feeds or script protocols',()=>{
 const text='<rss><channel><item><title>No fetch</title><enclosure url="http://127.0.0.1/a.mp3" type="audio/mpeg"/><enclosure url="https://user:pass@example.org/a.mp3" type="audio/mpeg"/><enclosure url="https://example.org/a.mp3?token=private" type="audio/mpeg"/><enclosure url="javascript:alert(1)" type="audio/mpeg"/></item></channel></rss>';
 assert.throws(()=>parsePodcastFeed(text,feedUrl),/没有可用/);
});
test('episode list is bounded, stable IDs use publisher GUID, and no feed is imported implicitly',async()=>{
 const item='<item><title>E</title><guid>GUID</guid><enclosure url="https://example.org/e.mp3" type="audio/mpeg"/></item>';
 const many='<rss><channel>'+Array.from({length:205},(_,i)=>item.replace('GUID',String(i))).join('')+'</channel></rss>';
 assert.equal(parsePodcastFeed(many,feedUrl).episodes.length,200);assert.equal(parsePodcastFeed(many,feedUrl).truncated,true);
 const {sources,calls}=service();await assert.rejects(sources.importEpisode({feedUrl}),/选择一集/);assert.equal(calls.length,0);
});
test('discover only reads metadata; importing revalidates the episode and retrieves the matching-language timed transcript',async()=>{
 const {sources,calls}=service();const feed=await sources.discover({url:feedUrl});assert.equal(calls.length,1);
 const result=await sources.importEpisode({feedUrl,episodeId:feed.episodes[0].id});assert.equal(result.status,'ready');assert.equal(calls.length,3);
 assert.equal(result.document.language,'zh-cn');assert.equal(result.document.segments.length,2);assert.equal(result.document.segments[0].text,'这是一段原创测试字幕。');assert.equal(result.document.provenance.kind,'publisher_transcript');assert.equal(result.document.provenance.caption_method,'publisher_provided');assert.equal(result.document.provenance.review_status,'unreviewed');assert.equal(result.document.podcast_source.feed_url,feedUrl);assert.equal(result.document.podcast_source.episode_id,feed.episodes[0].id);assert.equal(result.document.podcast_source.transcript_url,'https://publisher.example.org/one.vtt');assert.equal(calls.some(c=>c.url.includes('media.example')),false);
});
test('no captions is needs_transcription, not a fabricated transcript or silent ASR fallback',async()=>{
 const {sources,calls}=service();const feed=await sources.discover({url:feedUrl});const result=await sources.importEpisode({feedUrl,episodeId:feed.episodes[1].id});assert.equal(result.status,'needs_transcription');assert.equal(result.document,undefined);assert.equal(calls.length,2);
});
test('transcript transport failure, unsupported selection and stale episode fail without fallback',async()=>{
 const {sources}=service({'https://publisher.example.org/one.vtt':new Error('network failure')});const feed=await sources.discover({url:feedUrl}),episodeId=feed.episodes[0].id;
 await assert.rejects(sources.importEpisode({feedUrl,episodeId}),/network failure/);
 await assert.rejects(sources.importEpisode({feedUrl,episodeId,transcriptUrl:'https://other.example.org/captions.vtt'}),/不在此单集/);
 await assert.rejects(sources.importEpisode({feedUrl,episodeId:'0'.repeat(64)}),/不在当前/);
});
test('publisher VTT, SRT and Podcasting 2.0 JSON preserve genuine timestamps and reject broken timelines',()=>{
 assert.equal(parsePublisherTranscript(vtt,'text/vtt')[1].text,'A & B');assert.equal(parsePublisherTranscript(json,'application/json')[0].speaker,'Test speaker');
 assert.equal(parsePublisherTranscript('1\n00:00:01,000 --> 00:00:02,000\nText','application/x-subrip')[0].start,1);
 for(const body of [{segments:[{startTime:4,endTime:2,body:'Bad'}]},{segments:[{startTime:0,endTime:21601,body:'Long'}]},{segments:[{startTime:'1',endTime:2,body:'String'}]},{segments:[{startTime:2,endTime:3,body:'First'},{startTime:1,endTime:2,body:'Earlier'}]},null])assert.throws(()=>parsePublisherTranscript(JSON.stringify(body),'application/json'));
 assert.throws(()=>parsePublisherTranscript('<html>A summary</html>','text/vtt'));assert.throws(()=>parsePublisherTranscript('WEBVTT\n\n00:00.000 --> 00:00.000\n','text/vtt'));
});
test('only actual advertised publisher feeds are offered, never arbitrary HTML script content',async()=>{
 const html='<script>const f=`<link rel="alternate" type="application/rss+xml" href="https://bad.example.org/feed">`</script><!--<link rel="alternate" type="application/rss+xml" href="https://bad.example.org/comment">--><link rel="alternate" type="application/atom+xml" title="Official &amp; public" href="/feed">';
 assert.deepEqual(publisherFeeds(html,'https://example.org/show'),[{url:'https://example.org/feed',title:'Official & public'}]);
 const {sources}=service({'https://example.org/show':{type:'text/html',body:Buffer.from(html)}});const result=await sources.discover({url:'https://example.org/show'});assert.equal(result.kind,'choices');assert.equal(result.episodes.length,0);
});
test('Apple uses exact official directory ID and feed, never silently maps a shared episode to latest episode',async()=>{
 const apple='https://itunes.apple.com/lookup?id=341623264&entity=podcast&country=us';
 const {sources,calls}=service({[apple]:{type:'text/javascript',body:Buffer.from(JSON.stringify({results:[{kind:'podcast',collectionId:341623264,feedUrl}]}))}});
 const result=await sources.discover({url:'https://podcasts.apple.com/us/podcast/show/id341623264?i=123'});assert.equal(result.kind,'feed');assert.equal(calls[0].url,apple);assert.match(result.warnings.at(-1),/明确选择/);assert.equal(calls.length,3);assert.equal(result.episode_selection.status,'choice_required');assert.equal(result.episodes.length,2);
});
const appleShow='https://itunes.apple.com/lookup?id=341623264&entity=podcast&country=us';
const appleEpisodes='https://itunes.apple.com/lookup?id=341623264&entity=podcastEpisode&country=us&limit=200';
const appleTrack={kind:'podcast-episode',collectionId:341623264,trackId:123,episodeGuid:'episode-two',episodeUrl:'https://media.example.org/two.mp4'};
function appleService(results,overrides={}){return service({[appleShow]:{type:'text/javascript',body:Buffer.from(JSON.stringify({results:[{kind:'podcast',collectionId:341623264,feedUrl}]}))},[appleEpisodes]:{type:'text/javascript',body:Buffer.from(JSON.stringify({results}))},...overrides});}
test('Apple episode ID uniquely matches publisher GUID rather than selecting the newest/title-similar episode',async()=>{
 const {sources,calls}=appleService([appleTrack]);const found=await sources.discover({url:'https://podcasts.apple.com/us/podcast/show/id341623264?i=123'});
 assert.equal(found.episodes.length,1);assert.equal(found.episodes[0].title,'视频播客');assert.equal(found.episode_selection.status,'matched');assert.equal(found.episode_selection.matched_by,'publisher_guid');assert.equal(found.episode_selection.episode_id,found.episodes[0].id);assert.equal(found.episode_selection.apple_episode_id,'123');assert.equal(found.truncated,false);assert.equal(calls.length,3);assert.equal(calls.at(-1).options.maxBytes,PODCAST_LIMITS.metadataBytes);assert.ok(calls.every(c=>!c.url.includes('media.example')));
});
test('Apple enclosure is usable only as an exact unambiguous identity, never fuzzy title/date/URL matching',()=>{
 const episodes=parsePodcastFeed(rss,feedUrl).episodes;
 assert.equal(matchAppleEpisode([{...appleTrack,episodeGuid:undefined}],'341623264','123',episodes).matched_by,'enclosure_url');
 for(const changed of [{collectionId:1},{collectionId:[341623264]},{trackId:[123]},{trackId:9007199254740992},{trackId:124},{kind:'podcast'},{episodeGuid:'unknown',episodeUrl:'https://media.example.org/two.mp4?other=1',trackName:'视频播客'},
  {episodeGuid:'episode-one'},{episodeGuid:'unknown',episodeUrl:'https://user:pass@media.example.org/two.mp4'},{episodeGuid:'unknown',episodeUrl:'http://127.0.0.1/audio'}])assert.equal(matchAppleEpisode([{...appleTrack,...changed}],'341623264','123',episodes),null);
 assert.equal(matchAppleEpisode([appleTrack,appleTrack],'341623264','123',episodes),null);
 assert.equal(matchAppleEpisode([{...appleTrack,episodeGuid:undefined}],'341623264','123',[...episodes,{...episodes[1],id:'b'.repeat(64)}]),null);
});
test('RSS reused media outside the displayed window cannot establish a unique Apple enclosure match',async()=>{
 const entry=(guid,media)=>`<item><guid>${guid}</guid><title>${guid}</title><enclosure url="https://media.example.org/${media}.mp3" type="audio/mpeg"/></item>`;
 const filler=Array.from({length:205},(_,i)=>entry('filler-'+i,'filler-'+i)).join('');
 const body=Buffer.from('<rss><channel>'+entry('first','same')+filler+entry('second','same')+'</channel></rss>');
 const {sources}=appleService([{...appleTrack,episodeGuid:undefined,episodeUrl:'https://media.example.org/same.mp3'}],{[feedUrl]:{type:'application/rss+xml',body}});
 const result=await sources.discover({url:'https://podcasts.apple.com/us/podcast/show/id341623264?i=123'});
 assert.equal(result.episode_selection.status,'choice_required');assert.equal(result.episodes[0].identity_ambiguous,true);assert.equal(result.episodes.length,200);assert.equal(result.truncated,true);
});
test('Apple GUID/enclosure conflicts across the display cutoff require manual choice in either direction',async()=>{
 const entry=guid=>`<item><guid>${guid}</guid><title>${guid}</title><enclosure url="https://media.example.org/${guid}.mp3" type="audio/mpeg"/></item>`;
 const body=Buffer.from('<rss><channel>'+entry('first')+Array.from({length:205},(_,i)=>entry('filler-'+i)).join('')+entry('later')+'</channel></rss>');
 for(const [guid,media] of [['first','later'],['later','first']]){
  const {sources}=appleService([{...appleTrack,episodeGuid:guid,episodeUrl:`https://media.example.org/${media}.mp3`}],{[feedUrl]:{type:'application/rss+xml',body}});
  const result=await sources.discover({url:'https://podcasts.apple.com/us/podcast/show/id341623264?i=123'});
  assert.equal(result.episode_selection.status,'choice_required');assert.equal(result.episodes.length,200);assert.equal(result.truncated,true);assert.ok(!JSON.stringify(result).includes('mediaOwners'));
 }
});
test('RSS duplicate identity never selects the first episode for an Apple link, even beyond the displayed window',async()=>{
 const entry=(guid,media)=>`<item><guid>${guid}</guid><title>${media}</title><enclosure url="https://media.example.org/${media}.mp3" type="audio/mpeg"/></item>`;
 for(const intervening of ['',Array.from({length:205},(_,i)=>entry('filler-'+i,'filler-'+i)).join('')]){
  const body=Buffer.from('<rss><channel>'+entry('duplicate-guid','first')+intervening+entry('duplicate-guid','second')+'</channel></rss>');
  const track={...appleTrack,episodeGuid:'duplicate-guid',episodeUrl:'https://media.example.org/second.mp3'};
  const {sources}=appleService([track],{[feedUrl]:{type:'application/rss+xml',body}});
  const result=await sources.discover({url:'https://podcasts.apple.com/us/podcast/show/id341623264?i=123'});
  assert.equal(result.episode_selection.status,'choice_required');assert.equal(result.episodes[0].identity_ambiguous,true);assert.equal(result.episodes[0].title,'first');assert.match(result.warnings.join(' '),/重复/);
 }
});
test('Apple missing, malformed, failed, conflicting or older-than-window metadata preserves explicit choices',async()=>{
 for(const result of [[],[{...appleTrack,trackId:124}],[appleTrack,appleTrack],[{...appleTrack,episodeGuid:'episode-one'}]]){
  const {sources}=appleService(result);const found=await sources.discover({url:'https://podcasts.apple.com/us/podcast/show/id341623264?i=123'});assert.equal(found.episodes.length,2);assert.equal(found.episode_selection.status,'choice_required');assert.match(found.warnings.at(-1),/不会按标题猜测/);
 }
 for(const response of [new Error('Directory unavailable'),{type:'application/json',body:Buffer.from('{broken')}]){
  const {sources}=appleService([],{[appleEpisodes]:response});assert.equal((await sources.discover({url:'https://podcasts.apple.com/us/podcast/show/id341623264?i=123'})).episode_selection.status,'choice_required');
 }
});
test('Apple show-only lookup avoids episode metadata and malformed episode IDs are rejected before network calls',async()=>{
 const {sources,calls}=appleService([]);const show=await sources.discover({url:'https://podcasts.apple.com/us/podcast/show/id341623264'});assert.equal(show.episode_selection,undefined);assert.equal(calls.length,2);
 for(const query of ['i=','i=abc','i=0','i=123&i=124','i=123456789012345678901'])await assert.rejects(sources.discover({url:'https://podcasts.apple.com/us/podcast/show/id341623264?'+query}),/单集 ID 无效/);assert.equal(calls.length,2);
});
test('cancelled Apple episode lookup propagates cancellation instead of publishing a manual fallback',async()=>{
 const controller=new AbortController();
 const aborting=createPodcastSources({fetchResource:async(url,options)=>{
  if(url===appleEpisodes){controller.abort();throw new Error('cancelled lookup');}
  return {url,type:'application/json',body:Buffer.from(url===appleShow?JSON.stringify({results:[{kind:'podcast',collectionId:341623264,feedUrl}]}):rss)};
 }});
 await assert.rejects(aborting.discover({url:'https://podcasts.apple.com/us/podcast/show/id341623264?i=123'},{signal:controller.signal}),/cancelled lookup/);
});
test('Spotify and Xiaoyuzhou access boundaries are explicit, no hidden API or cookie fallback',async()=>{
 const {sources,calls}=service({'https://www.xiaoyuzhoufm.com/podcast/abc':{type:'text/html',body:Buffer.from('<html>Only show notes</html>')}});
 await assert.rejects(sources.discover({url:'https://open.spotify.com/episode/abc'}),/原发布者公开 RSS/);assert.equal(calls.length,0);
 await assert.rejects(sources.discover({url:'https://www.xiaoyuzhoufm.com/podcast/abc'}),/官方节目或单集分享链接/);assert.equal(calls.length,1);
});
test('explicit media download requires exact enclosure membership and response media type',async()=>{
 const {sources,calls}=service();const feed=await sources.discover({url:feedUrl}),episodeId=feed.episodes[0].id;
 await assert.rejects(sources.downloadMedia({feedUrl,episodeId,mediaUrl:'https://other.example.org/a.mp3'}),/不在所选单集/);
 const output=await sources.downloadMedia({feedUrl,episodeId,mediaUrl:feed.episodes[0].media[0].url});assert.equal(output.kind,'audio');assert.equal(output.body.toString(),'audio fixture');assert.equal(calls.at(-1).options.maxBytes,PODCAST_LIMITS.mediaBytes);
 const mismatch=service({'https://media.example.org/one.mp3':{type:'video/mp4',body:Buffer.from('video')}}).sources;
 await assert.rejects(mismatch.downloadMedia({feedUrl,episodeId,mediaUrl:feed.episodes[0].media[0].url}),/声明不符/);
});
test('direct-media discovery requests header inspection only and remains transcript-free',async()=>{
 const {sources,calls}=service({'https://media.example.org/file.mp4':{type:'video/mp4',length:1024,body:Buffer.alloc(0)}});
 const output=await sources.discover({url:'https://media.example.org/file.mp4'});assert.equal(output.kind,'media');assert.equal(output.media.kind,'video');assert.equal(calls[0].options.inspectMedia,true);assert.equal(output.document,undefined);
});
test('oversized and overlong enclosures are refused before media download',async()=>{
 for(const changed of [rss.replace('length="1024"',`length="${PODCAST_LIMITS.mediaBytes+1}"`),rss.replace('01:02:03','07:00:00')]){
  const {sources,calls}=service({[feedUrl]:{type:'application/rss+xml',body:Buffer.from(changed)}}),feed=await sources.discover({url:feedUrl});
  await assert.rejects(sources.downloadMedia({feedUrl,episodeId:feed.episodes[0].id,mediaUrl:feed.episodes[0].media[0].url}));assert.equal(calls.some(c=>c.url.includes('media.example')),false);
 }
});
test('module concurrency is bounded and failure releases its slot',async()=>{
 let release;const promise=new Promise(resolve=>release=resolve);
 const sources=createPodcastSources({fetchResource:async()=>{await promise;throw new Error('fixture done');}});
 const one=sources.discover({url:feedUrl}),two=sources.discover({url:feedUrl});await assert.rejects(sources.discover({url:feedUrl}),/最多同时/);
 release();await assert.rejects(one,/fixture done/);await assert.rejects(two,/fixture done/);await assert.rejects(sources.discover({url:feedUrl}),/fixture done/);
});

const xyId='6ab0922a0916f6f8b4468234',xyShow='699921e13ae08cdf3348fdd6',xyUrl='https://www.xiaoyuzhoufm.com/episode/'+xyId;
const xyEpisode={eid:xyId,pid:xyShow,title:'原创小宇宙协议测试',duration:20,status:'NORMAL',payType:'FREE',isPrivateMedia:false,
 media:{size:100,mimeType:'audio/mp4',source:{mode:'PUBLIC',url:'https://media.example.org/test.m4a'}},enclosure:{url:'https://media.example.org/test.m4a'},shownotes:'This is not a transcript',transcript:{mediaId:'no timed text URL'}};
const xyPage=episode=>'<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({props:{pageProps:{episode}}})+'</script>';
test('verified Xiaoyuzhou public page supplies only explicitly free/nonprivate/PUBLIC episode media, never notes as transcript',async()=>{
 const {sources,calls}=service({[xyUrl]:{type:'text/html',body:Buffer.from(xyPage(xyEpisode))},'https://media.example.org/test.m4a':{type:'audio/mp4',body:Buffer.from('audio fixture')}});
 const found=await sources.discover({url:xyUrl});assert.equal(found.source_type,'xiaoyuzhou_public_page');assert.equal(found.episodes.length,1);assert.equal(found.episodes[0].transcripts.length,0);
 const result=await sources.importEpisode({feedUrl:xyUrl,episodeId:found.episodes[0].id});assert.equal(result.status,'needs_transcription');assert.equal(result.document,undefined);
 const media=await sources.downloadMedia({feedUrl:xyUrl,episodeId:found.episodes[0].id,mediaUrl:found.episodes[0].media[0].url});assert.equal(media.kind,'audio');assert.equal(calls.filter(c=>c.url===xyUrl).length,3);
});
test('Xiaoyuzhou missing gates, paid/private/preview sources, signed media, mismatched page ID and page redirect cannot authorize playback',()=>{
 for(const change of [{payType:undefined},{payType:'PAID'},{isPrivateMedia:undefined},{isPrivateMedia:true},{status:'DELETED'},
  {media:{...xyEpisode.media,source:{mode:'PRIVATE',url:xyEpisode.enclosure.url}}},
  {media:{...xyEpisode.media,source:{mode:'PUBLIC',url:'https://example.org/a.m4a?token=secret'}},enclosure:{url:'https://example.org/a.m4a?token=secret'}},
  {enclosure:{url:'https://other.example.org/preview.m4a'}},{eid:'0'.repeat(24)}])assert.throws(()=>parseXiaoyuzhouPage(xyPage({...xyEpisode,...change}),xyUrl));
 assert.throws(()=>parseXiaoyuzhouPage(xyPage(xyEpisode),'https://attacker.example.org/episode/'+xyId));
});
test('Xiaoyuzhou changed access gates are checked anew immediately before import or media download',async()=>{
 let reads=0;const sources=createPodcastSources({fetchResource:async url=>{assert.equal(url,xyUrl);return {url,type:'text/html',body:Buffer.from(xyPage({...xyEpisode,payType:++reads===1?'FREE':'VIP'}))};}});
 const feed=await sources.discover({url:xyUrl});await assert.rejects(sources.downloadMedia({feedUrl:xyUrl,episodeId:feed.episodes[0].id,mediaUrl:feed.episodes[0].media[0].url}),/没有同时明确/);assert.equal(reads,2);
});
test('Xiaoyuzhou show discovery is a bounded displayed episode list with explicit selection, and advertised RSS remains selectable',async()=>{
 const url='https://www.xiaoyuzhoufm.com/podcast/'+xyShow;
 const page='<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({props:{pageProps:{podcast:{pid:xyShow,title:'Show',episodes:[xyEpisode]}}}})+'</script>';
 const output=parseXiaoyuzhouPage(page,url);assert.equal(output.episodes.length,1);assert.equal(output.truncated,true);
 const {sources}=service({[url]:{type:'text/html',body:Buffer.from(page+'<link rel="alternate" type="application/rss+xml" href="https://publisher.example.org/feed.xml">')}});
 assert.equal((await sources.discover({url})).kind,'choices');
});
test('namespace maps are structurally shared and per-node attributes and inherited namespaces are bounded',()=>{
 const declarations=Array.from({length:70},(_,i)=>`xmlns:n${i}="https://example.org/ns/${i}"`).join(' ');
 assert.throws(()=>parseXml('<rss '+declarations+'/>',feedUrl),/过多/);
 const tree=parseXml('<rss xmlns:p="https://example.org/p"><channel><p:x/></channel></rss>',feedUrl);
 assert.equal(Object.getPrototypeOf(tree.children[0].ns),tree.ns);assert.equal(tree.children[0].children[0].uri,'https://example.org/p');
});
test('malformed timed-text blocks never silently import partial or incorrectly joined transcripts',()=>{
 const good='00:00.000 --> 00:01.000\nFirst';
 for(const broken of ['00:02.000 -> 00:03.000\nDropped text','invalid --> invalid','00:02.000 --> 00:03.000'])assert.throws(()=>parsePublisherTranscript('WEBVTT\n\n'+good+'\n\n'+broken,'text/vtt'));
 assert.throws(()=>parsePublisherTranscript('WEBVTT\n\n'+good+'\n00:02.000 --> 00:03.000\nSecond','text/vtt'));
 assert.throws(()=>parsePublisherTranscript('1\n'+good+'\n\nBroken cue','application/x-subrip'));
});
test('Xiaoyuzhou gate metadata ignores comments and inert HTML rather than trusting stale examples',()=>{
 const paid=xyPage({...xyEpisode,payType:'PAID'}),free=xyPage(xyEpisode);
 for(const prefix of ['<!--'+free+'-->','<template>'+free+'</template>','<textarea>'+free+'</textarea>','<noscript>'+free+'</noscript>'])assert.throws(()=>parseXiaoyuzhouPage(prefix+paid,xyUrl),/没有同时明确/);
 assert.throws(()=>parseXiaoyuzhouPage(free+paid,xyUrl),/重复/);
 const link='<link rel="alternate" type="application/rss+xml" href="https://example.org/feed">';
 for(const tag of ['textarea','template','title','xmp','iframe','noscript','svg'])assert.deepEqual(publisherFeeds('<'+tag+'>'+link+'</'+tag+'>',feedUrl),[]);
});
test('legacy namespace used by the actual Podcasting 2.0 publisher is supported explicitly',()=>{
 const legacy=rss.replace('https://podcastindex.org/namespace/1.0','https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md');assert.equal(parsePodcastFeed(legacy,feedUrl).episodes[0].transcripts.length,2);
});
test('unterminated comments and attribute-name suffixes cannot manufacture active publisher state',()=>{
 const free=xyPage(xyEpisode);
 for(const markup of ['<!-- example > '+free,free.replace(' id=',' 0id=').replace(' type=',' 0type='),'<div title="unclosed>'+free])assert.throws(()=>parseXiaoyuzhouPage(markup,xyUrl));
 assert.deepEqual(publisherFeeds('<!-- example > <link rel="alternate" type="application/rss+xml" href="https://example.org/feed">',feedUrl),[]);
 assert.deepEqual(publisherFeeds('<link 0rel="alternate" 0type="application/rss+xml" 0href="https://example.org/feed">',feedUrl),[]);
});
test('WebVTT header is recognized only as the exact first block',()=>{
 for(const block of ['WEBVTTbroken\nLost sentence','WEBVTT\nLost sentence','WEBVTT lost sentence'])assert.throws(()=>parsePublisherTranscript('WEBVTT\n\n00:00.000 --> 00:01.000\nValid\n\n'+block,'text/vtt'));
});
test('malformed repeated HTML openers and long unterminated attributes are bounded scans',()=>{
 for(const text of ['<a "'.repeat(32768),'<'+ 'a'.repeat(131072),'<div title="'+ 'a'.repeat(131072)])assert.deepEqual(publisherFeeds(text,feedUrl),[]);
 const literal='<'.repeat(131072);assert.throws(()=>parsePublisherTranscript('WEBVTT\n\n00:00.000 --> 00:01.000\n'+literal,'text/vtt'),/正文无效/);
});

const voiceFixtures=JSON.parse(await readFile(new URL('./fixtures/vtt-voices.json',import.meta.url),'utf8'));
for(const fixture of voiceFixtures)test('publisher WebVTT shares voice payload semantics: '+fixture.name,()=>{
 const result=parsePublisherTranscript('WEBVTT\n\nvoice-cue\n00:01.125 --> 00:03.875 align:start\n'+fixture.payload+'\n','text/vtt');
 assert.deepEqual(result,[{id:'segment-1',start:1.125,end:3.875,text:fixture.text,speaker:fixture.speaker}]);
});

test('publisher VTT never collapses distinct voices that share a long name prefix',()=>{
 const prefix='A'.repeat(120);
 const input='WEBVTT\n\n00:01.000 --> 00:02.000\n<v '+prefix+'Alice>One</v>\n\n00:02.000 --> 00:03.000\n<v '+prefix+'Bob>Two</v>';
 assert.deepEqual(parsePublisherTranscript(input,'text/vtt').map(cue=>cue.speaker),[prefix+'Alice',prefix+'Bob']);
 // Keep the existing bounded JSON publisher normalization unchanged.
 assert.equal(parsePublisherTranscript(JSON.stringify({segments:[{start:1,end:2,text:'Source',speaker:prefix+'Alice'}]}),'application/json')[0].speaker,prefix);
});
