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

test('native segment timing and scoped speakers survive JSON import without invented word clocks',()=>{
 const raw={title:'Native transcript',segments:[{id:'a',start:0,end:4,text:'本地原生转录',speaker:'第1块 · S01',
  speaker_id:'speaker-0001',speaker_status:'native_chunk_local',speaker_scope:'chunk',chunk_index:0,
  provider_speaker:'0:S01',timing_basis:'native_segment',alignment_status:'unavailable'}]};
 const doc=C.parse(JSON.stringify(C.validate(raw)),'native.json'),cue=doc.segments[0];
 for(const field of ['speaker_scope','speaker_status','chunk_index','provider_speaker','timing_basis','alignment_status'])assert.equal(cue[field],raw.segments[0][field]);
 assert.equal(Object.hasOwn(cue,'words'),false);
 for(const scope of ['segment','global',null,1]){const bad=structuredClone(raw);bad.segments[0].speaker_scope=scope;assert.throws(()=>C.validate(bad),/作用域/);}
 const single=structuredClone(raw);single.segments[0].speaker_scope='recording';assert.equal(C.validate(single).segments[0].speaker_scope,'recording');
});

test('renaming a native chunk speaker cannot cross chunks even if their display labels coincide',()=>{
 const raw={title:'Scoped speakers',segments:[
  {id:'a',start:0,end:1,text:'第一块开场',speaker:'S01',speaker_id:'speaker-0001',speaker_scope:'chunk',chunk_index:0},
  {id:'b',start:1,end:2,text:'第一块继续',speaker:'S01',speaker_id:'speaker-0001',speaker_scope:'chunk',chunk_index:0},
  {id:'c',start:1800,end:1801,text:'另一块的编号',speaker:'S01',speaker_id:'speaker-0002',speaker_scope:'chunk',chunk_index:1}
 ]};
 const doc=C.validate(raw),plan=C.createSpeakerCorrectionPreview(doc,{cueId:'a',scope:'speaker',action:'rename',speaker:'主持人'});
 assert.equal(plan.total,2);C.applySpeakerCorrectionPreview(doc,plan);
 assert.deepEqual(doc.segments.map(c=>c.speaker),['主持人','主持人','S01']);
 assert.deepEqual(doc.segments.map(c=>c.speaker_id),raw.segments.map(c=>c.speaker_id));
 assert.deepEqual(doc.segments.map(c=>[c.start,c.end,c.speaker_scope]),raw.segments.map(c=>[c.start,c.end,c.speaker_scope]));
 const fresh=C.validate(raw),stale=C.createSpeakerCorrectionPreview(fresh,{cueId:'a',scope:'cue',action:'rename',speaker:'嘉宾'});
 fresh.segments[0].speaker_scope='recording';assert.throws(()=>C.applySpeakerCorrectionPreview(fresh,stale),/已变化/);
});

test('real Python seam recovery survives sentence splitting, acoustic assignment and JSON import',async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{fileURLToPath}=await import('node:url');
 const root=fileURLToPath(new URL('../',import.meta.url));
 const script=`import json
from tests.test_seam_recovery import fixture
from audio_pipeline import owned_segments,stitch_segments
from seam_recovery import recover_seam
from transcription import sentence_segments
from audio_speakers import fuse_speakers
from transcript import make_document
a,left,b,right=fixture()
extra,trace=recover_seam(a,left,b,right)
segments=sorted(stitch_segments(owned_segments(a,left,160000)+owned_segments(b,right,160000))+extra,key=lambda s:s['start'])
segments=sentence_segments(segments)
segments=fuse_speakers(segments,[{'start':0,'end':10,'speaker_id':'speaker-0001'}])
print(json.dumps(make_document({'segments':segments,'seam_recovery':trace},'Seam fixture','')))`;
 const {stdout}=await promisify(execFile)('python3',['-B','-c',script],{cwd:root,timeout:15000});
 const raw=JSON.parse(stdout),doc=C.parse(JSON.stringify(C.validate(raw)),'backup.json');
 assert.equal(doc.segments.map(s=>s.text).join(''),'成为合伙人。嗯');
 const recovered=doc.segments.find(s=>s.boundary_status==='seam-consensus-v1');
 assert.equal(recovered.text,'人。');assert.equal(recovered.speaker,null);assert.equal(recovered.speaker_id,null);
 assert.equal(recovered.speaker_status,'seam_recovered_unknown');
 assert.deepEqual(doc.seam_recovery,raw.seam_recovery);
 assert.equal(doc.seam_recovery.length,1);
 assert.equal(doc.seam_recovery[0].sources.length,2);
 const before=JSON.stringify(raw.seam_recovery);doc.seam_recovery[0].sources[0].word='edited';assert.equal(JSON.stringify(raw.seam_recovery),before);
});
