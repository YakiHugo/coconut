import {createTaskStore} from '../../desktop/tasks.mjs';
let calls=0;
const store=await createTaskStore({directory:process.argv[2],providers:{ask:async data=>{
 calls++;
 if(calls<Number(process.argv[3]||2))return {answer:'Accepted first batch',citations:['a']};
 process.send({waiting:true,calls});return new Promise(()=>{});
}}});
const receipt=await store.submit({protocolVersion:1,kind:'summary',idempotencyKey:'crash-intent',document:{key:'doc',revision:'r1'},provider:'codex',model:'chosen-model',consent:true,segments:[{id:'a',text:'Authored source. '.repeat(1100)}]});
process.send({task:receipt.task});
