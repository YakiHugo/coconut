// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);

const Coconut=require('../reader/core.js');

const localSource={version:1,kind:'audio',name:'Original.wav',size:64,last_modified:7,type:'audio/wav',fingerprint:'a'.repeat(64)};

const project=(overrides={})=>({project_kind:'audio_only',title:'Local authored recording',local_media_source:localSource,segments:[],...overrides});

test('local source schema admits no fake transcript, remote association, file bytes, paths, or object URLs',()=>{
 const doc=Coconut.validate(project({source_url:'blob:private',local_media_source:{...localSource,url:'blob:private',bytes:'base64-private'},ai_answers:[{text:'fake'}]}));
 assert.equal(doc.project_kind,'audio_only');assert.deepEqual(doc.local_media_source,localSource);assert.equal(doc.source_url,'');assert.deepEqual(doc.segments,[]);assert.deepEqual(doc.ai_answers,[]);
 assert.match(Coconut.audioProjectIdentity(doc),/local_media/);assert.equal(Coconut.summaryReadiness(doc).ready,false);
 for(const invalid of [{name:'/private/recording.wav'},{name:'C:\\recording.wav'},{fingerprint:'blob:private'},{size:Infinity},{last_modified:-1},{type:'x\nsecret'}])assert.throws(()=>Coconut.validate(project({local_media_source:{...localSource,...invalid}})),/本地文件信息/);
 assert.throws(()=>Coconut.validate(project({podcast_source:{kind:'direct_media',media_url:'https://example.org/a.mp3',media_kind:'audio'}})),/一个公开媒体或本地文件来源/);
 const attached=Coconut.attachProjectTranscript(doc,{title:'captions',segments:[{id:'a',start:0,end:1,text:'Actual words'}],source_media:{job_id:'b'.repeat(32),kind:'video'}});
 assert.equal(attached.local_media_source.fingerprint,localSource.fingerprint);assert.equal(attached.source_media,undefined);assert.equal(attached.podcast_source,undefined);assert.equal(attached.project_kind,undefined);
 assert.equal(Coconut.validate(attached).local_media_source.name,localSource.name);
});

test('local project language override, including explicit unknown, survives subtitle attachment',async()=>{
 for(const language of ['fr','']){
  const source=Coconut.validate(project({language,project_language_override:true}));assert.equal(source.project_language_override,true);
  const attached=Coconut.attachProjectTranscript(source,{title:'captions',language:'en',segments:[{id:'a',start:0,end:1,text:'Actual authored words'}]});
  assert.equal(attached.language,language);assert.equal(attached.project_language_override,true);assert.equal(attached.local_media_source.fingerprint,localSource.fingerprint);
 }
});
