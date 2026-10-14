import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';

function setup(){
 const env=libraryHarness(largeLibraryFixture(1,{cues:20}),{probe:true});
 env.$('mode-transcript').click();
 env.$('transcript').querySelector('.note-button').click();
 env.$('note').value='Saved thought';env.$('note').oninput();
 return env;
}
function escape(env,node,options={}){
 const event=new env.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,...options});
 node.dispatchEvent(event);return event;
}
for(const kind of ['composing','legacy229','composition-session','prevented','repeat','ctrl','alt','meta'])test(`Escape preserves note editor during ${kind}`,async()=>{
 const e=setup();try{
  const {w,$}=e,node=$('note');node.setSelectionRange(2,5);node.focus();
  const options={composing:{isComposing:true},legacy229:{keyCode:229},repeat:{repeat:true},ctrl:{ctrlKey:true},alt:{altKey:true},meta:{metaKey:true}}[kind]||{};
  if(kind==='composition-session')node.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));
  if(kind==='prevented')node.addEventListener('keydown',event=>event.preventDefault(),{once:true});
  escape(e,node,options);
  assert.equal($('notes-panel').hidden,false,'an input-owned Escape must not close the note editor');
  assert.equal(w.document.activeElement,node);assert.equal(node.value,'Saved thought');
  assert.equal(node.selectionStart,2);assert.equal(node.selectionEnd,5);
 }finally{await e.w.happyDOM.close();}
});

for(const panel of ['export','info','media'])test(`Escape preserves ${panel} during IME and handled input, then closes normally`,async()=>{
 const e=setup();try{
  const {w,$}=e;$('close-note').click();
  let node,isOpen,opener;
  if(panel==='export'){$('export-menu').open=true;node=$('export');isOpen=()=>$('export-menu').open;opener=$('export-menu').querySelector('summary');}
  else if(panel==='info'){$('reading-info').open=true;node=$('close-reading-info');isOpen=()=>$('reading-info').open;opener=$('reading-info').querySelector('summary');}
  else{$('mode-passages').click();$('toggle-reader-media').click();node=$('attach-reader-media');isOpen=()=>!$('episode-media').hidden;opener=$('toggle-reader-media');}
  node.focus();assert.equal(isOpen(),true);
  for(const options of [{isComposing:true},{keyCode:229},{repeat:true},{ctrlKey:true}]){
   assert.equal(escape(e,node,options).defaultPrevented,false);assert.equal(isOpen(),true);assert.equal(w.document.activeElement,node);
  }
  node.addEventListener('keydown',event=>event.preventDefault(),{once:true});
  assert.equal(escape(e,node).defaultPrevented,true);assert.equal(isOpen(),true);assert.equal(w.document.activeElement,node);
  node.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));
  assert.equal(escape(e,node).defaultPrevented,false);assert.equal(isOpen(),true);
  node.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true}));
  assert.equal(escape(e,node).defaultPrevented,true);assert.equal(isOpen(),false);assert.equal(w.document.activeElement,opener);
 }finally{await e.w.happyDOM.close();}
});

function pickerPanel(e,id){
 const {$}=e;$('close-note').click();
 if(id==='reading-theme'){$('reading-info').open=true;return {open:()=>$('reading-info').open,opener:$('reading-info').querySelector('summary')};}
 if(id==='subtitle-format'){$('export-menu').open=true;return {open:()=>$('export-menu').open,opener:$('export-menu').querySelector('summary')};}
 if(id==='playback-rate'){$('mode-passages').click();$('toggle-reader-media').click();return {open:()=>!$('episode-media').hidden,opener:$('toggle-reader-media')};}
 $('transcript').querySelector('.note-button').click();return {open:()=>!$('notes-panel').hidden,opener:()=>e.w.document.activeElement.className==='note-button'};
}
for(const id of ['reading-theme','subtitle-format','reading-jump','playback-rate'])test(`only the open ${id} picker retains Escape ownership`,async()=>{
 const e=setup();try{
  const {w,$}=e,panel=pickerPanel(e,id),field=$(id),matches=field.matches.bind(field);let open=true;
  // HappyDOM cannot display an OS picker. Only its :open state is modeled;
  // the real open/close keyboard journey runs in the GHA browser fixture.
  field.matches=selector=>selector===':open'?open:matches(selector);
  field.focus();assert.equal(panel.open(),true);
  assert.equal(escape(e,field).defaultPrevented,false);assert.equal(panel.open(),true);assert.equal(w.document.activeElement,field);
  open=false;
  for(const options of [{isComposing:true},{keyCode:229}]){assert.equal(escape(e,field,options).defaultPrevented,false);assert.equal(panel.open(),true);}
  field.addEventListener('keydown',event=>event.preventDefault(),{once:true});
  assert.equal(escape(e,field).defaultPrevented,true);assert.equal(panel.open(),true);assert.equal(w.document.activeElement,field);
  assert.equal(escape(e,field).defaultPrevented,true);assert.equal(panel.open(),false);
  if(typeof panel.opener==='function')assert.equal(panel.opener(),true);else assert.equal(w.document.activeElement,panel.opener);
 }finally{await e.w.happyDOM.close();}
});

