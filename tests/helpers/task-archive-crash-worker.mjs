/** Authored fault injection around the production single-file commit. */
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const [directory,id,phase]=process.argv.slice(2),rename=fs.rename;
fs.rename=async(...args)=>{
 if(phase==='before')await pause();
 await rename(...args);
 if(phase==='after')await pause();
};
const open=fs.open;
if(phase==='enospc')fs.open=async(...args)=>{
 const handle=await open(...args);
 if(String(args[0]).endsWith('.tmp'))handle.writeFile=async()=>{throw Object.assign(new Error('Authored disk-full failure'),{code:'ENOSPC'});};
 return handle;
};
syncBuiltinESMExports();
function pause(){process.send?.({paused:phase});return new Promise(()=>{});}
const {createTaskStore}=await import('../../desktop/tasks.mjs');
const store=await createTaskStore({directory,providers:{ask:async()=>{throw new Error('No provider calls');}}});
try{await store.archive(id);}catch(error){process.send?.({error:error.taskCode});}
setInterval(()=>{},1000);
