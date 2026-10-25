import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),C=require('../reader/core.js');
const source=()=>({title:'Global voices',provenance:{audio_pipeline:'audio-pipeline-v1',audio_chunks:'18'},segments:[
 {id:'a',start:601,end:603,text:'Original words',speaker:'说话人 1',speaker_id:'speaker-0001',
  speaker_status:'automatic_unreviewed',chunk_index:1,provider_speaker:'1:speaker_9',
  words:[{start:601,end:602,word:'Original'},{start:602,end:603,word:' words'}]},
 {id:'b',start:7201,end:7203,text:'再次出现',speaker:'说话人 1',speaker_id:'speaker-0001',speaker_status:'automatic_unreviewed',chunk_index:12}
]});

test('global IDs, independent display names and word clocks survive correction and JSON restore',()=>{
 let doc=C.validate(source());
 const plan=C.createSpeakerCorrectionPreview(doc,{cueId:'a',scope:'speaker',action:'rename',speaker:'主持人'});
 C.applySpeakerCorrectionPreview(doc,plan);
 doc=C.parse(JSON.stringify(doc),'backup.json');
 assert.deepEqual(doc.segments.map(s=>s.speaker_id),['speaker-0001','speaker-0001']);
 assert.deepEqual(doc.segments.map(s=>s.speaker),['主持人','主持人']);
 assert.deepEqual(doc.segments[0].words,source().segments[0].words);
 assert.equal(doc.segments[0].provider_speaker,'1:speaker_9');
 assert.equal(doc.provenance.audio_pipeline,'audio-pipeline-v1');
});

test('invalid recording IDs and word times cannot become playback evidence',()=>{
 for(const mutate of [d=>d.segments[0].speaker_id='speaker_0',d=>d.segments[0].words[0].end=900,
                      d=>d.segments[0].words[1].start=600,d=>d.segments[0].words='bad']){
  const doc=source();mutate(doc);assert.throws(()=>C.validate(doc));
 }
 const doc=source();doc.segments[0].speaker_id=null;doc.segments[0].speaker=null;
 assert.equal(C.validate(doc).segments[0].speaker_id,null);
});