test('unsupported picker state detection does not trap focus in a closed select',async()=>{
 const e=setup();try{
  const {w,$}=e,panel=pickerPanel(e,'reading-theme'),field=$('reading-theme'),matches=field.matches.bind(field);
  field.matches=selector=>{if(selector===':open')throw new w.DOMException('Unsupported selector','SyntaxError');return matches(selector);};
  field.focus();field.addEventListener('keydown',event=>event.preventDefault(),{once:true});
  escape(e,field);assert.equal(panel.open(),true);assert.equal(w.document.activeElement,field);
  escape(e,field);assert.equal(panel.open(),false);assert.equal(w.document.activeElement,panel.opener);
 }finally{await e.w.happyDOM.close();}
});

for(const boundary of ['compositionend','window-blur','document-navigation-after-compositionend'])test(`${boundary} allows ordinary Escape again`,async()=>{
 const e=setup();try{
  const {w,$}=e,node=$('note');node.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));
  escape(e,node);assert.equal($('notes-panel').hidden,false);
  if(boundary==='window-blur')w.dispatchEvent(new w.Event('blur'));
  else node.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true}));
  if(boundary==='document-navigation-after-compositionend'){
   const other=largeLibraryFixture(2,{cues:20})[1];w.libraryProbe.documents.push(other);w.libraryProbe.renderLibrary();
   w.document.querySelector('[data-document-key="'+other.key+'"] .library-open').click();
   $('mode-transcript').click();$('transcript').querySelector('.note-button').click();
  }
  const event=escape(e,$('note'));
  assert.equal(event.defaultPrevented,true);assert.equal($('notes-panel').hidden,true);assert.equal(w.document.activeElement.className,'note-button');
 }finally{await e.w.happyDOM.close();}
});

test('an ordinary Escape closes the export disclosure before the selected note',async()=>{
 const e=setup();try{
  const {w,$}=e;$('export-menu').open=true;$('export').focus();
  assert.equal(escape(e,$('export')).defaultPrevented,true);assert.equal($('export-menu').open,false);assert.equal($('notes-panel').hidden,false);
  assert.equal(escape(e,w.document.activeElement).defaultPrevented,true);assert.equal($('notes-panel').hidden,true);
  assert.equal((await w.flushContentForTest()).ok,true);assert.equal(w.libraryProbe.documents[0].notes['shelf-0-cue-0'],'Saved thought');
 }finally{await e.w.happyDOM.close();}
});

for(const boundary of ['native-modal','aria-modal','inert','other-workspace'])test(`background Escape respects ${boundary}`,async()=>{
 const e=setup();try{
  const {w,$}=e;
  if(boundary==='native-modal')$('details-dialog').showModal();
  else if(boundary==='aria-modal'){const dialog=w.document.createElement('div');dialog.setAttribute('aria-modal','true');w.document.body.append(dialog);}
  else if(boundary==='inert')$('reader-workspace').inert=true;
  else $('add-content').click();
  const focus=w.document.activeElement;
  assert.equal(escape(e,w.document).defaultPrevented,false);assert.equal($('notes-panel').hidden,false);assert.equal(w.document.activeElement,focus);
 }finally{await e.w.happyDOM.close();}
});

test('a closed appearance select lets ordinary Escape dismiss reading information',async()=>{
 const e=setup();try{
  const {w,$}=e;$('close-note').click();$('reading-info').open=true;
  const field=$('reading-theme');field.value='dark';field.focus();
  const event=escape(e,field);
  assert.equal($('reading-info').open,false);assert.equal(event.defaultPrevented,true);
  assert.equal(w.document.activeElement,$('reading-info').querySelector('summary'));
 }finally{await e.w.happyDOM.close();}
});
