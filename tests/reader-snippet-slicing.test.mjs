/** Authored deterministic equivalence and work bounds; no timing thresholds. */
import test from 'node:test';
import assert from 'node:assert/strict';
import P from '../reader/passages.js';

// Keep the previous implementation as an independent semantic oracle.
function originalSnippet(text,start,end){
 const before=Array.from(text.slice(Math.max(0,start-72),start)).slice(-35).join('');
 const match=Array.from(text.slice(start,Math.min(end,start+242))).slice(0,120).join('');
 const after=Array.from(text.slice(end,end+132)).slice(0,65).join('');
 return {before:(start>before.length?'…':'')+before,match:match+(end-start>match.length?'…':''),after:after+(end+after.length<text.length?'…':'')};
}
function compare(text,start,end){assert.deepEqual(P.rangeSnippet(text,start,end),originalSnippet(text,start,end),JSON.stringify({text,start,end}));}

test('snippet edges preserve code points, isolated surrogates, combining marks, CRLF and ellipses',()=>{
 const parts=['English words. 中文标点。','😀𠮷👩‍💻','e\u0301 İ\u0307\r\n','\ud800alone\udc00','\ud800\ud800\udc00\udc00',''];
 for(const part of parts){
  const text=part.repeat(30);
  const edges=[0,1,2,34,35,36,65,71,72,73,119,120,121,131,132,133,241,242,243,text.length-1,text.length].filter(n=>n>=0&&n<=text.length);
  for(const start of edges)for(const end of edges)if(end>=start)compare(text,start,end);
 }
});

test('fixed-seed mixed Unicode snippets exactly match the prior implementation',()=>{
 let state=0xc0c02026;
 const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
 const alphabet=['abc','中文','。',' ', '\r\n','\t','e\u0301','İ','😀','𠮷','👩‍💻','\ud800','\udc00','\ud800\ud800','\udc00\udc00'];
 for(let i=0;i<4000;i++){
  const text=Array.from({length:random()%450},()=>alphabet[random()%alphabet.length]).join('');
  const start=random()%(text.length+1),end=start+random()%(text.length-start+1);
  compare(text,start,end);
 }
});

test('BMP previews skip code-point arrays and never test the entire oversized source',()=>{
 for(const unit of ['Authored 中文 e\u0301\r\n','\ud800x\udc00']){
  const text=unit.repeat(100000),start=Math.floor(text.length/2),end=start+10000;
  const from=Array.from,regexTest=RegExp.prototype.test;let arrays=0,checked=0,maxWindow=0;
  try{
   Array.from=function(...args){arrays++;return Reflect.apply(from,this,args);};
   RegExp.prototype.test=function(value){checked+=value.length;maxWindow=Math.max(maxWindow,value.length);return Reflect.apply(regexTest,this,[value]);};
   P.rangeSnippet(text,start,end);
  }finally{Array.from=from;RegExp.prototype.test=regexTest;}
  assert.equal(arrays,0);assert.equal(checked,446);assert.equal(maxWindow,242);
  compare(text,start,end);
 }
});

test('astral fallback remains bounded on multi-million-unit fields and retains exact limits',()=>{
 const text='😀𠮷'.repeat(500000),start=1000000,end=start+10000;
 const from=Array.from;let visited=0;
 try{Array.from=function(value,...args){visited+=value.length;return Reflect.apply(from,this,[value,...args]);};P.rangeSnippet(text,start,end);}finally{Array.from=from;}
 assert.equal(visited,446);compare(text,start,end);
 const result=P.rangeSnippet(text,start,end);
 assert.equal(Array.from(result.before).length,36);assert.equal(Array.from(result.match).length,121);assert.equal(Array.from(result.after).length,66);
});
