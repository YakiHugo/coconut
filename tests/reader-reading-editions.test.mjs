import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {Window} from 'happy-dom';
const require=createRequire(import.meta.url),E=require('../reader/editions.js'),C=require('../reader/core.js');
const createdAt='2026-10-30T08:00:00.000Z';
const fixture=()=>({...C.validate({title:'自写访谈',language:'zh',source_url:'https://example.test/interview',notes:{a:'笔记'},segments:[
 {id:'a',start:0,end:2,text:'你为什么开始？',speaker:'采访者'},
 {id:'b',start:2,end:5,text:'我我觉得，呃，值得试试。',speaker:'嘉宾'},
 {id:'c',start:5,end:8,text:'但也可能失败。',speaker:'嘉宾'},
 {id:'d',start:12,end:13,text:'嗯。',speaker:null}
]}),key:'interview'});
const create=doc=>E.create(doc,{id:'edition-1',snapshotId:'snapshot-1',createdAt});
test('interview drafts group source turns without deleting words, guessing unknown speakers or modifying the document',()=>{
 const doc=fixture(),original=structuredClone(doc),next=create(doc),state=next.reading_editions;
 assert.equal(JSON.stringify(doc),JSON.stringify(original));assert.equal(state.editions[0].blocks.length,3);
 assert.deepEqual(state.editions[0].blocks[1].source_refs,['b','c']);
 assert.equal(E.resolve(next,state.editions[0],state.editions[0].blocks[2]).speaker,null);
 assert.equal(E.freshness(next,state.editions[0]),'current');assert.equal(next.segments,doc.segments);
 assert.deepEqual(C.parse(JSON.stringify(next),'backup.json').reading_editions,state);
});
test('editing is isolated from source cues, translations, notes and source excerpts; stale editor revisions are refused',()=>{
 let doc=create(fixture());doc.segments[1].translations={en:{text:'I think it is worth trying.',source_text:doc.segments[1].text,provider:'user'}};
 const before=structuredClone(doc),block=doc.reading_editions.editions[0].blocks[1];
 doc=E.edit(doc,'edition-1',block.id,{heading:'为什么尝试',text:'我觉得值得试试。\n\n但也可能失败。'},1);
 assert.equal(JSON.stringify(doc.segments),JSON.stringify(before.segments));assert.equal(JSON.stringify(doc.notes),JSON.stringify(before.notes));
 assert.equal(doc.reading_editions.editions[0].revision,2);
 assert.equal(E.freshness(doc,doc.reading_editions.editions[0]),'current');
 assert.throws(()=>E.edit(doc,'edition-1',block.id,{heading:'',text:'迟到修改'},1),/已变化/);
 assert.throws(()=>E.edit(doc,'edition-1',block.id,{heading:'',text:' '},2));
});
test('snapshots are shared between editions; personal changes do not invalidate evidence, source changes do',()=>{
 let doc=create(fixture());doc=E.create(doc,{id:'edition-2',snapshotId:'snapshot-2',createdAt});
 assert.equal(doc.reading_editions.snapshots.length,1);
 const edition=doc.reading_editions.editions[0];doc.title='New title';doc.notes.a='Later note';doc.readingPosition='b';
 assert.equal(E.freshness(doc,edition),'current');
 for(const mutate of [d=>d.segments[1].text+='改字',d=>d.segments[1].speaker='其他人',d=>d.segments[1].start=2.1,d=>d.segments[1].speaker_id='speaker-0001',d=>d.source_url='https://example.test/other']){const next=structuredClone(doc);mutate(next);assert.equal(E.freshness(next,next.reading_editions.editions[0]),'stale');}
});
test('source resolver preserves separate playback ranges across gaps',()=>{
 const doc=create(fixture()),edition=doc.reading_editions.editions[0];
 const evidence=E.resolve(doc,edition,{source_refs:['a','c','d']});
 assert.deepEqual(evidence.ranges,[{start:0,end:2},{start:5,end:8},{start:12,end:13}]);
 assert.equal(evidence.speaker,null);assert.deepEqual(evidence.cues.map(cue=>cue.id),['a','c','d']);
 doc.segments[0].text='changed';assert.equal(E.resolve(doc,edition,edition.blocks[0]).current,false);
 assert.equal(E.resolve(doc,edition,edition.blocks[0]).cues[0].text,'你为什么开始？');
});
test('edited excerpts freeze edited wording and source references separately, surviving later edits and source changes',()=>{
 let doc=create(fixture()),block=doc.reading_editions.editions[0].blocks[1];
 doc=E.edit(doc,'edition-1',block.id,{heading:'',text:'我觉得值得试试。'},1);
 doc=E.excerpt(doc,'edition-1',block.id,0,8,{id:'excerpt-1',createdAt,expectedText:'我觉得值得试试。'});
 const excerpt=structuredClone(doc.reading_editions.excerpts[0]);
 assert.equal(excerpt.text,'我觉得值得试试。');assert.deepEqual(excerpt.source_refs,['b','c']);
 assert.equal(doc.exact_excerpts,undefined);
 doc=E.edit(doc,'edition-1',block.id,{heading:'',text:'后来重新整理的文字。'},2);doc.segments[1].text='新来源';
 assert.deepEqual(C.parse(JSON.stringify(doc),'restore.json').reading_editions.excerpts[0],excerpt);
 assert.throws(()=>E.excerpt(doc,'edition-1',block.id,0,8,{id:'late',createdAt,expectedText:excerpt.block_text}),/已变化/);
});
test('broken or future edition data is rejected on import rather than silently stripped',()=>{
 const original=create(fixture());
 for(const mutate of [d=>d.reading_editions.version=2,d=>d.reading_editions.snapshots=[],d=>d.reading_editions.editions[0].blocks[0].source_refs=['missing'],d=>d.reading_editions.editions[0].blocks.reverse(),d=>d.reading_editions.editions[0].blocks[0].paragraphs=[],d=>d.reading_editions.editions[0].blocks[0].paragraphs=[''],d=>d.reading_editions.editions[0].blocks[0].source_refs.push('a')]){const d=structuredClone(original);mutate(d);assert.throws(()=>C.validate(d));}
});
test('saved edition position and exports refer to the edition, while subtitle export remains verbatim',()=>{
 let doc=create(fixture());doc=E.edit(doc,'edition-1','block-2',{heading:'尝试',text:'我觉得值得尝试。'},1);doc=E.bookmark(doc,'edition-1','block-2');
 assert.deepEqual(C.validate(doc).reading_editions.position,{edition_id:'edition-1',block_id:'block-2'});
 assert.match(E.markdown(doc,'edition-1'),/## 尝试/);assert.match(E.markdown(doc,'edition-1'),/我觉得值得尝试/);
 assert.match(C.subtitleExport(doc,'srt').text,/我我觉得，呃，值得试试/);
 assert.throws(()=>E.bookmark(doc,'edition-1','missing'));
});
test('long uninterrupted speakers stay editable in bounded blocks without dropping or duplicating source',()=>{
 const doc=fixture();doc.segments=Array.from({length:2500},(_,i)=>({id:'cue-'+i,start:i,end:i+1,text:'完整论据与具体例子。'.repeat(10),speaker:'讲述者'}));
 const next=create(doc),blocks=next.reading_editions.editions[0].blocks;
 assert.ok(blocks.length>1);assert.ok(blocks.every(block=>E.blockText(block).length<=60000));
 assert.deepEqual(blocks.flatMap(block=>block.source_refs),doc.segments.map(cue=>cue.id));
 assert.doesNotThrow(()=>E.edit(next,'edition-1',blocks[0].id,{heading:'',text:E.blockText(blocks[0])},1));
});
const output=await build({entryPoints:['frontend/reader-workspace/domain.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const D=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
test('source selections reject edited DOM; edition selections use the actual edited text and reject cross-block selections',async()=>{
 const win=new Window(),host=win.document.createElement('div');win.document.body.append(host);
 const doc=fixture();host.innerHTML='<p data-source-id="b">我觉得值得试试。</p>';
 const range=win.document.createRange();range.selectNodeContents(host.firstChild);win.getSelection().addRange(range);
 assert.equal(D.captureSourceSelection(host,doc,win.getSelection(),()=>''),null);
 host.innerHTML='<div data-edition-block-id="one"><p>第一段。</p>\n\n<p>第二段。</p></div><div data-edition-block-id="two">另一段。</div>';
 const blocks=[{id:'one',paragraphs:['第一段。','第二段。']},{id:'two',paragraphs:['另一段。']}];
 win.getSelection().removeAllRanges();range.selectNodeContents(host.firstChild);win.getSelection().addRange(range);
 const selection=D.captureEditionSelection(host,blocks,win.getSelection());assert.equal(selection.text,'第一段。\n\n第二段。');assert.equal(selection.from,0);
 range.setEnd(host.lastChild.firstChild,3);assert.equal(D.captureEditionSelection(host,blocks,win.getSelection()),null);
 await win.happyDOM.close();
});
