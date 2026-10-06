import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from unittest.mock import patch
from serve import build_server

class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.server,self.jobs=build_server(Path(self.temp.name),0)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.base=f'http://127.0.0.1:{self.server.server_port}'
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.jobs.close();self.thread.join();self.temp.cleanup()
    def test_actual_upload_to_readable_document(self):
        request=Request(self.base+'/api/uploads?filename=test.srt', data=b'1\n00:00:01,000 --> 00:00:02,000\nHello Coconut\n',headers={'Content-Type':'application/octet-stream'})
        with urlopen(request) as response: job=json.load(response)
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            with urlopen(self.base+'/api/jobs/'+job['id']) as response: current=json.load(response)
            if current['status'] in ('done','failed'):break
            time.sleep(.02)
        self.assertEqual(current['status'],'done')
        with urlopen(self.base+'/api/jobs/'+job['id']+'/result') as response: doc=json.load(response)
        self.assertEqual(doc['segments'][0]['text'],'Hello Coconut')
        self.assertEqual(doc['title'], 'test')
    def test_x_status_is_queued_but_profile_and_arbitrary_hosts_are_rejected(self):
        self.jobs.close()  # Validate admission without a network-dependent worker.
        url='https://x.com/example/status/123?s=20'
        with urlopen(Request(self.base+'/api/jobs',data=json.dumps({'url':url}).encode(),headers={'Content-Type':'application/json'})) as response:
            self.assertEqual(response.status,201)
            self.assertEqual(json.load(response)['status'],'queued')
        for url in ['https://x.com/example','https://x.com.evil.test/example/status/123','https://127.0.0.1/example/status/123']:
            with self.subTest(url=url), self.assertRaises(HTTPError) as error:
                urlopen(Request(self.base+'/api/jobs',data=json.dumps({'url':url}).encode(),headers={'Content-Type':'application/json'}))
            self.assertEqual(error.exception.code,400)

    def test_subscription_routes_require_explicit_data_and_usage_consent(self):
        for path in ['/api/ask','/api/translate-subscription']:
            with patch('serve.ask') as ask, patch('serve.subscription_translate') as translate:
                with self.assertRaises(HTTPError) as raised:
                    urlopen(Request(self.base+path,data=b'{}',headers={'Content-Type':'application/json'}))
                self.assertEqual(raised.exception.code,400);ask.assert_not_called();translate.assert_not_called()

    def test_subscription_route_forwards_only_explicit_context_to_fake_provider(self):
        source={'id':'target','text':'until approved','position':1,'start':1,'end':2}
        context={'id':'context','text':'Do not send','position':0,'start':0,'end':1}
        payload={'source':'en','target':'zh','provider':'codex','segments':[source],'context':[context],'glossary':[{'source':'approved','target':'批准'}],'memory':[{'id':'context','source_text':'Do not send','text':'不要发送'}],'consent':True}
        with patch('ai_reader.codex_answer',return_value={'translations':[{'id':'target','text':'获得批准之前'}]}) as provider:
            with urlopen(Request(self.base+'/api/translate-subscription',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})) as response:
                result=json.load(response)
        self.assertEqual(result['translations'][0]['context_version'],2)
        self.assertEqual([t['id'] for t in result['translations']],['target'])
        sent=json.loads(provider.call_args.args[0]);self.assertEqual(sent['target_ids'],['target']);self.assertEqual(sent['cues'],[context,source]);self.assertEqual(sent['glossary'],payload['glossary']);self.assertEqual(sent['translation_memory'],payload['memory'])

    def test_cross_origin_and_unscoped_host_rejected(self):
        for headers in [{'Origin':'https://evil.example'},{'Host':'evil.example'}]:
            with self.assertRaises(HTTPError) as error:urlopen(Request(self.base+'/api/jobs',headers=headers))
            self.assertEqual(error.exception.code,403)
    def test_path_traversal_not_served(self):
        with self.assertRaises(HTTPError) as error:urlopen(self.base+'/../serve.py')
        self.assertEqual(error.exception.code,404)
    def test_invalid_source_rejected(self):
        req=Request(self.base+'/api/jobs',data=b'{"url":"http://127.0.0.1/private"}',headers={'Content-Type':'application/json'})
        with self.assertRaises(HTTPError) as error:urlopen(req)
        self.assertEqual(error.exception.code,400)


