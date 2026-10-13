import {createTaskStore} from '../../desktop/tasks.mjs';
const store=await createTaskStore({directory:process.argv[2],providers:{ask:async()=>{process.send?.({started:true});return new Promise(()=>{});}}});
const result=await store.submit({protocolVersion:1,kind:'summary',idempotencyKey:'crash-intent',document:{key:'doc',revision:'rev'},provider:'codex',consent:true,segments:[{id:'a',text:'Crash test source'}]});
process.send?.({taskId:result.task.taskId});
setInterval(()=>{},1000);
