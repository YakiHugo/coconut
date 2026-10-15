// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);

const C=require('../reader/core.js');

const clone=value=>JSON.parse(JSON.stringify(value));

const localSource={version:1,kind:'audio',name:'Original.wav',size:64,last_modified:7,type:'audio/wav',fingerprint:'a'.repeat(64)};

function transcript(overrides={}){
 const doc=C.validate({title:'Authored transcript',language:'en',source_url:'https://example.org/original',segments:[
  {id:'a',start:10,end:12,text:'Actual corrected opening',original_text:'Actual opening',saved_excerpt:true},
  {id:'b',start:20,end:24,text:'Actual closing'}],notes:{a:'Keep cue note'},project_note:'Keep project note',
  timestamp_bookmarks:[{id:'bookmark',time:25,note:'Keep time bookmark'}],readingPosition:'b',
  reading_chapters:[{id:'chapter',title:'Opening chapter',cue_id:'a',time:10,note:'Keep chapter note'}],
  ai_answers:[{question:'Authored old question',answer:'Authored historical answer',citations:['a'],provider:'fixture',purpose:'question'}],...overrides});
 doc.exact_excerpts=[C.exactExcerptSnapshot(doc,doc.segments.slice(0,1),[],0,6,{id:'excerpt',createdAt:'2026-10-11T00:00:00.000Z'})];
 return doc;
}

test('transcript local source roundtrips only metadata and never accepts a competing hosted source',()=>{
 const original=transcript(),doc=C.validate({...original,local_media_source:{...localSource,bytes:'private bytes',url:'blob:private',path:'/private/source.wav'}});
 assert.deepEqual(doc.local_media_source,localSource);assert.equal(doc.project_kind,undefined);assert.deepEqual(doc.segments,original.segments);
 assert.deepEqual(C.validate(clone(doc)).local_media_source,localSource);assert.doesNotMatch(JSON.stringify(doc.local_media_source),/blob:|private|bytes|path|url/);
 for(const other of [{source_media:{job_id:'b'.repeat(32),kind:'audio'}},{podcast_source:{kind:'direct_media',media_url:'https://example.org/audio.mp3',media_kind:'audio'}}])assert.throws(()=>C.validate({...doc,...other}),/本地文件来源/);
 assert.deepEqual(doc.exact_excerpts,original.exact_excerpts);assert.equal(C.exactExcerptFreshness(doc.exact_excerpts[0],doc),'stale');
});

const rawSourceFixtures=[
 ['custom-port URL','https://media.example:8443/episode?Case=X#part'],
 ['host without trailing slash','https://example.org'],
 ['opaque legacy attribution','Legacy source: shelf / tape #7?Case=X'],
 ['javascript attribution','javascript:alert("authored fixture")'],
 ['data attribution','data:text/plain,authored-source'],
 ['blob attribution','blob:https://example.org/authored-source'],
 ['file attribution','file:///authored/source.wav']
];

test('raw transcript attribution does not relax timed source links, audio-only source sanitization, or podcast URL validation',()=>{
 const unsafe=rawSourceFixtures.slice(2).map(([,value])=>value);
 for(const value of unsafe){assert.equal(C.source(value,12),'',value+' is never an executable source link');assert.equal(C.podcastURL(value),'');}
 assert.equal(C.source('https://www.youtube.com/watch?v=authored1234&Case=X&t=9#part',12.9),'https://www.youtube.com/watch?v=authored1234&Case=X&t=12');
 assert.equal(C.source('https://youtu.be/authored1234?t=9#part',12.9),'https://youtu.be/authored1234?t=12');
 assert.equal(C.source('https://youtube.com.evil.example/watch?v=authored1234',12),'');
 const audio=source_url=>C.validate({project_kind:'audio_only',title:'Authored audio-only project',segments:[],local_media_source:localSource,source_url});
 assert.equal(audio('https://example.org').source_url,'https://example.org/');assert.equal(audio('https://media.example:8443/episode?Case=X#part').source_url,'');
 for(const value of unsafe)assert.equal(audio(value).source_url,'');
 assert.equal(C.podcastURL('https://example.org'),'https://example.org/');assert.equal(C.podcastURL('https://media.example:8443/episode?Case=X#part'),'');
 assert.equal(C.podcastURL('https://user:password@example.org/episode'),'');
 assert.deepEqual(C.podcastSource({kind:'direct_media',media_url:'https://example.org',media_kind:'audio'}),{kind:'direct_media',media_url:'https://example.org/',media_kind:'audio'});
 assert.equal(C.podcastSource({kind:'direct_media',media_url:'https://media.example:8443/episode',media_kind:'audio'}),undefined);
 for(const value of unsafe)assert.equal(C.podcastSource({kind:'direct_media',media_url:value,media_kind:'audio'}),undefined);
});
