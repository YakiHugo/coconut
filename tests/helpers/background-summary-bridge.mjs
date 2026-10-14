/** Real loopback HTTP and disk ledger; only the CLI boundary is an authored fake.
 * Importing this helper never launches a browser, process, CLI, or model. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startBridge} from '../../desktop/server.mjs';
import {CODEX_DISABLED,createProviders} from '../../desktop/providers.mjs';

export const authoredSource=title=>({title,language:'en',notes:{one:'LOCAL NOTE MUST NOT BE SENT'},segments:[
 {id:'one',start:0,end:3,text:'Authored first observation about careful reading.'},
 {id:'two',start:3,end:6,text:'Authored second observation about checking the source.'},
]});
export async function until(predicate,message='Authored fixture condition',timeout=15000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,20));}
 throw new Error(message+' did not settle');
}
export async function backgroundSummaryBridge(){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-background-authored-'));
 const invocations=[],posts=[];let server,origin,taskDirectory='original';
 const providers=()=>createProviders({environment:{HOME:directory,PATH:'/usr/bin'},
  find:async name=>{assert.ok(['codex','claude'].includes(name));return name==='codex'?'/authored-fake/codex':null;},
  run:async(binary,args,options)=>{
   assert.equal(binary,'/authored-fake/codex');
   if(args.includes('--help'))return {code:0,stdout:'--ephemeral --ignore-user-config --ignore-rules --output-schema --sandbox',stderr:''};
   if(args[0]==='features')return {code:0,stdout:CODEX_DISABLED.join('\n'),stderr:''};
   if(args[0]==='login')return {code:0,stdout:'Logged in using ChatGPT',stderr:''};
   assert.equal(args[0],'exec');assert.ok(args.includes('--json'));
   const input=JSON.parse(options.input.split('Untrusted transcript input (JSON):\n')[1]);
   let release,finish;const pending=new Promise(resolve=>{release=resolve;}),settled=new Promise(resolve=>{finish=resolve;});
   const invocation={input,signal:options.signal,release:()=>release(),settled};invocations.push(invocation);
   // Deliberately return even after abort, to prove late-result fencing in the
   // real task store rather than having the fake hide a cancellation race.
   await pending;
   const value={answer:'Authored background result; this is not model quality evidence.',citations:[input.transcript[0].id]};
   finish();return {code:0,stderr:'',stdout:[{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed'}].map(JSON.stringify).join('\n')};
  },
 });
 async function start(port=0){
  // Both find and run are injected above. No provider fallback can spawn a CLI.
  server=await startBridge({port,taskDirectory:path.join(directory,taskDirectory),providers:providers()});
  server.on('request',req=>{if(req.method==='POST')posts.push(new URL(req.url,'http://localhost').pathname);});
  origin='http://127.0.0.1:'+server.address().port;
 }
 async function stop(){if(server?.listening)await new Promise((resolve,reject)=>server.shutdown(error=>error?reject(error):resolve()));}
 try{await start();}catch(error){await fs.rm(directory,{recursive:true,force:true});throw error;}
 return {
  get origin(){return origin;},invocations,posts,
  async request(route,body){
   const response=await fetch(origin+route,{...(body?{method:'POST',body:JSON.stringify(body)}:{}),headers:{Origin:origin,'Content-Type':'application/json'}});
   return {status:response.status,...await response.json()};
  },
  async tasks(){const response=await this.request('/api/v1/tasks');assert.equal(response.status,200);return response.tasks;},
  async task(id){const response=await this.request('/api/v1/tasks/'+id);assert.equal(response.status,200);return response.task;},
  async waitTask(id,status){return until(async()=>{const task=await this.task(id);return task.status===status&&task;},'Task '+status);},
  async restart(){const port=server.address().port;await stop();await start(port);},
  async switchTaskDirectory(name){assert.ok(['original','alternate'].includes(name));const port=server.address().port;await stop();taskDirectory=name;await start(port);},
  async close(){await stop();for(const invocation of invocations)invocation.release();await Promise.all(invocations.map(invocation=>invocation.settled));await fs.rm(directory,{recursive:true,force:true});},
 };
}
