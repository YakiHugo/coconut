/** Fake executables exercise real spawn/stdin/argv; never invoke an installed CLI or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProviders,CODEX_DISABLED,CLAUDE_REQUIRED_FLAGS} from '../desktop/providers.mjs';

test('real process transport preserves explicit model, tool denials and stdin-only source',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'coconut-fake-cli-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 for(const provider of ['codex','claude']){
  const binary=path.join(directory,provider),log=path.join(directory,provider+'.jsonl');
  await writeFile(binary,`#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);const provider=${JSON.stringify(provider)};
if(provider==='claude' && args.at(-1)==='--max-turns' && args.includes('--help')){console.error("error: option '--max-turns <turns>' argument missing");process.exitCode=1;}
else if(args.includes('--help')){console.log(${JSON.stringify('--ephemeral --ignore-user-config --ignore-rules --output-schema --sandbox --model '+CLAUDE_REQUIRED_FLAGS.filter(flag=>flag!=='--max-turns').join(' '))});}
else if(args[0]==='features'){console.log(${JSON.stringify(CODEX_DISABLED.join('\n'))});}
else if(args[0]==='login'){console.error('Logged in using ChatGPT');}
else if(args.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));}
else{const input=fs.readFileSync(0,'utf8');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,input,cwd:process.cwd(),credential:process.env.OPENAI_API_KEY})+'\\n');
const answer={answer:'Authored fake output',citations:['a']};
if(provider==='codex'){console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(answer)}}));console.log(JSON.stringify({type:'turn.completed'}));}
else console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,terminal_reason:'completed',structured_output:answer}));}
`,{mode:0o700});
  const providers=createProviders({find:async()=>binary,environment:{HOME:directory,PATH:'/usr/bin:/bin',OPENAI_API_KEY:'never-forward'}});
  const result=await providers.ask({consent:true,provider,model:'authored-test.1',question:'What?',language:'en',segments:[{id:'a',text:'Private authored source'}]});
  assert.equal(result.requested_model,'authored-test.1');
  const requests=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(requests.length,1);
  const request=requests[0];assert.equal(request.args[request.args.indexOf('--model')+1],'authored-test.1');
  assert.equal(request.args.some(arg=>arg.includes('Private authored source')),false);assert.match(request.input,/Private authored source/);
  assert.equal(request.credential,undefined);assert.equal(request.args.includes('--fallback-model'),false);
  if(provider==='codex'){assert.equal(request.args.at(-1),'-');assert.ok(request.args.includes('forced_login_method="chatgpt"'));}
  else{assert.equal(request.args[request.args.indexOf('--tools')+1],'');assert.ok(request.args.includes('--no-session-persistence'));assert.equal(request.args[request.args.indexOf('--max-turns')+1],'1');}
  await assert.rejects(readFile(path.join(request.cwd,'response.schema.json')),{code:'ENOENT'});
 }
});
