/** Bounded diagnostics for the isolated native update fixture, never product code. */
import {writeSync} from 'node:fs';

export async function runNativeUpdateFixture({run,cleanup,getApplication=()=>null,
 bodyTimeoutMs=180000,cleanupTimeoutMs=15000,write=line=>writeSync(2,line+'\n')}={}) {
 let phase='body',stage='starting',timer,primaryError,failed=false;
 const report=(event,detail='')=>write(`[native-update-ui] ${event} phase=${phase} stage=${stage}${detail?' '+detail:''}`);
 const message=error=>error?.stack||String(error);
 // A Promise.race would leave the timed-out fixture running alongside cleanup.
 // Instead the watchdog fails this Node process after killing only its own
 // isolated Electron child. This path can never return a passing result.
 const stop=(reason)=>{
  report('fatal',reason);
  try {
   const child=getApplication()?.process();
   if(child&&child.exitCode===null&&child.signalCode===null){
    report('terminate-child','signal=SIGKILL');child.kill('SIGKILL');
   }
  }catch(error){report('termination-error',message(error));}
  process.exit(1);
 };
 const arm=timeout=>{
  clearTimeout(timer);
  timer=setTimeout(()=>stop(`deadline exceeded (${timeout}ms)`),timeout);
 };
 const mark=name=>{stage=name;report('stage');};
 arm(bodyTimeoutMs);
 try {
  report('begin');await run(mark);report('body-complete');
 }catch(error){
  failed=true;primaryError=error;
  // Print before any potentially blocked graceful quit. Keep this exact error
  // as the result if cleanup succeeds, and in the log if cleanup cannot finish.
  report('error',message(error));
 }finally{
  phase='cleanup';report('begin');arm(cleanupTimeoutMs);
  try {await cleanup();report('cleanup-complete');}
  catch(error){report('cleanup-error',message(error));stop('cleanup failed');}
  finally{clearTimeout(timer);}
 }
 if(failed)throw primaryError;
}
