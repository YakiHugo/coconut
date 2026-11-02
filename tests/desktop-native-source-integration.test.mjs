/** Authored responses only: real Python process → official extractor/HttpFD →
 * production Node APIs → SQLite + asset restart. Never a live platform proof.
 * The sole seam is RequestDirector.send, and socket calls are forbidden.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {runSourceAcceptance,sourceInput} from '../scripts/live_source_acceptance.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const python=process.env.COCONUT_CAPTION_PYTHON;
test('real isolated pinned helper acquires authored video captions/media and reopens durable bytes',{skip:!python?'Explicit pinned Python unavailable; dedicated contract CI runs this test':false},async()=>{
 assert.ok(path.isAbsolute(python),'Pinned interpreter must be explicit');
 const probe=spawnSync(python,['-I','-c','import yt_dlp,certifi;from yt_dlp.version import __version__;assert __version__=="2026.08.19"'],{encoding:'utf8',timeout:10000});
 assert.equal(probe.status,0,'Pinned interpreter dependencies must be ready');
 const directory=await mkdtemp(path.join(tmpdir(),'coconut-native-source-contract-'));
 try{
  const executable=path.join(directory,'authored-python');
  await writeFile(executable,`#!${python} -I
import sys, socket, io, json
sys.path.insert(0,${JSON.stringify(root)})
sys.path.insert(0,${JSON.stringify(path.join(root,'tests'))})
from test_owner_video_source import fixture, STATE, PLAYER
from yt_dlp.networking import Response
from yt_dlp.networking.common import RequestDirector
from pathlib import Path
STATE['videoData']['duration']=2
media=Path(${JSON.stringify(path.join(root,'tests/fixtures/authored-video-audio.m4a'))}).read_bytes()
video=Path(${JSON.stringify(path.join(root,'tests/fixtures/authored-source-video.mp4'))}).read_bytes()
PLAYER['videoDetails']['lengthSeconds']='2'
PLAYER['streamingData']={'formats':[{'itag':18,'url':'https://rr1---sn-abcdef.googlevideo.com/videoplayback?authored=1','mimeType':'video/mp4; codecs=\"avc1.42001E, mp4a.40.2\"','bitrate':64000,'width':160,'height':90,'quality':'small','qualityLabel':'144p','audioQuality':'AUDIO_QUALITY_LOW','audioSampleRate':'44100','approxDurationMs':'2000','contentLength':str(len(video))}]}
def forbidden(*args,**kwargs):
    raise AssertionError('Authored contract forbids network sockets')
socket.getaddrinfo=forbidden
socket.socket.connect=forbidden
socket.create_connection=forbidden
def authored(self,request):
    url=request.url
    if '/playurl?' in url:
        body=json.dumps({'code':0,'data':{'dash':{'video':[],'audio':[{'id':30280,'baseUrl':'https://upos-sz-mirror.bilivideo.com/public.m4s','mimeType':'audio/mp4','codecs':'mp4a.40.2','bandwidth':64000}]},'timelength':2000}}).encode()
    elif '/videoplayback?' in url:
        return Response(io.BytesIO(video),url,{'Content-Type':'video/mp4','Content-Length':str(len(video))})
    elif '/api/timedtext?' in url:
        body=b'WEBVTT\\n\\n00:00.000 --> 00:02.000\\nAuthored original fixture.\\n'
    elif '/bfs/subtitle/' in url:
        body=b'{"body":[{"from":0,"to":2,"content":"Authored original fixture."}]}'
    elif url.endswith('/public.m4s'):
        return Response(io.BytesIO(media),url,{'Content-Type':'audio/mp4','Content-Length':str(len(media))})
    else:
        return fixture(request)
    return Response(io.BytesIO(body),url,{'Content-Length':str(len(body))})
RequestDirector.send=authored
assert sys.argv[1:4]==['-I','-B','-c'] and len(sys.argv)==5
# Run the exact development preflight/production JSON launcher supplied by Node.
exec(compile(sys.argv[4],'<isolated-development-launcher>','exec'),{'__name__':'__main__'})
`,{mode:0o700});
  for(const url of ['https://www.bilibili.com/video/BV1xx411c7mD','https://www.youtube.com/watch?v=BaW_jenozKc']){
  const report=await runSourceAcceptance({input:sourceInput(url,'en',true),python:executable});
  assert.equal(report.passed,true,JSON.stringify(report));
  assert.equal(report.extractor_verified,'2026.08.19');assert.equal(report.captions.state,'ready');assert.equal(report.captions.cue_count,1);
  assert.equal(report.media.state,'ready');assert.equal(report.media.subtitle_check,'not_requested');
  assert.equal(report.persist.document_saved,true);assert.equal(report.persist.media_saved,true);
  assert.equal(report.restart.media_hash_verified,true);assert.equal(report.restart.range_verified,true);
  assert.equal(report.restart.playback_verified,false);assert.equal(report.asr_attempted,false);assert.equal(report.platform_credentials,false);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});
