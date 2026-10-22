"""Authored offline media boundaries; these are not real-platform evidence."""
import contextlib
import copy
import io
import importlib.util
import tempfile
import time
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
        self.assertIsNone(media.choose_audio({'formats':[default]},'youtube'))
        self.assertIsNone(media.choose_audio({'formats':[foreign_default]},'youtube'))
        self.assertIsNone(media.choose_audio({'formats':[default,{**default,'language':'fr'}]},'youtube'))

    def test_bilibili_single_cid_bitrate_variants_keep_language_unknown(self):
        item={**FORMAT,'url':'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/audio.m4s?deadline=1','language':None,'language_preference':None}
        selected=media.choose_audio({'formats':[{**item,'abr':128},item]},'bilibili')
        self.assertEqual(selected['abr'],64)
        self.assertIsNone(selected['_audio_language'])
        self.assertEqual(selected['_audio_language_basis'],'provider_single_source')
        self.assertIsNone(media.choose_audio({'formats':[{**item,'language':'zh'}]},'bilibili'))

    def test_bilibili_preselects_standard_https_backup_from_exact_audio_object(self):
        primary='https://xy1x2x3x4xy.mcdn.bilivideo.cn:8082/upgcxcode/audio.m4s?sign=fixture'
        backup='https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/audio.m4s?deadline=1'
        item={**FORMAT,'url':primary,'format_id':'30216','language':None,'language_preference':None}
        raw={'id':30216,'baseUrl':primary,'backupUrl':['https://evil.test/audio.m4s',backup]}
        chosen=media.select_bilibili_audio_urls([item],{'dash':{'audio':[raw]}})
        self.assertEqual(chosen[0]['url'],backup)
        self.assertEqual(item['url'],primary)
        self.assertEqual(media.choose_audio({'formats':chosen},'bilibili')['url'],backup)
        for source in [{**raw,'id':30280},{**raw,'baseUrl':primary+'other'},
                       {**raw,'backupUrl':backup},{**raw,'backupUrl':['https://127.0.0.1/audio.m4s']}]:
            unchanged=media.select_bilibili_audio_urls([item],{'dash':{'audio':[source]}})
            self.assertIsNone(media.choose_audio({'formats':unchanged},'bilibili'))
        self.assertEqual(media.select_bilibili_audio_urls([item],{'dash':{'audio':[raw,raw]}}),[item])
        existing={**item,'url':backup}
        self.assertEqual(media.select_bilibili_audio_urls([existing],{'dash':{'audio':[raw]}}),[existing])

    @unittest.skipUnless(importlib.util.find_spec('yt_dlp'), 'Pinned yt-dlp required')
    def test_pinned_bilibili_extractor_retains_verified_backup_for_audio_selection(self):
        import yt_dlp
        primary='https://xy1x2x3x4xy.mcdn.bilivideo.cn:8082/upgcxcode/audio.m4s'
        backup='https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/audio.m4s'
        play={'dash':{'video':[],'audio':[{'id':30216,'baseUrl':primary,'backup_url':[backup],
                                        'mimeType':'audio/mp4','codecs':'mp4a.40.2','bandwidth':64000}]}}
        transport=guard.VideoTransport('https://www.bilibili.com/video/BV1xx411c7mD')
        with guard.guarded_extractors(transport), yt_dlp.YoutubeDL({'quiet':True}) as downloader:
            formats=downloader.get_info_extractor('BiliBili').extract_formats(play)
        self.assertEqual(formats[0]['url'],backup)
        self.assertEqual(formats[0]['format_id'],'30216')


    def test_combined_public_mp4_is_source_media_not_invented_original_voice(self):
        item={**FORMAT,'ext':'mp4','vcodec':'avc1.42001E','format_id':'18','language':None,'language_preference':None}
        selected=media.choose_media({'formats':[item]},'youtube')
        self.assertEqual((selected['_kind'],selected['_type']),('video','video/mp4'))
        self.assertEqual(selected['_audio_role'],'unknown')
        self.assertIsNone(selected['_audio_language'])
        self.assertEqual(selected['_audio_language_basis'],'platform_video_stream')
        default={**item,'language':'en','language_preference':5}
        self.assertEqual(media.choose_media({'formats':[default]},'youtube')['_audio_role'],'default')
        for change in [{'format_id':'22'},{'fragments':[{}]},{'has_drm':True},{'protocol':'m3u8_native'},{'acodec':'none'},{'language':'en','language_preference':-1},{'url':CDN+'&pot=token'}]:
            self.assertIsNone(media.choose_media({'formats':[{**item,**change}]},'youtube'))
        self.assertIsNone(media.choose_media({'formats':[item,{**item,'url':CDN+'&other=1'}]},'youtube'))
        self.assertIsNone(media.choose_media({'formats':[default]},'youtube','fr'))
        legacy={'url':'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/source.mp4?deadline=1','ext':'mp4','protocol':'https','format_id':'16','filesize':1234}
        self.assertIsNone(media.choose_media({'formats':[legacy]},'bilibili'))
        marked=guard.mark_single_bilibili_progressive([legacy],{'durl':[{'url':legacy['url']}]})
        selected=media.choose_media({'formats':marked},'bilibili')
        self.assertEqual(selected['_kind'],'video')
        self.assertEqual(selected['_audio_language_basis'],'provider_single_source')
        self.assertIsNone(selected['_audio_language'])
        for raw in [[],[{'url':legacy['url']},{'url':legacy['url']+'other'}],[{'url':'https://different.example'}]]:
            self.assertIsNone(media.choose_media({'formats':guard.mark_single_bilibili_progressive([copy.deepcopy(legacy)],{'durl':raw})},'bilibili'))
        self.assertIsNone(media.choose_media({'formats':[{**legacy,'_coconut_single_durl':True,'fragments':[{}]}]},'bilibili'))

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

    def test_media_transfer_outlives_caption_budget_but_still_has_a_deadline(self):
        transport=guard.VideoTransport(URL)
        transport.started=time.monotonic()-150
        with tempfile.TemporaryDirectory() as td,patch.object(transport.opener,'open',return_value=Response()) as opened:
            result=media.download_verified_audio(INFO,transport,Path(td)/'audio.m4a',URL)
            self.assertEqual(result['status'],'media_ready')
            self.assertEqual(opened.call_count,1)
        transport.started=time.monotonic()-media.MAX_MEDIA_SECONDS-1
        with tempfile.TemporaryDirectory() as td,patch.object(transport.opener,'open') as opened:
            with self.assertRaises(guard.StopProof) as stopped:
                media.download_verified_audio(INFO,transport,Path(td)/'audio.m4a',URL)
            self.assertEqual(stopped.exception.outcome,'budget_exceeded')
            opened.assert_not_called()

    def test_same_object_ranges_validate_offsets_and_assemble_complete_media(self):
        transport=guard.VideoTransport(URL)
        requests=[]
        def piece(request,timeout=None):
            requests.append(request)
            start=int(request.get_header('Range').split('=')[1].split('-')[0])
            end=min(start+16,len(BODY))-1
            response=Response(BODY[start:end+1],{'Content-Range':f'bytes {start}-{end}/{len(BODY)}','ETag':'"same-object"'})
            if start:self.assertEqual(request.get_header('If-range'),'"same-object"')
            response.status=206
            return response
        with tempfile.TemporaryDirectory() as td,patch.object(media,'MEDIA_RANGE_BYTES',16),patch.object(transport.opener,'open',side_effect=piece):
            output=Path(td)/'audio.m4a'
            result=media.download_verified_audio(INFO,transport,output,URL)
            self.assertEqual(output.read_bytes(),BODY)
            self.assertEqual(result['media']['bytes'],len(BODY))
            self.assertEqual(len(requests),(len(BODY)+15)//16)
            self.assertTrue(all(request.full_url==CDN for request in requests))
            self.assertEqual(transport.responses,len(requests))

    def test_inconsistent_range_or_ignored_later_range_stops_without_retry(self):
        for bad in ['offset','total','length','ignored','changed_object']:
            transport=guard.VideoTransport(URL)
            calls=[]
            def piece(request,timeout=None):
                calls.append(request)
                start=0 if len(calls)==1 else 16
                end=min(start+16,len(BODY))-1
                header=f'bytes {start}-{end}/{len(BODY)}'
                if len(calls)>1:
                    if bad=='offset':header=f'bytes 0-{end}/{len(BODY)}'
                    if bad=='total':header=f'bytes {start}-{end}/{len(BODY)+1}'
                response=Response(BODY[start:end+1],{'Content-Range':header,'ETag':'"same-object"'})
                response.status=206
                if len(calls)>1 and bad=='length':response.headers['Content-Length']='1'
                if len(calls)>1 and bad=='ignored':response.status=200
                if len(calls)>1 and bad=='changed_object':response.headers['ETag']='"different-object"'
                return response
            with self.subTest(bad=bad),tempfile.TemporaryDirectory() as td,patch.object(media,'MEDIA_RANGE_BYTES',16),patch.object(transport.opener,'open',side_effect=piece):
                with self.assertRaises(guard.StopProof):
                    media.download_verified_audio(INFO,transport,Path(td)/'audio.m4a',URL)
                self.assertEqual(len(calls),2)

if __name__=='__main__': unittest.main()
