import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {settle} from './helpers/save-pipeline.mjs';
const audio=()=>({key:'audio',title:'Recording',project_kind:'audio_only',podcast_source:{kind:'direct_media',media_url:'https://example.org/a.mp3',media_kind:'audio'},segments:[],project_note:'',timestamp_bookmarks:[{id:'b',time:90,note:'Find needle'},{id:'c',time:120,note:'Another needle'}]});
const filter=($,id,value)=>{$(id).value=value;$(id).oninput();};
const saved=w=>JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];

test('filtered bookmark edits retain the focused editor and reconcile on leaving the row, durably',async()=>{
 const {w,$}=libraryHarness([audio()],{probe:true});try{
 filter($,'audio-bookmark-search','needle');const input=$('audio-bookmarks').querySelector('textarea');input.focus();input.value='Other thought';input.setSelectionRange(5,5);input.oninput();
 assert.equal(w.document.activeElement,input);assert.equal(input.selectionStart,5);assert.equal(input.isConnected,true);
 assert.equal($('audio-bookmarks').querySelectorAll('section').length,2);
 // Leaving for another editor must not replace it or steal its focus.
 const other=$('audio-bookmarks').querySelectorAll('textarea')[1];other.focus();await settle();
 assert.equal(input.isConnected,false);assert.equal(w.document.activeElement,other);assert.match($('audio-bookmark-results').textContent,/找到 1 \/ 2/);
 other.value='No match either';other.oninput();other.blur();await settle();
 assert.match($('audio-bookmark-results').textContent,/找到 0 \/ 2/);assert.equal($('audio-bookmarks').querySelectorAll('section').length,0);assert.match($('audio-bookmarks').textContent,/没有匹配/);assert.equal(w.document.activeElement,$('audio-bookmark-search'));
 await w.flushContentForTest();assert.deepEqual(saved(w).timestamp_bookmarks.map(b=>b.note),['Other thought','No match either']);
 filter($,'audio-bookmark-search','');assert.equal($('audio-bookmarks').querySelectorAll('section').length,2);
 }finally{await w.happyDOM.close();}
});

test('leaving a note for its row actions preserves time edits, cancellation and deletion',async()=>{
 const {w,$}=libraryHarness([audio()]);try{
 filter($,'audio-bookmark-search','needle');const row=$('audio-bookmarks').firstElementChild,input=row.querySelector('textarea'),edit=row.querySelector('.edit-bookmark-time');
 input.focus();input.value='Other thought';input.oninput();edit.focus();await settle();assert.equal(row.isConnected,true);edit.click();await settle();
 const form=row.querySelector('form');form.querySelector('input').value='180';form.querySelector('button[type=button]').click();await settle();assert.equal(w.document.activeElement,edit);assert.equal(row.isConnected,true);
 row.querySelectorAll('button')[1].click();await w.flushContentForTest();assert.equal(saved(w).timestamp_bookmarks.length,1);assert.equal(w.document.activeElement,$('audio-bookmark-time'));
 }finally{await w.happyDOM.close();}
});

test('time corrections refresh shelf search snippets, local time matches, focus and persistence',async()=>{
 const {w,$}=libraryHarness([audio()]);try{
 $('library-scope').value='notes';$('library-scope').onchange();filter($,'library-search','Find needle');filter($,'audio-bookmark-search','01:30');
 assert.match(w.document.querySelector('.library-hit').textContent,/01:30/);
 $('audio-bookmarks').querySelector('.edit-bookmark-time').click();const form=$('audio-bookmarks').querySelector('form');form.querySelector('input').value='180';await form.onsubmit(new w.Event('submit',{cancelable:true}));
 assert.match(w.document.querySelector('.library-hit').textContent,/03:00/);assert.doesNotMatch(w.document.querySelector('.library-hit').textContent,/01:30/);assert.match($('audio-bookmark-results').textContent,/找到 0 \/ 2/);assert.equal(w.document.activeElement,$('audio-bookmark-search'));
 assert.equal(saved(w).timestamp_bookmarks.find(b=>b.id==='b').time,180);assert.equal(saved(w).timestamp_bookmarks.find(b=>b.id==='b').note,'Find needle');
 filter($,'audio-bookmark-search','needle');const row=$('audio-bookmarks').querySelector('[data-bookmark-id="b"]');row.querySelector('.edit-bookmark-time').click();const again=row.querySelector('form');again.querySelector('input').value='190';await again.onsubmit(new w.Event('submit',{cancelable:true}));
 assert.equal(w.document.activeElement,$('audio-bookmarks').querySelector('[data-bookmark-id="b"] .edit-bookmark-time'));assert.match(w.document.querySelector('.library-hit').textContent,/03:10/);
 }finally{await w.happyDOM.close();}
});

