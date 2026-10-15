// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import {createRequire} from 'node:module';

import {passageReadingFixture} from './helpers/passage-reading-fixture.mjs';

const C=createRequire(import.meta.url)('../reader/core.js');

function fixture(title='Authored passage questions') {const doc=passageReadingFixture();doc.title=title;doc.segments=doc.segments.slice(0,120);return doc;}

test('malformed or out-of-order scoped evidence cannot be treated as current or silently kept in backups',()=>{
 const doc=C.validate(fixture());const scope={kind:'passage',passage_ids:['split-0'],expanded:false,source_title:doc.title,source_url:doc.source_url||'',source_language:doc.language,provider:'codex',answer_language:'zh',cues:[{id:'split-0',start:0,end:.8,speaker:doc.segments[0].speaker??null}]};
 for(const invalid of [{...scope,passage_ids:['missing']},{...scope,cues:[{...scope.cues[0],start:-1}]},{...scope,cues:[{...scope.cues[0],id:'split-1'}]}]){
  const answer={question:'q',answer:'a',citations:['split-0'],input_snapshot:{version:1,segments:[{id:'split-0',text:doc.segments[0].text}],scope:invalid}};assert.equal(C.answerFreshness(answer,doc),'unknown');assert.equal(C.validate({...doc,ai_answers:[answer]}).ai_answers[0].input_snapshot,undefined);
 }
});

test('inserting a new cue inside the captured passage makes historical scope stale',()=>{
 const doc=C.validate(fixture()),cue=doc.segments[0],next=doc.segments[1];const input={version:1,segments:[cue,next].map(({id,text})=>({id,text})),scope:{kind:'passage',passage_ids:[cue.id,next.id],expanded:false,source_title:doc.title,source_url:doc.source_url||'',source_language:doc.language,provider:'codex',answer_language:'zh',cues:[cue,next].map(({id,start,end,speaker})=>({id,start,end,speaker:speaker??null}))}};
 assert.equal(C.answerFreshness({input_snapshot:input},doc),'current');doc.segments.splice(1,0,{id:'inserted',text:'An inserted source cue',start:.1,end:.2,speaker:cue.speaker});assert.equal(C.answerFreshness({input_snapshot:input},doc),'stale');
});

function legacyPassageEvidenceEnvelope(){
 const segments=Array.from({length:48},(_,index)=>({id:'cue-'+index,start:index,end:index+1,text:'x',speaker:'s'.repeat(1000)}));
 let remaining=2200000-segments.reduce((count,cue)=>count+cue.id.length+cue.text.length,0);
 for(const cue of segments){const extra=Math.min(999999,remaining);cue.text+='x'.repeat(extra);remaining-=extra;}
 assert.equal(remaining,0);
 const doc=C.validate({title:'t'.repeat(4000),source_url:'u'.repeat(4000),language:'l'.repeat(4000),segments});
 const input={version:1,segments:doc.segments.map(({id,text})=>({id,text})),scope:{kind:'passage',passage_ids:doc.segments.slice(0,16).map(cue=>cue.id),expanded:true,source_title:doc.title,source_url:doc.source_url,source_language:doc.language,provider:'p'.repeat(4000),answer_language:'a'.repeat(4000),cues:doc.segments.map(({id,start,end,speaker})=>({id,start,end,speaker}))}};
 return {doc,input,answer:{question:'Legacy question',answer:'Legacy answer',citations:['cue-0'],purpose:'question',input_snapshot:input}};
}

test('the entire previously accepted passage-evidence envelope survives without trimming and total +1 is rejected',()=>{
 const {doc,input,answer}=legacyPassageEvidenceEnvelope();
 assert.equal(C.answerInputCharacters(input),2268000);assert.equal(C.ANSWER_INPUT_CHARACTERS,2268000);
 assert.equal(C.answerFreshness(answer,doc),'current');
 assert.deepEqual(C.parse(JSON.stringify({...doc,ai_answers:[answer]}),'legacy.json').ai_answers[0].input_snapshot,input);
 input.scope.source_url+='x';
 assert.equal(C.answerFreshness(answer,doc),'unknown');
 assert.equal(C.validate({...doc,ai_answers:[answer]}).ai_answers[0].input_snapshot,undefined);
 input.segments[0].text=input.segments[0].text.slice(1);doc.segments[0].text=doc.segments[0].text.slice(1);doc.source_url+='x';
 assert.equal(C.answerInputCharacters(input),2268000);assert.equal(C.answerFreshness(answer,doc),'current','metadata shares a bounded envelope, not a 4,000-character field cutoff');
 const overSource=legacyPassageEvidenceEnvelope();overSource.input.segments.at(-1).text+='x';overSource.input.scope.source_url=overSource.input.scope.source_url.slice(1);
 assert.equal(C.answerInputCharacters(overSource.input),2268000);assert.equal(C.validate({...overSource.doc,ai_answers:[overSource.answer]}).ai_answers[0].input_snapshot,undefined,'the independent 2.2M original source budget still applies');
});
