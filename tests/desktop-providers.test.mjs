import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CODEX_DISABLED, CLAUDE_REQUIRED_FLAGS, normalizeModel, createProviders, safeEnvironment, runCommand } from '../desktop/providers.mjs';
import { createTranslator, prepareTranslation, qualityWarnings, semanticUnits, termPresent } from '../desktop/translation.mjs';

const question = {consent:true,provider:'codex',question:'What happened?',language:'zh',segments:[{id:'a',text:'Quoted source'}]};
const response = value => [{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed'}].map(JSON.stringify).join('\n');
function fixture(output = {answer:'Answer',citations:['a']}, options = {}) {
  const calls = [];
  const run = async (binary,args,settings) => {
    calls.push({binary,args,settings});
    if (args.includes('--help')) return {code:0,stdout:binary.endsWith('/claude') ? CLAUDE_REQUIRED_FLAGS.join(' ') : '--ephemeral --ignore-user-config --ignore-rules --output-schema --sandbox --model',stderr:''};
    if (args[0] === 'features') return {code:0,stdout:CODEX_DISABLED.join('\n'),stderr:''};
    if (args[0] === 'login') return {code:0,stdout:'',stderr:options.auth || 'Logged in using ChatGPT'};
    if (args.includes('auth')) return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod:options.auth || 'claude.ai'})};
    if (options.invoke) return options.invoke(binary,args,settings);
    return {code:0,stdout:args[0] === 'exec' ? response(output) : JSON.stringify({type:"result",subtype:"success",is_error:false,structured_output:output})};
  };
  return {calls,providers:createProviders({run,find:async name=>'/trusted/'+name,environment:{HOME:'/safe/home',PATH:'/bin',OPENAI_API_KEY:'do-not-forward',NODE_OPTIONS:'do-not-forward',CODEX_HOME:'do-not-forward'}})};
}
test('safe environment removes credentials, custom provider overrides and relative executable paths',()=>{
  const env = safeEnvironment({HOME:'/safe',PATH:'.::/bin:relative',OPENAI_API_KEY:'secret',CLAUDE_CODE_OAUTH_TOKEN:'secret',NODE_OPTIONS:'--inspect',CODEX_HOME:'/other'});
  assert.deepEqual(Object.keys(env).sort(),['HOME','PATH']);
  assert.ok(env.PATH.split(':').every(item=>item.startsWith('/')));
});
test('no provider lookup or process runs at adapter creation',()=>{
  const {calls} = fixture(); assert.equal(calls.length,0);
});
test('ask is subscription-only and no tools, shell, credential forwarding or persistence',async()=>{
  const {providers,calls} = fixture(); const result = await providers.ask(question);
  assert.deepEqual(result,{answer:'Answer',citations:['a'],provider:'chatgpt_subscription'});
  assert.equal(calls.length,4);
  const request = calls.at(-1);
  for (const flag of ['--ephemeral','--ignore-user-config','--ignore-rules','--sandbox','read-only','forced_login_method="chatgpt"','approval_policy="never"','web_search="disabled"',...CODEX_DISABLED]) assert.ok(request.args.includes(flag),flag);
  assert.equal(request.args.at(-1),'-'); assert.match(request.settings.input,/untrusted quoted data/);
  assert.equal(request.settings.env.OPENAI_API_KEY,undefined);
  await assert.rejects(readFile(request.settings.cwd+'/response.schema.json'),{code:'ENOENT'});
});
test('Claude adapter keeps official subscription authentication and tool denial',async()=>{
  const {providers,calls} = fixture(); const result = await providers.ask({...question,provider:'claude'});
  assert.equal(result.provider,'claude_subscription');
  const args = calls.at(-1).args;
  for (const flag of ['--safe-mode','--tools','--strict-mcp-config','--no-session-persistence','dontAsk']) assert.ok(args.includes(flag));
});
test('API login, absent consent, malformed source and unknown provider fail before inference',async()=>{
  for (const data of [{...question,consent:false},{...question,segments:[...question.segments,...question.segments]},{...question,language:'xx'},{...question,provider:'shell'}]) {
    const {providers,calls} = fixture(); await assert.rejects(providers.ask(data)); assert.ok(!calls.some(call=>call.args.includes('--json')));
  }
  const {providers,calls} = fixture(undefined,{auth:'Logged in using an API key'});
  await assert.rejects(providers.ask(question),/ChatGPT/); assert.equal(calls.length,3);
});
test('incompatible CLI cannot be treated as ready',async()=>{
  const providers = createProviders({find:async()=>'/cli',run:async()=>({code:0,stdout:'old',stderr:''})});
  assert.equal((await providers.status('codex')).ready,false);
});
test('quota, unknown tool, malformed output, incomplete turn and unknown citation never fall back',async()=>{
  const invalid = [
    {code:1,stdout:'quota'},
    {code:0,stdout:'not JSON'},
    {code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{}'}})},
    {code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'future_new_tool'}})+'\n'+response({answer:'Answer',citations:['a']})},
    {code:0,stdout:response({answer:'Answer',citations:['not-sent']})}
  ];
  for (const result of invalid) {
    const {providers,calls} = fixture(undefined,{invoke:async()=>result});
    await assert.rejects(providers.ask(question)); assert.equal(calls.filter(call=>call.args.includes('--json')).length,1);
    assert.ok(calls.every(call=>call.binary === '/trusted/codex'));
  }
});
test('concurrent sends are rejected rather than consuming duplicate quota',async()=>{
  let release; const gate = new Promise(resolve=>{release=resolve;});
  const {providers} = fixture(undefined,{invoke:async()=>{await gate;return {code:0,stdout:response({answer:'A',citations:['a']})};}});
  const first = providers.ask(question); await assert.rejects(providers.ask(question),/正在运行/); release(); await first;
});
test('runner bounds output and cancels without returning logs or input',async()=>{
  await assert.rejects(runCommand(process.execPath,['-e','process.stdout.write("x".repeat(10000))'],{env:safeEnvironment(),maxBytes:100}),/安全限制/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runCommand(process.execPath,['-e','process.exit(0)'],{signal:controller.signal}),/取消/);
});
test('translation keeps context-only IDs separate, glossary selective, and warnings advisory',async()=>{
  const data = {consent:true,source:'en',target:'zh',segments:[{id:'b',text:'It sends 12 requests.',position:1,start:4,end:8,speaker:'A'}],
    context:[{id:'a',text:'When Coconut runs,',position:0,start:0,end:4,speaker:'A'}],glossary:[{source:'Coconut',target:'椰子'},{source:'not-selected',target:'secret'}],
    memory:[{id:'a',source_text:'When Coconut runs,',text:'Coconut 运行时'}]};
  const prepared = prepareTranslation(data); assert.deepEqual(prepared.payload.semantic_units,[{ids:['a','b']}]);
  assert.deepEqual(prepared.payload.glossary,[{source:'Coconut',target:'椰子'}]); assert.deepEqual(prepared.payload.target_ids,['b']);
  const {providers} = fixture({translations:[{id:'b',text:'它发送 20 次请求。'}]});
  const result = await createTranslator(providers)(data);
  assert.equal(result[0].source_text,data.segments[0].text); assert.equal(result[0].context_version,2);
  assert.match(result[0].input_revision,/^[a-f0-9]{64}$/); assert.deepEqual(result[0].quality_warnings,['numbers_changed']);
});
test('translation rejects stale/unselected memory and malformed contexts before provider calls',()=>{
  const base = {source:'en',target:'zh',segments:[{id:'a',text:'Source',position:1,start:1,end:2}],context:[]};
  for (const extra of [{memory:[{id:'a',source_text:'Source',text:'译文'}]}, {context:[{id:'b',text:'Other',position:1,start:0,end:1}]},
    {context:[{id:'b',text:'Other',position:0,start:NaN,end:1}]},{glossary:[{source:'x',target:'Y'},{source:'X',target:'Z'}]}]) assert.throws(()=>prepareTranslation({...base,...extra}));
});
test('translation rejects reordered IDs and incomplete or whitespace output as an entire batch',async()=>{
  const data = {consent:true,source:'en',target:'zh',segments:[{id:'a',text:'One'},{id:'b',text:'Two'}]};
  for (const translations of [[{id:'a',text:'一'}],[{id:'b',text:'二'},{id:'a',text:'一'}],[{id:'a',text:'一'},{id:'b',text:' '}],[{id:'a',text:'一'},{id:'a',text:'二'}]]) {
    const {providers} = fixture({translations}); await assert.rejects(createTranslator(providers)(data),/本批次全部不保存/);
  }
});
test('semantic-unit boundaries do not invent adjacency across gaps or speakers',()=>{
  const cues = [{id:'a',text:'Part',position:0,start:0,end:1,speaker:'A'},{id:'b',text:'rest',position:2,start:1,end:2,speaker:'A'},
    {id:'c',text:'next',position:3,start:2,end:3,speaker:'B'}];
  assert.deepEqual(semanticUnits(cues),[{ids:['a']},{ids:['b']},{ids:['c']}]);
  assert.equal(termPresent('chair','AI'),false); assert.equal(termPresent('AI agent','AI'),true);
  assert.ok(qualityWarnings({text:'value -12'},'value 12','en').includes('numbers_changed'));
});
test('legacy no-context cues never claim adjacency or use unvalidated optional timing',async()=>{
  const data = {consent:true,source:'en',target:'zh',segments:[{id:'a',text:'First',start:'invalid',end:{bad:true}},{id:'b',text:'Second'}]};
  assert.deepEqual(prepareTranslation(data).payload.semantic_units,[{ids:['a']},{ids:['b']}]);
  const {providers} = fixture({translations:[{id:'a',text:'第一'},{id:'b',text:'第二'}]});
  assert.equal((await createTranslator(providers)(data)).length,2);
});
test('portable Python/Node translation fixtures retain the same selected context and warnings',async t=>{
  // This fixture is added by the contextual-translation change. Unit checks for this
  // standalone bridge also run before that change is integrated.
  let fixtures;
  try { fixtures=JSON.parse(await readFile(new URL('./fixtures/translation-context.json',import.meta.url),'utf8')); }
  catch(error) { if(error.code==='ENOENT') {t.skip('Shared translation fixture is not integrated yet'); return;} throw error; }
  for (const entry of fixtures) {
    const prepared=prepareTranslation(entry.request);
    assert.deepEqual(prepared.payload.semantic_units,entry.expected_units,entry.name);
    assert.deepEqual(prepared.payload.glossary,entry.expected_terms,entry.name);
    const {providers}=fixture(entry.model_output);
    const result=await createTranslator(providers)({...entry.request,consent:true});
    assert.deepEqual(result.map(item=>item.quality_warnings),entry.expected_warnings,entry.name);
  }
});