test('matching and rejected edits keep rows, counts and saved notes intact',async()=>{
 const {w,$}=libraryHarness([audio()]);try{
 filter($,'audio-bookmark-search','needle');const input=$('audio-bookmarks').querySelector('textarea');input.focus();input.value='Changed needle';input.oninput();$('audio-bookmark-time').focus();await settle();
 assert.equal(input.isConnected,true);assert.match($('audio-bookmark-results').textContent,/找到 2 \/ 2/);
 input.focus();input.value='x'.repeat(10001);input.oninput();$('audio-bookmark-time').focus();await settle();
 assert.equal(input.value,'Changed needle');assert.equal(input.isConnected,true);assert.match($('audio-project-status').textContent,/超过笔记容量/);
 await w.flushContentForTest();assert.equal(saved(w).timestamp_bookmarks[0].note,'Changed needle');
 }finally{await w.happyDOM.close();}
});


test('filter reconciliation retains unfinished time drafts when a nonmatching row leaves view',async()=>{
 const {w,$}=libraryHarness([audio()]);try{
 filter($,'audio-bookmark-search','needle');const row=$('audio-bookmarks').firstElementChild,input=row.querySelector('textarea');
 input.focus();input.value='Other thought';input.oninput();row.querySelector('.edit-bookmark-time').click();row.querySelector('form input').value='180';
 $('audio-bookmark-time').focus();await settle();assert.equal(row.isConnected,false);
 filter($,'audio-bookmark-search','');const form=$('audio-bookmarks').querySelector('[data-bookmark-id="b"] form');assert.equal(form.hidden,false);assert.equal(form.querySelector('input').value,'180');
 await form.onsubmit(new w.Event('submit',{cancelable:true}));assert.equal(saved(w).timestamp_bookmarks.find(b=>b.id==='b').time,180);assert.equal(saved(w).timestamp_bookmarks.find(b=>b.id==='b').note,'Other thought');
 }finally{await w.happyDOM.close();}
});