class MediaServerTests(unittest.TestCase):
    """Transport/security checks use stored fixtures, never ASR/model downloads."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server, self.jobs = build_server(Path(self.temp.name), 0)
        self.jobs.close()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.payload = b'0123456789abcdefghijklmnopqrstuvwxyz'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def upload(self, filename='recording.wav', *, done=True):
        request = Request(self.base + '/api/uploads?filename=' + filename,
                          data=self.payload,
                          headers={'Content-Type': 'application/octet-stream'})
        with urlopen(request) as response:
            job = json.load(response)
        if done:
            self.complete(job['id'])
        return job['id']

    def complete(self, identifier):
        folder = self.jobs.directory / identifier
        folder.mkdir(exist_ok=True)
        (folder / 'transcript.raw.json').write_text(json.dumps({
            'title': 'source', 'source_url': '',
            'source_media': {'job_id': 'untrusted', 'url': 'file:///private'},
            'segments': [{'id': 's1', 'start': 0, 'end': 2, 'text': 'Fixture'}],
        }))
        with self.jobs.connect() as db:
            db.execute("UPDATE jobs SET status='done' WHERE id=?", (identifier,))

    def assert_error(self, path, status, *, headers=None, method='GET'):
        with self.assertRaises(HTTPError) as raised:
            urlopen(Request(self.base + path, headers=headers or {}, method=method))
        with raised.exception as error:
            self.assertEqual(error.code, status)
            self.assertNotIn(self.temp.name.encode(), error.read())
            return error.headers

    def test_full_media_and_head_are_bounded_and_typed(self):
        identifier = self.upload()
        path = '/api/jobs/' + identifier + '/media'
        with urlopen(self.base + path) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers['Content-Type'], 'audio/wav')
            self.assertEqual(response.headers['Content-Length'], str(len(self.payload)))
            self.assertEqual(response.headers['Accept-Ranges'], 'bytes')
            self.assertEqual(response.headers['Cross-Origin-Resource-Policy'], 'same-origin')
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertEqual(response.read(), self.payload)
        with urlopen(Request(self.base + path, method='HEAD')) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers['Content-Length'], str(len(self.payload)))
            self.assertEqual(response.read(), b'')

    def test_valid_byte_ranges_support_browser_seeking(self):
        identifier = self.upload()
        for value, start, end in [('bytes=0-3', 0, 3), ('bytes=10-', 10, 35),
                                  ('bytes=-4', 32, 35), ('bytes=34-999', 34, 35),
                                  ('bytes=-999', 0, 35), ('bytes=0-0', 0, 0)]:
            with self.subTest(range=value):
                request = Request(self.base + '/api/jobs/' + identifier + '/media',
                                  headers={'Range': value})
                with urlopen(request) as response:
                    self.assertEqual(response.status, 206)
                    self.assertEqual(response.headers['Content-Range'], f'bytes {start}-{end}/36')
                    self.assertEqual(int(response.headers['Content-Length']), end - start + 1)
                    self.assertEqual(response.read(), self.payload[start:end + 1])
        with urlopen(Request(self.base + '/api/jobs/' + identifier + '/media',
                             headers={'Range': 'bytes=10-20'}, method='HEAD')) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.headers['Content-Range'], 'bytes 10-20/36')
            self.assertEqual(response.read(), b'')

    def test_invalid_and_unsatisfiable_ranges_return_416(self):
        identifier = self.upload()
        for value in ['bytes=36-', 'bytes=9-4', 'bytes=-0', 'bytes=-', 'bytes=a-b',
                      'bytes=0-1,3-4', 'items=0-2', 'bytes=+1-3', 'bytes=1.0-2',
                      'bytes=9999999999999999999999999-']:
            with self.subTest(range=value):
                headers = self.assert_error('/api/jobs/' + identifier + '/media', 416,
                                            headers={'Range': value})
                self.assertEqual(headers['Content-Range'], 'bytes */36')
                self.assertEqual(headers['Content-Length'], '0')

    def test_completed_upload_result_has_only_durable_safe_association(self):
        identifier = self.upload('lecture.mp4')
        with urlopen(self.base + '/api/jobs/' + identifier + '/result') as response:
            document = json.load(response)
        self.assertEqual(document['source_media'], {'job_id': identifier, 'kind': 'video'})
        self.assertEqual(document['title'], 'lecture')
        self.assertNotIn(self.temp.name, json.dumps(document))
        # Reading a fresh queue object retains the association after a restart.
        from import_jobs import ImportJobs
        restored = ImportJobs(self.jobs.directory)
        self.assertEqual(restored.result(identifier)['source_media'], document['source_media'])

    def test_subtitles_and_url_jobs_never_expose_media(self):
        subtitle = self.upload('captions.srt')
        video = self.jobs.enqueue('https://youtube.com/watch?v=abcdefghijk', 'Video')['id']
        self.complete(video)
        # A downloader artifact does not turn a URL job into an uploaded-media job.
        (self.jobs.directory / video / 'source.mp4').write_bytes(self.payload)
        for identifier in [subtitle, video]:
            with self.subTest(job=identifier):
                self.assert_error('/api/jobs/' + identifier + '/media', 404)
                self.assertNotIn('source_media', self.jobs.result(identifier))

    def test_missing_and_incomplete_jobs_are_not_playable(self):
        identifier = self.upload(done=False)
        self.assert_error('/api/jobs/' + identifier + '/media', 409)
        for status in ['running', 'failed', 'cancelled', 'interrupted']:
            with self.jobs.connect() as db:
                db.execute('UPDATE jobs SET status=? WHERE id=?', (status, identifier))
            self.assert_error('/api/jobs/' + identifier + '/media', 409)
        self.assert_error('/api/jobs/' + '0' * 32 + '/media', 404)
        self.complete(identifier)
        (self.jobs.directory / identifier / 'source.wav').unlink()
        self.assert_error('/api/jobs/' + identifier + '/media', 404)
        self.assertNotIn('source_media', self.jobs.result(identifier))

    def test_traversal_arbitrary_paths_and_symlinks_are_not_served(self):
        identifier = self.upload()
        private = self.jobs.directory / 'private.wav'
        private.write_bytes(b'private')
        for suffix in ['/media/../../private.wav', '/media/%2e%2e/private.wav',
                       '/media/source.wav', '/../private.wav']:
            self.assert_error('/api/jobs/' + identifier + suffix, 404)
        self.assert_error('/api/jobs/%2e%2e/media', 404)
        self.assert_error('/api/jobs/' + identifier.upper() + '/media', 404)
        for source in [private, self.jobs.directory / identifier / 'cache.wav']:
            source.write_bytes(b'private')
            with self.jobs.connect() as db:
                db.execute('UPDATE jobs SET source=? WHERE id=?', (str(source), identifier))
            self.assert_error('/api/jobs/' + identifier + '/media', 404)
        source = self.jobs.directory / identifier / 'source.wav'
        source.unlink()
        source.symlink_to(private)
        with self.jobs.connect() as db:
            db.execute('UPDATE jobs SET source=? WHERE id=?', (str(source), identifier))
        self.assert_error('/api/jobs/' + identifier + '/media', 404)

    def test_media_preserves_host_and_same_origin_guards(self):
        identifier = self.upload()
        for headers in [{'Host': 'evil.example'}, {'Origin': 'https://evil.example'},
                        {'Sec-Fetch-Site': 'cross-site'}, {'Sec-Fetch-Site': 'same-site'},
                        {'Origin': f'http://localhost:{self.server.server_port}'}]:
            for method in ['GET', 'HEAD']:
                self.assert_error('/api/jobs/' + identifier + '/media', 403,
                                  headers=headers, method=method)
        with urlopen(Request(self.base + '/api/jobs/' + identifier + '/media',
                             headers={'Sec-Fetch-Site': 'same-origin', 'Origin': self.base})) as response:
            self.assertEqual(response.read(), self.payload)

    def test_swapped_job_directory_symlink_does_not_escape_validation(self):
        identifier = self.upload()
        original = self.jobs.media
        folder = self.jobs.directory / identifier
        elsewhere = self.jobs.directory / 'private'
        elsewhere.mkdir()
        (elsewhere / 'source.wav').write_bytes(b'private')

        def replace_after_validation(job_id):
            result = original(job_id)
            folder.rename(self.jobs.directory / 'original')
            folder.symlink_to(elsewhere, target_is_directory=True)
            return result

        with patch.object(self.jobs, 'media', side_effect=replace_after_validation):
            self.assert_error('/api/jobs/' + identifier + '/media', 404)

    def test_head_cannot_bypass_the_static_route_allowlist(self):
        self.assert_error('/../serve.py', 404, method='HEAD')
        self.assert_error('/core.js', 403, method='HEAD', headers={'Host': 'evil.example'})