test('explicit models reach both CLIs and response provenance without contaminating transcript input',async()=>{
  for(const provider of ['codex','claude']){
    const {providers,calls}=fixture();
    const result=await providers.ask({...question,provider,model:'authored-test-model'});
    const request=calls.at(-1);
    assert.equal(request.args[request.args.indexOf('--model')+1],'authored-test-model');
    assert.equal(request.args.filter(arg=>arg==='--model').length,1);
    assert.equal(result.requested_model,'authored-test-model');
    assert.equal(request.settings.input.includes('authored-test-model'),false);
    assert.equal(request.args.includes('--fallback-model'),false);
    assert.equal((await providers.status(provider)).model_selection.availability,'not-checked');
  }
});
test('default model omits override and never claims to know which model ran',async()=>{
  for(const provider of ['codex','claude'])for(const model of [undefined,null,'']){
    const {providers,calls}=fixture();const answer=await providers.ask({...question,provider,model});
    assert.equal(calls.at(-1).args.includes('--model'),false);
    assert.equal(Object.hasOwn(answer,'requested_model'),false);
  }
});
test('invalid model cannot trigger discovery, inference or implicit fallback',async()=>{
  for(const model of [' model','model ','--help','x\n--tools','../model','https://host/model','a/b','x;echo nope','x'.repeat(121),{},[],true,23]){
    assert.throws(()=>normalizeModel(model),/模型名称/);
    const {providers,calls}=fixture();await assert.rejects(providers.ask({...question,model}),/模型名称/);assert.equal(calls.length,0);
    await assert.rejects(createTranslator(providers)({consent:true,source:'en',target:'zh',segments:question.segments,model}),/模型名称/);assert.equal(calls.length,0);
  }
});
test('model choice is carried through translation results for both providers',async()=>{
  for(const provider of ['codex','claude']){
    const {providers,calls}=fixture({translations:[{id:'a',text:'原文译文'}]});
    const result=await createTranslator(providers)({consent:true,source:'en',target:'zh',segments:question.segments,provider,model:'authored-model'});
    assert.equal(result[0].requested_model,'authored-model');
    assert.equal(calls.at(-1).args[calls.at(-1).args.indexOf('--model')+1],'authored-model');
  }
});
test('unsupported Claude contract fails at read-only preflight before auth or inference',async()=>{
  for(const missing of CLAUDE_REQUIRED_FLAGS){
    const calls=[];const providers=createProviders({find:async()=>'/cli/claude',run:async(binary,args)=>{calls.push(args);return {code:0,stdout:CLAUDE_REQUIRED_FLAGS.filter(flag=>flag!==missing).join(' ')};}});
    assert.equal((await providers.status('claude')).ready,false);
    assert.equal(calls.length,1);assert.ok(calls[0].includes('--help'));assert.ok(!calls[0].includes('--print'));
  }
});
test('Claude rejects incomplete, failed, interrupted and non-result envelopes even with valid answer',async()=>{
  const structured_output={answer:'Must not save',citations:['a']};
  for(const envelope of [{structured_output},{type:'result',subtype:'error_max_turns',is_error:false,structured_output},
    {type:'result',subtype:'success',is_error:true,structured_output},
    {type:'assistant',subtype:'success',is_error:false,structured_output},
    {type:'result',subtype:'success',is_error:false,terminal_reason:'aborted_streaming',structured_output}]){
    const {providers,calls}=fixture(undefined,{invoke:async()=>({code:0,stdout:JSON.stringify(envelope)})});
    await assert.rejects(providers.ask({...question,provider:'claude',model:'authored-model'}),/未保存/);
    assert.equal(calls.filter(call=>call.args.includes('--print')).length,1);
  }
});
test('selected unavailable model fails once without changing models or providers',async()=>{
  for(const provider of ['codex','claude']){
    const {providers,calls}=fixture(undefined,{invoke:async()=>({code:1,stdout:'',stderr:'model unavailable private account details'})});
    await assert.rejects(providers.ask({...question,provider,model:'unavailable-model'}),error=>!error.message.includes('private'));
    assert.equal(calls.filter(call=>call.args.includes('--print')||call.args.includes('--json')).length,1);
    assert.ok(calls.every(call=>call.binary==='/trusted/'+provider));
  }
});
test('Claude invocation requests refusal instead of model switching and clears fallback chain',async()=>{
  const {providers,calls}=fixture();await providers.ask({...question,provider:'claude',model:'authored-model'});
  for(const call of calls){const index=call.args.indexOf('--settings');assert.notEqual(index,-1);
    assert.deepEqual(JSON.parse(call.args[index+1]),{disableAllHooks:true,switchModelsOnFlag:false,fallbackModel:[]});}
});