for(const action of ['time','save','delete','cancel','outside-up','outside-down','window-blur'])test('non-focusing pointer action owns the row until '+action,async()=>{
 const {w,$}=libraryHarness([audio()]);try{
 filter($,'audio-bookmark-search','needle');const row=$('audio-bookmarks').firstElementChild,note=row.querySelector('textarea');
 if(action==='save'){row.querySelector('.edit-bookmark-time').click();row.querySelector('form input').value='180';}
 const button=action==='save'?row.querySelector('button[type=submit]'):action==='delete'?row.querySelectorAll('button')[1]:row.querySelector('.edit-bookmark-time');
 note.focus();note.value='Other thought';note.oninput();
 button.dispatchEvent(new w.PointerEvent('pointerdown',{bubbles:true,button:0}));button.dispatchEvent(new w.MouseEvent('mousedown',{bubbles:true}));note.blur();await settle();
 assert.equal(button.isConnected,true,'blur must not detach the pending click target');
 if(['time','save','delete'].includes(action)){
  button.dispatchEvent(new w.PointerEvent('pointerup',{bubbles:true}));button.click();await settle();
  if(action==='time'){assert.equal(row.querySelector('form').hidden,false);assert.equal(w.document.activeElement,row.querySelector('form input'));$('audio-bookmark-time').focus();}
 }else if(action==='cancel')button.dispatchEvent(new w.PointerEvent('pointercancel',{bubbles:true}));
 else if(action==='outside-up')$('audio-bookmark-time').dispatchEvent(new w.PointerEvent('pointerup',{bubbles:true}));
 else if(action==='outside-down')$('audio-bookmark-time').dispatchEvent(new w.PointerEvent('pointerdown',{bubbles:true}));
 else w.dispatchEvent(new w.Event('blur'));
 await new Promise(resolve=>w.setTimeout(resolve,5));await settle();
 assert.equal(row.isConnected,false,'completed or cancelled interaction must not trap a stale match');assert.match($('audio-bookmark-results').textContent,action==='delete'?/找到 1 \/ 1/:/找到 1 \/ 2/);
 await w.flushContentForTest();assert.equal(saved(w).timestamp_bookmarks.some(b=>b.id==='b'),action!=='delete');if(action==='save')assert.equal(saved(w).timestamp_bookmarks.find(b=>b.id==='b').time,180);
 }finally{await w.happyDOM.close();}
});

test('native focusout listener reconciles after cancel without property-handler support',async()=>{
 // Chromium supports the bubbling event but not the onfocusout IDL property.
 // Happy DOM implements it and even dispatches arbitrary on* expandos. Mask
 // that shortcut with an inert property so only native listeners can run.
 let prototype,descriptor;
 const {w,$}=libraryHarness([audio()],{configureCore(window){
  prototype=window.HTMLElement.prototype;
  while(prototype&&!Object.hasOwn(prototype,'onfocusout'))prototype=Object.getPrototypeOf(prototype);
  if(prototype){descriptor=Object.getOwnPropertyDescriptor(prototype,'onfocusout');Object.defineProperty(prototype,'onfocusout',{configurable:true,get:()=>null,set:()=>{}});}
  const probe=window.document.createElement('section');let propertyCalled=false,eventCalled=false;
  probe.onfocusout=()=>{propertyCalled=true;};probe.addEventListener('focusout',()=>{eventCalled=true;});probe.dispatchEvent(new window.FocusEvent('focusout'));
  assert.equal(propertyCalled,false);assert.equal(eventCalled,true);
 }});
 try{
 filter($,'audio-bookmark-search','needle');const row=$('audio-bookmarks').firstElementChild,note=row.querySelector('textarea'),edit=row.querySelector('.edit-bookmark-time');
 note.focus();note.value='Other thought';note.oninput();
 edit.dispatchEvent(new w.PointerEvent('pointerdown',{bubbles:true,button:0}));note.blur();await settle();assert.equal(row.isConnected,true);
 edit.dispatchEvent(new w.PointerEvent('pointerup',{bubbles:true}));edit.click();await new Promise(resolve=>w.setTimeout(resolve,5));
 const cancel=row.querySelector('button[type=button]');cancel.dispatchEvent(new w.PointerEvent('pointerdown',{bubbles:true,button:0}));cancel.focus();cancel.dispatchEvent(new w.PointerEvent('pointerup',{bubbles:true}));cancel.click();
 await new Promise(resolve=>w.setTimeout(resolve,5));assert.equal(w.document.activeElement,edit);
 // All pointer ownership has ended. The later focusout must still be handled.
 $('audio-bookmark-time').focus();await settle();assert.equal(row.isConnected,false);assert.equal(w.document.activeElement,$('audio-bookmark-time'));assert.match($('audio-bookmark-results').textContent,/找到 1 \/ 2/);
 await w.flushContentForTest();assert.equal(saved(w).timestamp_bookmarks[0].note,'Other thought');
 }finally{if(descriptor)Object.defineProperty(prototype,'onfocusout',descriptor);await w.happyDOM.close();}
});
