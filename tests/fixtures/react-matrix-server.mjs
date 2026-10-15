/** Isolated real Node/SQLite fixture. Providers are authored fakes, never CLIs. */
import {startDevelopmentBridge} from '../../desktop/dev.mjs';
let mode='answer',pending=null;
const providers={
 status:async()=>({ready:mode!=='unavailable',model_selection:{supported:true},reason:mode==='unavailable'?'Authored fixture: official CLI subscription login is required.':'Authored fake provider only'}),
 ask:async data=>{
  process.send?.({type:'ask',data});
  if(mode==='hold')return new Promise(resolve=>{pending=()=>resolve({answer:'STALE authored answer',citations:[data.segments[0].id],provider:'fixture'});});
  if(mode==='error')throw Object.assign(Error('Authored provider unavailable'),{localProviderDetails:{message:'AUTHORED_LOCAL_DETAIL',upstreamCode:'AUTHORED_429'}});
  return {answer:'Authored bounded answer',citations:[data.segments[0].id],provider:'fixture'};
 },
 structured:async()=>{throw Error('No structured inference allowed in authored browser matrix');},
 exclusive:async action=>action()
};
const {server}=await startDevelopmentBridge({port:Number(process.argv[2]),libraryDirectory:process.argv[3],taskDirectory:null,captionPython:null,captionProxy:null,privateProxy:null,providers});
process.on('message',message=>{
 if(message.type==='mode'){mode=message.value;process.send?.({type:'ack',id:message.id});}
 if(message.type==='release'){pending?.();pending=null;process.send?.({type:'ack',id:message.id});}
 if(message.type==='close')server.shutdown(()=>process.exit(0));
});
process.on('disconnect',()=>server.shutdown(()=>process.exit(0)));
process.send?.({type:'ready',port:server.address().port});
