import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceNetworkFromEnvironment,validateSourceNetwork,helperNetworkEnvironment} from '../desktop/source-network.mjs';

test('direct default never inherits ambient proxy, trust, credentials or other variables',()=>{
 const env={HTTP_PROXY:'http://private-user:private-password@proxy.example',HTTPS_PROXY:'not a URL',ALL_PROXY:'https://unsupported.example',NO_PROXY:'*',SSL_CERT_FILE:'/private/ca',TOKEN:'private-token'};
 assert.deepEqual(sourceNetworkFromEnvironment(env),{mode:'direct'});
 assert.deepEqual(helperNetworkEnvironment(sourceNetworkFromEnvironment(env)),{});
 assert.deepEqual(validateSourceNetwork(),{mode:'direct'});
 assert.deepEqual(validateSourceNetwork(null),{mode:'direct'});
 assert.deepEqual(sourceNetworkFromEnvironment({...env,COCONUT_SOURCE_NETWORK:'direct',COCONUT_CAPTION_PROXY:'invalid legacy'}),{mode:'direct'});
});

test('explicit environment mode snapshots only supported variables, preserving case and bypass rules',()=>{
 const selected={HTTP_PROXY:'http://proxy.example:8080',http_proxy:'',HTTPS_PROXY:'socks5h://proxy.example:1080',https_proxy:'socks4a://[::1]:1080/',ALL_PROXY:'socks4://proxy.example',all_proxy:'socks5://proxy.example',NO_PROXY:'localhost, .example.org,127.0.0.1',no_proxy:'*'};
 const env={...selected,COCONUT_SOURCE_NETWORK:'environment',COCONUT_CAPTION_PROXY:'ignored legacy',FTP_PROXY:'http://ignored.example',PATH:'/private/bin',SSL_CERT_FILE:'/private/ca',COOKIE:'private-cookie'};
 const result=sourceNetworkFromEnvironment(env);
 assert.deepEqual(result,{mode:'environment',environment:selected});
 assert.deepEqual(helperNetworkEnvironment(result),selected);
 assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(result.environment),true);
 env.HTTP_PROXY='http://changed.example';
 assert.equal(result.environment.HTTP_PROXY,selected.HTTP_PROXY);
 const child=helperNetworkEnvironment(result);child.HTTP_PROXY='http://changed.example';
 assert.equal(result.environment.HTTP_PROXY,selected.HTTP_PROXY);
 assert.deepEqual(sourceNetworkFromEnvironment({COCONUT_SOURCE_NETWORK:'environment'}),{mode:'environment',environment:{}});
});

test('custom and legacy proxies retain explicit numeric-loopback HTTP contract',()=>{
 for(const proxy of ['http://127.0.0.1:1','http://[::1]:65535/']){
  const expected={mode:'custom',proxy:proxy.replace(/\/$/,'')};
  assert.deepEqual(sourceNetworkFromEnvironment({COCONUT_CAPTION_PROXY:proxy}),expected);
  assert.deepEqual(sourceNetworkFromEnvironment({COCONUT_SOURCE_NETWORK:'custom',COCONUT_SOURCE_PROXY:proxy,COCONUT_CAPTION_PROXY:'ignored'}),expected);
  assert.deepEqual(helperNetworkEnvironment(expected),{all_proxy:expected.proxy});
 }
 for(const proxy of ['http://localhost:7897','http://127.0.0.2:7897','http://proxy.example:7897','socks5://127.0.0.1:7897','http://127.0.0.1:0','http://127.0.0.1:65536','http://127.0.0.1:01','http://127.0.0.1:123/path','http://127.0.0.1:123\n','']){
  assert.throws(()=>sourceNetworkFromEnvironment({COCONUT_CAPTION_PROXY:proxy}),{code:'SOURCE_NETWORK_CONFIGURATION'});
 }
});

test('ambiguous or incomplete owner settings fail rather than silently falling back',()=>{
 for(const env of [
  {COCONUT_SOURCE_PROXY:'http://127.0.0.1:7897'},
  {COCONUT_SOURCE_NETWORK:''},{COCONUT_SOURCE_NETWORK:'system'},{COCONUT_SOURCE_NETWORK:'auto'},
  {COCONUT_SOURCE_NETWORK:'custom',COCONUT_CAPTION_PROXY:'http://127.0.0.1:7897'},
  {COCONUT_SOURCE_NETWORK:'direct',COCONUT_SOURCE_PROXY:'http://127.0.0.1:7897'},
  {COCONUT_SOURCE_NETWORK:'environment',COCONUT_SOURCE_PROXY:'http://127.0.0.1:7897'},
 ])assert.throws(()=>sourceNetworkFromEnvironment(env),{code:'SOURCE_NETWORK_CONFIGURATION'});
});

test('environment proxies reject credentials, unsupported transports and ambiguous URLs without echo',()=>{
 const values=['http://secret-user:secret-password@proxy.example','http://@proxy.example','https://proxy.example','ftp://proxy.example','file:///private/secret','proxy.example:8080','http://proxy.example/path','http://proxy.example?secret-token=x','http://proxy.example#secret-token','http://proxy.example\\path','http://proxy.example\n',' http://proxy.example','http://proxy.example:0','http://proxy.example:65536','http://','x'.repeat(2049),null,42];
 for(const value of values){
  assert.throws(()=>sourceNetworkFromEnvironment({COCONUT_SOURCE_NETWORK:'environment',HTTPS_PROXY:value}),error=>{
   assert.equal(error.code,'SOURCE_NETWORK_CONFIGURATION');
   assert.doesNotMatch(error.message,/secret|proxy\.example|private/);
   return true;
  });
 }
});

test('NO_PROXY is bounded text, never interpreted or normalized by Coconut',()=>{
 for(const value of ['', '*', 'localhost, .example.org, [::1]:8080', 'a'.repeat(4096)]){
  assert.equal(sourceNetworkFromEnvironment({COCONUT_SOURCE_NETWORK:'environment',NO_PROXY:value}).environment.NO_PROXY,value);
 }
 for(const value of ['a'.repeat(4097),'a\nb','a\tb','a\0b','a\x7fb',null,[]]){
  assert.throws(()=>sourceNetworkFromEnvironment({COCONUT_SOURCE_NETWORK:'environment',no_proxy:value}),{code:'SOURCE_NETWORK_CONFIGURATION'});
 }
});

test('validated input has an exact detached shape and rejects unrelated environment injection',()=>{
 for(const value of [[],42,'direct',{}, {mode:'direct',proxy:''},{mode:'custom',proxy:'http://127.0.0.1:1',environment:{}},{mode:'environment'},{mode:'environment',environment:[]},{mode:'environment',environment:{PATH:'/private/bin'}},{mode:'environment',environment:{HTTP_PROXY:undefined}},{mode:'system'}]){
  assert.throws(()=>validateSourceNetwork(value),{code:'SOURCE_NETWORK_CONFIGURATION'});
 }
 const source={mode:'environment',environment:{HTTP_PROXY:'http://proxy.example'}};
 const result=validateSourceNetwork(source);source.environment.HTTP_PROXY='http://changed.example';
 assert.equal(result.environment.HTTP_PROXY,'http://proxy.example');
 const inherited=Object.create({HTTP_PROXY:'http://ignored.example'});inherited.COCONUT_SOURCE_NETWORK='environment';
 assert.deepEqual(sourceNetworkFromEnvironment(inherited),{mode:'environment',environment:{}});
});
