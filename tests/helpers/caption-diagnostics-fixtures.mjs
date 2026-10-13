/** Authored captions only: exercise parser loss without contacting X or a provider. */
export const captionFixtureURL='https://x.com/coconut_fixture/status/123456';
export const captionFixtureTitle='Authored partial caption fixture';
export function captionFixtureResult({format='srt',complete=false,onlyInvalid=false,warningCount=1}={}){
 const timing=(start,end)=>format==='vtt'?`00:0${start}.000 --> 00:0${end}.000`:`00:00:0${start},000 --> 00:00:0${end},000`;
 const first=`opening\n${timing(0,1)}\nFirst original authored sentence.`;
 const malformed=index=>`missing-${index}\n${timing(1,2).replace('-->','->')}\nMissing authored detail ${index}. <script>plain excerpt</script>`;
 const empty=`empty\n${timing(2,3)}\n<b> </b>`;
 const last=`closing\n${timing(3,4)}\nLast original authored sentence.`;
 const metadata=format==='vtt'?['WEBVTT Authored fixture','NOTE subtitle metadata\n00:01.000 -> 00:02.000\nNot a cue']:[];
 const bad=[...Array.from({length:warningCount},(_,index)=>malformed(index+1)),empty];
 const blocks=complete?[first,last]:onlyInvalid?bad:[first,...bad,last];
 return {source:{url:captionFixtureURL,id:'1234567890',title:captionFixtureTitle,extractor:'twitter',language:'en',automatic:false,duration:4},track:{language:'en',captionMethod:'platform_provided',languageBasis:'user_hint',captionTrack:'en-original-fixture'},format,bytes:Buffer.from('\uFEFF'+[...metadata,...blocks].join('\r\n\r\n'))};
}
