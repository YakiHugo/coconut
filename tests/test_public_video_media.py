"""Authored offline media boundaries; these are not real-platform evidence."""
import contextlib
import copy
import io
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch
from scripts import public_video_media as media
from scripts import public_video_caption_guard as guard

URL='https://www.youtube.com/watch?v=BaW_jenozKc'
CDN='https://rr1---sn-abcdef.googlevideo.com/videoplayback?expire=2000000000&sig=public-signature'
BODY=b'\x00\x00\x00\x18ftypM4A '+b'authored container fixture'
FORMAT={'url':CDN,'ext':'m4a','vcodec':'none','acodec':'mp4a.40.2','protocol':'https','abr':64,'format_id':'140','language':'en','language_preference':10}
INFO={'id':'BaW_jenozKc','duration':4,'title':'Authored fixture','live_status':'not_live','formats':[FORMAT],'subtitles':{},'automatic_captions':{}}
class Response:
    status=200
    def __init__(self, body=BODY, headers=None):
        self.body=io.BytesIO(body)
        self.headers={'Content-Type':'audio/mp4','Content-Length':str(len(body)),**(headers or {})}
    def read(self,size): return self.body.read(size)
    def __enter__(self): return self
    def __exit__(self,*args): self.body.close()

class MediaTests(unittest.TestCase):
    def test_exact_public_cdn_and_no_token_or_manifest_scope(self):
        self.assertTrue(media.audio_url_allowed(CDN,'youtube'))
        self.assertTrue(media.audio_url_allowed('https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/01/audio.m4s?deadline=1&upsig=public','bilibili'))
        for value in [CDN.replace('https:','http:'),CDN.replace('googlevideo.com','googlevideo.com.evil.test'),
                CDN.replace('rr1---sn-abcdef.googlevideo.com','127.0.0.1'),
                CDN.replace('https://','https://user:password@'),CDN+'&pot=token',
                CDN+'&access_token=token',CDN+'#fragment',CDN.replace('/videoplayback','/manifest.m3u8')]:
            self.assertFalse(media.audio_url_allowed(value,'youtube'),value)
        for field,value in [('has_drm',True),('protocol','m3u8_native'),('vcodec','h264'),('ext','webm'),('fragments',[{}]),('filesize',media.MAX_MEDIA+1)]:
            item={**FORMAT,field:value}
            self.assertIsNone(media.choose_audio({'formats':[item]},'youtube'))
        self.assertEqual(media.choose_audio({'formats':[{**FORMAT,'abr':128},FORMAT]},'youtube')['format_id'],FORMAT['format_id'])

    def test_original_audio_wins_over_lower_bitrate_dub_or_description(self):
        original = {**FORMAT,'abr':128}
        dubbed = {**FORMAT,'abr':32,'language':'fr','language_preference':5,'format_note':'French dubbed'}
        descriptive = {**FORMAT,'abr':16,'language':'en-desc','language_preference':-10,'format_note':'English descriptive'}
        chosen = media.choose_audio({'formats':[dubbed,descriptive,original]},'youtube')
        self.assertEqual(chosen['abr'],128)
        self.assertEqual(chosen['_audio_language'],'en')
        self.assertEqual(chosen['_audio_language_basis'],'platform_original')
        self.assertIsNone(media.choose_audio({'formats':[original]},'youtube','fr'))
        self.assertIsNone(media.choose_audio({'formats':[dubbed,descriptive]},'youtube'))
        # An ineligible original format still establishes the real language;
        # do not erase that evidence and fall through to a default dubbed M4A.
        foreign_default={**FORMAT,'language':'fr','language_preference':5}
        for change in [{'ext':'webm'}, {'has_drm':True}, {'protocol':'m3u8_native'}, {'vcodec':'h264'}]:
            self.assertIsNone(media.choose_audio({'formats':[{**original,**change},foreign_default]},'youtube'))
        unknown={**FORMAT,'language':None,'language_preference':-1}
        self.assertIsNone(media.choose_audio({'formats':[unknown]},'youtube'))
        default={**FORMAT,'language_preference':5}
        self.assertEqual(media.choose_audio({'formats':[default]},'youtube')['_audio_language_basis'],'unambiguous_platform_default')
        self.assertIsNone(media.choose_audio({'formats':[default,{**default,'language':'fr'}]},'youtube'))

    def exercise(self, info=None, denial=None, response=None):
        transport=guard.VideoTransport(URL)
        transport.youtube_access_verified=True
        opened=[]
        def fetch(*args,**kwargs):
            if denial: raise guard.StopProof(denial)
            guard.subtitle_import.select_track(copy.deepcopy(INFO if info is None else info),None)
            return None
        def open_request(request,timeout=None):
            opened.append(request)
            return response or Response()
        with tempfile.TemporaryDirectory() as td:
            output=Path(td)/'public-audio.m4a'
            with patch.object(guard,'VideoTransport',return_value=transport),patch.object(guard,'guarded_extractors',side_effect=lambda _transport:contextlib.nullcontext()),patch.object(guard.subtitle_import,'fetch_subtitle_document',side_effect=fetch),patch.object(transport.opener,'open',side_effect=open_request):
                result=media.extract_public_video_audio(URL,output=output)
            contents=output.read_bytes() if output.exists() else None
        return result,opened,contents

    def test_only_verified_absence_reaches_one_audio_request(self):
        result,opened,contents=self.exercise()
        self.assertEqual(result['status'],'media_ready')
        self.assertEqual(contents,BODY);self.assertEqual(len(opened),1)
        self.assertIsNone(opened[0].get_header('Cookie'))
        self.assertEqual(opened[0].get_header('Referer'),URL)
        self.assertEqual(result['source']['subtitle_check'],'no_matching_captions')
        self.assertNotIn('url',result['media'])
        for denial in ['login_required','subtitle_login_required','subtitle_token_required','http_access_denied','transport_unavailable','metadata_incomplete','redirect_stopped']:
            result,opened,contents=self.exercise(denial=denial)
            self.assertNotEqual(result['status'],'media_ready');self.assertEqual(opened,[]);self.assertIsNone(contents)
        info=copy.deepcopy(INFO);info['id']='different'
        self.assertEqual(self.exercise(info)[1],[])
        info=copy.deepcopy(INFO);info['subtitles']={'en':[{'ext':'vtt','url':'https://example.com/a.vtt'}],'fr':[{'ext':'vtt','url':'https://example.com/b.vtt'}]}
        result,opened,_=self.exercise(info)
        self.assertEqual(result['status'],'language_required');self.assertEqual(opened,[])

    def test_bad_media_response_cannot_leave_a_partial_file(self):
        for response in [Response(body=b'<html>login</html>'),Response(headers={'Content-Type':'text/html'}),Response(headers={'Content-Encoding':'gzip'}),Response(headers={'Content-Length':str(media.MAX_MEDIA+1)}),Response(headers={'Content-Length':'1'})]:
            result,opened,contents=self.exercise(response=response)
            self.assertNotEqual(result['status'],'media_ready');self.assertEqual(len(opened),1);self.assertIsNone(contents)

    def test_captions_appearing_again_prevent_audio(self):
        with tempfile.TemporaryDirectory() as td:
            output=Path(td)/'public-audio.m4a'
            with patch.object(guard,'extract_public_video_captions',return_value={'bytes':b'captions'}):
                result=media.extract_public_video_audio(URL,output=output)
            self.assertEqual(result,{'status':'captions_available'});self.assertFalse(output.exists())

    def test_cdn_denial_does_not_try_a_backup(self):
        transport=guard.VideoTransport(URL)
        info={**INFO,'formats':[FORMAT,{**FORMAT,'url':CDN+'&other=1'}]}
        with tempfile.TemporaryDirectory() as td,patch.object(transport.opener,'open',side_effect=urllib.error.HTTPError(CDN,403,'',{},io.BytesIO())) as opened:
            with self.assertRaises(guard.StopProof) as stopped:
                media.download_verified_audio(info,transport,Path(td)/'public-audio.m4a',URL)
            self.assertEqual(stopped.exception.outcome,'http_access_denied');self.assertEqual(opened.call_count,1)

if __name__=='__main__': unittest.main()
