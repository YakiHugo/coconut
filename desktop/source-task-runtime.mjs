/** Shared task wiring for both desktop and standalone startup. */
import {createTranscriber} from './transcriber.mjs';
export function sourceTaskRuntime({asrPython,asrProfile,transcriber=createTranscriber({python:asrPython,profile:asrProfile})}={}){
 const ingestionExecutor={status:()=>transcriber.status(),list:async()=>[],
  upload:async()=>{throw Object.assign(Error('请先保存原声，再从项目创建转录任务'),{status:409});}};
 return {enableSourceJobs:true,transcriber,ingestionExecutor};
}
