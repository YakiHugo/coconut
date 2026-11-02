"""Authored upstream fixtures, not evidence of real platform availability."""
import contextlib
import importlib.util
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

AVAILABLE = importlib.util.find_spec('yt_dlp') is not None
if AVAILABLE:
    from scripts import owner_video_source as source
    from test_public_video_caption_guard import PLAYER, STATE, YOUTUBE, BILIBILI, VTT
    from yt_dlp.networking import Request, Response
    from yt_dlp.networking.common import RequestDirector
    from yt_dlp.networking.exceptions import HTTPError

MEDIA = b'\x00\x00\x00\x18ftypM4A ' + b'authored media bytes'
CDN = 'https://rr1---sn-abcdef.googlevideo.com/videoplayback?sig=public'
FORMAT = {'url':CDN,'ext':'m4a','vcodec':'none','acodec':'mp4a.40.2','protocol':'https','abr':64,'format_id':'140','language':'en','language_preference':10}
INFO = {'id':'BaW_jenozKc','duration':4,'title':'Authored','live_status':'not_live','formats':[FORMAT],'subtitles':{},'automatic_captions':{}}


def fixture(request):
    url=request.url
    if '/watch?' in url: body=('<script>var ytInitialPlayerResponse = '+json.dumps(PLAYER)+';</script>').encode()
    elif '/api/timedtext?' in url: body=VTT
    elif '/video/' in url: body=('<script>window.__INITIAL_STATE__='+json.dumps(STATE)+';</script>').encode()
    elif '/pagelist?' in url: body=json.dumps({'code':0,'data':STATE['videoData']['pages']}).encode()
    elif '/nav' in url: body=json.dumps({'code':-101,'data':{'wbi_img':{'img_url':'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png','sub_url':'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'}}}).encode()
    elif '/playurl?' in url: body=b'{"code":0,"data":{"dash":{"video":[],"audio":[]},"timelength":4000}}'
    elif '/wbi/v2?' in url: body=b'{"code":0,"data":{"subtitle":{"subtitles":[{"lan":"en","subtitle_url":"//aisubtitle.hdslb.com/bfs/subtitle/fixture.json"}]}}}'
    elif '/bfs/subtitle/' in url: body=b'{"body":[{"from":0,"to":4,"content":"Authored original fixture."}]}'
    else: raise AssertionError('Unexpected authored fixture request: '+url)
    return Response(io.BytesIO(body),url,{'Content-Length':str(len(body))})


