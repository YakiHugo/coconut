/** Process-owned deadlines for podcast/direct-media transfers, separate from metadata. */
export const DEFAULT_PODCAST_DOWNLOAD_POLICY=Object.freeze({timeoutMs:2*60*60*1000,idleTimeoutMs:2*60*1000});
const TOTAL_SECONDS='COCONUT_PODCAST_DOWNLOAD_TIMEOUT_SECONDS';
const IDLE_SECONDS='COCONUT_PODCAST_DOWNLOAD_IDLE_TIMEOUT_SECONDS';
export function validatePodcastDownloadPolicy(value){
 if(!value||!Number.isSafeInteger(value.timeoutMs)||value.timeoutMs<1||value.timeoutMs>24*60*60*1000)
  throw Error('Podcast download timeout must be positive and at most 24 hours.');
 if(!Number.isSafeInteger(value.idleTimeoutMs)||value.idleTimeoutMs<1||value.idleTimeoutMs>10*60*1000||value.idleTimeoutMs>value.timeoutMs)
  throw Error('Podcast download idle timeout must be positive, at most 10 minutes, and no greater than the total timeout.');
 return Object.freeze({timeoutMs:value.timeoutMs,idleTimeoutMs:value.idleTimeoutMs});
}
export function podcastDownloadPolicyFromEnvironment(env=process.env){
 const seconds=(key,fallback)=>{
  if(env[key]===undefined)return fallback;
  if(typeof env[key]!=='string'||!/^\d+$/.test(env[key])||!Number.isSafeInteger(Number(env[key]))||Number(env[key])<1)
   throw Error(`${key} must be a positive whole number of seconds.`);
  return Number(env[key])*1000;
 };
 return validatePodcastDownloadPolicy({
  timeoutMs:seconds(TOTAL_SECONDS,DEFAULT_PODCAST_DOWNLOAD_POLICY.timeoutMs),
  idleTimeoutMs:seconds(IDLE_SECONDS,DEFAULT_PODCAST_DOWNLOAD_POLICY.idleTimeoutMs)
 });
}
