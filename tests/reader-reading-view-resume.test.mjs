// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import {pathToFileURL} from 'node:url';

const VIEW='coconut-reading-view-v1';

const SHARED='coconut-reading-view-defaults-v1';

const sourceRoot=process.env.COCONUT_BASE_SOURCE?pathToFileURL(process.env.COCONUT_BASE_SOURCE+'/'):new URL('../',import.meta.url);

function storage(){const values=new Map(),writes=[];return {values,writes,getItem:key=>values.get(key)??null,setItem(key,value){writes.push(key);values.set(key,String(value));},removeItem:key=>values.delete(key)};}

test('bounded preferences hold only valid cue/mode tuples, preserve unrelated windows and tolerate corrupt/denied storage',async()=>{
 const {default:Coconut}=await import(new URL('reader/core.js',sourceRoot));const disk=storage(),session=storage(),a=Coconut.createReadingViews({getStorage:()=>disk,getSessionStorage:()=>session,limit:3});
 a.record('a','cue-a','transcript');a.record('b','cue-b','passages');a.record('c','cue-c','summary');a.record('d','cue-d','transcript');assert.deepEqual(JSON.parse(session.getItem(VIEW)).views.map(v=>v[0]),['b','c','d']);
 const otherSession=storage(),b=Coconut.createReadingViews({getStorage:()=>disk,getSessionStorage:()=>otherSession,limit:3});assert.deepEqual(b.get('d'),{cueId:'cue-d',mode:'transcript'});b.record('d','other-cue','passages');assert.deepEqual(a.get('d'),{cueId:'cue-d',mode:'transcript'});a.record('c','new-cue','transcript');assert.equal(b.get('d').cueId,'other-cue');assert.ok(JSON.parse(disk.getItem(SHARED)).views.some(v=>v[0]==='d'&&v[1]==='other-cue'));
 session.setItem(VIEW,JSON.stringify({version:1,views:[['valid','cue','summary'],['bad','cue','invalid'],['extra','cue','transcript','private'],['long','x'.repeat(1025),'transcript'],[null,'cue','transcript']]}));const clean=Coconut.createReadingViews({getStorage:()=>storage(),getSessionStorage:()=>session});assert.equal(clean.get('valid').mode,'summary');for(const key of ['bad','extra','long'])assert.equal(clean.get(key),null);
 session.setItem(VIEW,'broken');const denied=Coconut.createReadingViews({getStorage(){throw Error('denied');},getSessionStorage(){throw Error('denied');}});assert.doesNotThrow(()=>denied.record('safe','cue','transcript'));assert.equal(denied.get('safe').cueId,'cue');assert.doesNotThrow(()=>denied.remove('safe'));assert.equal(denied.get('safe'),null);
 a.remove('d');assert.equal(a.get('d'),null);assert.equal(JSON.parse(session.getItem(VIEW)).views.some(v=>v[0]==='d'),false);
});

test('empty cue IDs remain valid source anchors and the default preference cap is 512 entries',async()=>{
 const {default:Coconut}=await import(new URL('reader/core.js',sourceRoot));const disk=storage(),session=storage(),views=Coconut.createReadingViews({getStorage:()=>disk,getSessionStorage:()=>session});
 views.record('empty','','transcript');assert.deepEqual(views.get('empty'),{cueId:'',mode:'transcript'});for(let i=0;i<600;i++)views.record('doc-'+i,'cue-'+i,'passages');assert.equal(JSON.parse(session.getItem(VIEW)).views.length,512);assert.equal(JSON.parse(disk.getItem(SHARED)).views.length,512);assert.equal(views.get('doc-0'),null);
});

test('successful shared-hint removal or clear retires unowned cached defaults; denied reads retain memory and owned views stay independent',async()=>{
 const {default:Coconut}=await import(new URL('reader/core.js',sourceRoot)),disk=storage(),a=Coconut.createReadingViews({getStorage:()=>disk,getSessionStorage:()=>storage()});
 a.record('a','cue-a','transcript');let denied=false;
 const b=Coconut.createReadingViews({getStorage(){if(denied)throw Error('Read denied');return disk;},getSessionStorage:()=>storage()});
 const owner=Coconut.createReadingViews({getStorage:()=>disk,getSessionStorage:()=>storage()});owner.record('a','my-cue','passages');
 assert.deepEqual(b.get('a'),{cueId:'my-cue',mode:'passages'});denied=true;a.remove('a');assert.deepEqual(b.get('a'),{cueId:'my-cue',mode:'passages'},'failed reads retain the last bounded default');
 denied=false;assert.equal(b.get('a'),null,'a readable empty map retires an unowned cached hint');assert.deepEqual(owner.get('a'),{cueId:'my-cue',mode:'passages'},'the other window own view remains independent');
 a.record('a','replacement','transcript');assert.equal(b.get('a').cueId,'replacement');disk.removeItem(SHARED);assert.equal(b.get('a'),null,'clearing the preference is a successful absent read');
 a.record('a','newer','summary');assert.equal(b.get('a').cueId,'newer');disk.setItem(SHARED,'invalid JSON');assert.equal(b.get('a'),null,'readable corrupt data does not resurrect an obsolete hint');
});