@unittest.skipUnless(AVAILABLE, 'Pinned yt-dlp required; native contract CI installs it')
class NativeSourceTests(unittest.TestCase):
    def test_official_extractors_call_native_director_and_output_existing_captions(self):
        for url,provider in [(YOUTUBE,'youtube'),(BILIBILI,'bilibili')]:
            with self.subTest(provider=provider),patch.object(RequestDirector,'send',side_effect=fixture) as send:
                result=source.acquire_video(url,'en')
                self.assertNotIn('status',result,result)
                self.assertEqual(result['source']['extractor'],provider)
                self.assertEqual(result['source']['url'],url)
                self.assertIn(b'Authored original fixture.',result['bytes'])
                self.assertGreater(send.call_count,0)

    def test_subtitle_po_requirement_stops_locally_without_asserting_video_or_media_denial(self):
        for marker in ('xpe', 'xpv'):
            for automatic in (False, True):
                for action in ('captions', 'fallback', 'source'):
                    player = copy.deepcopy(PLAYER)
                    track = player['captions']['playerCaptionsTracklistRenderer']['captionTracks'][0]
                    track['baseUrl'] += '&exp=' + marker
                    if automatic:
                        track.update(kind='asr', vssId='a.en')
                    with self.subTest(marker=marker, automatic=automatic, action=action), tempfile.TemporaryDirectory() as tmp, patch.dict(globals(), {'PLAYER': player}), patch.object(RequestDirector, 'send', side_effect=fixture) as send, patch.object(source, 'download_media', side_effect=AssertionError('media must not start')) as media:
                        output = Path(tmp) / 'public-media.bin'
                        result = source.acquire_video(YOUTUBE, 'en', **({} if action == 'captions' else {'output': output, 'purpose': 'source' if action == 'source' else None}))
                        self.assertEqual(result, {'status': 'subtitle_token_required', 'diagnostic': {'stage': 'metadata', 'reason': 'subtitle_token_required', 'requests_attempted': 1, 'responses_received': 1}})
                        self.assertEqual([call.args[0].url for call in send.call_args_list], [YOUTUBE])
                        media.assert_not_called()
                        self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_player_login_remains_distinct_from_subtitle_po_requirement(self):
        player = copy.deepcopy(PLAYER)
        player['playabilityStatus'] = {'status': 'LOGIN_REQUIRED'}
        with patch.dict(globals(), {'PLAYER': player}), patch.object(RequestDirector, 'send', side_effect=fixture) as send:
            result = source.acquire_video(YOUTUBE, 'en')
            self.assertEqual(result['status'], 'access_restricted')
            self.assertEqual(result['diagnostic']['reason'], 'login_required')
            self.assertEqual(send.call_count, 1)

    def test_native_network_does_not_use_legacy_transport(self):
        from scripts import public_video_caption_guard as legacy
        with patch.object(legacy.VideoTransport,'send',side_effect=AssertionError('legacy transport used')),patch.object(RequestDirector,'send',side_effect=fixture):
            self.assertIn('bytes',source.acquire_video(YOUTUBE,'en'))

    def test_http_denial_is_terminal_not_absence_or_another_client(self):
        for status in (401,403,412,429):
            with self.subTest(status=status),patch.object(RequestDirector,'send',side_effect=HTTPError(Response(io.BytesIO(),YOUTUBE,{},status=status))) as send:
                result=source.acquire_video(YOUTUBE,'en')
                self.assertEqual(result['status'],'access_restricted',result)
                self.assertEqual(send.call_count,1)

    def test_native_httpfd_download_is_bounded_and_keeps_identity(self):
        def metadata(owner,url):
            return copy.deepcopy(INFO)
        with tempfile.TemporaryDirectory() as tmp,patch.object(source,'verified_info',side_effect=metadata),patch.object(RequestDirector,'send',return_value=Response(io.BytesIO(MEDIA),CDN,{'Content-Type':'audio/mp4','Content-Length':str(len(MEDIA))})) as send:
            output=Path(tmp)/'public-media.bin'
            result=source.acquire_video(YOUTUBE,'en',output=output)
            self.assertEqual(result['status'],'media_ready',result)
            self.assertEqual(output.read_bytes(),MEDIA)
            self.assertEqual(result['source']['id'],'BaW_jenozKc')
            self.assertEqual(len(list(Path(tmp).iterdir())),1)
            self.assertTrue(send.call_args.args[0].headers.get('Range').startswith('bytes=0-'))

    def test_oversize_unknown_length_never_leaves_partial_file(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(source,'verified_info',return_value=copy.deepcopy(INFO)),patch.object(source,'MAX_MEDIA',20),patch.object(RequestDirector,'send',return_value=Response(io.BytesIO(MEDIA),CDN,{'Content-Type':'audio/mp4'})):
            output=Path(tmp)/'public-media.bin'
            result=source.acquire_video(YOUTUBE,'en',output=output)
            self.assertNotEqual(result['status'],'media_ready')
            self.assertEqual(list(Path(tmp).iterdir()),[])

    def test_inline_caption_limit_is_checked_before_file_output(self):
        info=copy.deepcopy(INFO);info['subtitles']={'en':[{'ext':'srt','data':'x'*(source.MAX_CAPTION+1)}]}
        with patch.object(source,'verified_info',return_value=info),patch.object(source.OwnerVideoDL,'process_ie_result') as write:
            self.assertEqual(source.acquire_video(YOUTUBE,'en')['status'],'guard_stopped')
            write.assert_not_called()

    def test_media_action_retains_found_caption_status(self):
        info=copy.deepcopy(INFO);info['subtitles']={'en':[{'ext':'srt','data':'1\n00:00:00,000 --> 00:00:04,000\nAuthored\n'}]}
        with tempfile.TemporaryDirectory() as tmp,patch.object(source,'verified_info',return_value=info),patch.object(RequestDirector,'send',return_value=Response(io.BytesIO(MEDIA),CDN,{'Content-Type':'audio/mp4','Content-Length':str(len(MEDIA))})):
            output=Path(tmp)/'public-media.bin'
            self.assertEqual(source.acquire_video(YOUTUBE,'en',output=output)['status'],'captions_available')
            self.assertFalse(output.exists())
            result=source.acquire_video(YOUTUBE,'en',output=output,purpose='source')
            self.assertEqual(result['source']['subtitle_check'],'not_requested',result)


    def test_bilibili_explicit_media_never_queries_restricted_subtitles(self):
        # Official BiliBiliIE: webpage/pagelist/playinfo -> native HttpFD. The
        # subtitle endpoint itself still returns a terminal login restriction.
        urls=[]
        def public_media(request):
            urls.append(request.url)
            if '/playurl?' in request.url:
                body=json.dumps({'code':0,'data':{'dash':{'video':[],'audio':[{'id':30280,'baseUrl':'https://upos-sz-mirror.bilivideo.com/public.m4s','mimeType':'audio/mp4','codecs':'mp4a.40.2','bandwidth':64000}]},'timelength':4000}}).encode()
                return Response(io.BytesIO(body),request.url,{'Content-Length':str(len(body))})
            if '/wbi/v2?' in request.url:
                body=b'{"code":0,"data":{"need_login_subtitle":true}}'
                return Response(io.BytesIO(body),request.url,{'Content-Length':str(len(body))})
            if request.url.endswith('/public.m4s'):
                return Response(io.BytesIO(MEDIA),request.url,{'Content-Type':'audio/mp4','Content-Length':str(len(MEDIA))})
            return fixture(request)
        with tempfile.TemporaryDirectory() as tmp,patch.object(RequestDirector,'send',side_effect=public_media):
            restricted=source.acquire_video(BILIBILI,'zh')
            self.assertEqual(restricted['status'],'access_restricted',restricted)
            self.assertEqual(restricted['diagnostic']['reason'],'subtitle_login_required')
            urls.clear()
            result=source.acquire_video(BILIBILI,'zh',output=Path(tmp)/'public-media.bin',purpose='source')
            self.assertEqual(result['status'],'media_ready',result)
            self.assertEqual(result['source']['subtitle_check'],'not_requested')
            self.assertFalse(any('/wbi/v2?' in url or '/bfs/subtitle/' in url for url in urls),urls)

    def test_explicit_media_does_not_bypass_media_denial(self):
        for status in (401,403,412,429):
            with self.subTest(status=status),tempfile.TemporaryDirectory() as tmp,patch.object(source,'verified_info',return_value=copy.deepcopy(INFO)),patch.object(RequestDirector,'send',side_effect=HTTPError(Response(io.BytesIO(),CDN,{},status=status))) as send:
                output=Path(tmp)/'public-media.bin'
                result=source.acquire_video(YOUTUBE,'en',output=output,purpose='source')
                self.assertEqual(result['status'],'access_restricted',result)
                self.assertEqual(send.call_count,1)
                self.assertFalse(output.exists())

    def test_no_ambient_proxy_and_env_only_precedence(self):
        with patch.dict(source.os.environ,{'HTTP_PROXY':'http://ambient.invalid:123','HTTPS_PROXY':'http://ambient.invalid:123'}):
            self.assertEqual(source.network_options(None),{'all':'__noproxy__'})
            self.assertEqual(source.network_options({'mode':'environment','environment':{'HTTP_PROXY':'http://upper.invalid:12','http_proxy':'http://lower.invalid:34','NO_PROXY':'example.com'}}),{'http':'http://lower.invalid:34','https':'http://lower.invalid:34','no':'example.com'})
        with self.assertRaises(source.StopProof):source.network_options({'mode':'environment','environment':{'HTTP_PROXY':'http://user:secret@proxy.invalid:12'}})

if __name__=='__main__':unittest.main()
