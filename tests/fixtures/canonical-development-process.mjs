/** Authored-only child process for the real development entrypoint restart proof.
 * Never loads a user profile or a real model provider.
 */
import {startDevelopmentBridge} from '../../desktop/dev.mjs';
const providers={
 status:async()=>({ready:true,reason:'Authored fake provider; no external models'}),
 ask:async data=>{
  process.send?.({type:'selection-request',data});
  if(data.segments?.length!==1||data.segments[0].text!=='An authored selection survives a computer service restart.'||data.exact_selection?.text!=='An authored'||data.exact_selection?.from!==0||data.exact_selection?.to!==11)throw Error('Unexpected authored selection request');
  return {answer:'Authored selected-text explanation.',citations:[data.segments[0].id],provider:'fixture'};
 },
 structured:async()=>{process.send?.({type:'unexpected-model'});throw Error('Real models disabled');},
 exclusive:async action=>action(),
};
const {server}=await startDevelopmentBridge({port:Number(process.argv[2]),libraryDirectory:process.argv[3],taskDirectory:null,providers});
process.on('message',message=>{if(message==='close')server.close(()=>process.exit(0));});
process.on('disconnect',()=>server.close(()=>process.exit(0)));
process.send?.({type:'ready',port:server.address().port});
