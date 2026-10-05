import tempfile
import time
import unittest
from pathlib import Path
from import_jobs import ImportJobs

class JobTests(unittest.TestCase):
    def test_actual_subtitle_job_and_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp); subtitle=path/'example.srt'
            subtitle.write_text('1\n00:00:01,000 --> 00:00:02,000\n你好，测试。\n')
            jobs=ImportJobs(path/'jobs')
            item=jobs.enqueue(str(subtitle), 'Example')
            jobs.start()
            try:
                deadline=time.monotonic()+10
                while jobs.get(item['id'])['status'] not in ('done','failed') and time.monotonic()<deadline:
                    time.sleep(.02)
                self.assertEqual(jobs.get(item['id'])['status'],'done')
                self.assertEqual(jobs.result(item['id'])['segments'][0]['text'],'你好，测试。')
            finally: jobs.close()
            restored=ImportJobs(path/'jobs')
            self.assertEqual(restored.get(item['id'])['status'],'done')
            self.assertNotIn('source',restored.get(item['id']))
    def test_cancel_queued_and_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            jobs=ImportJobs(Path(tmp)); item=jobs.enqueue('example.srt','Example')
            self.assertEqual(jobs.cancel(item['id'])['status'],'cancelled')
            self.assertEqual(jobs.retry(item['id'])['status'],'queued')
            with self.assertRaises(ValueError): jobs.retry(item['id'])
    def test_interrupted_job_not_labeled_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            jobs=ImportJobs(Path(tmp));item=jobs.enqueue('example.srt','Example')
            with jobs.connect() as db: db.execute("UPDATE jobs SET status='running' WHERE id=?",(item['id'],))
            jobs.start()
            try: self.assertEqual(jobs.get(item['id'])['status'],'interrupted')
            finally: jobs.close()
    def test_reject_unknown_options(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):ImportJobs(Path(tmp)).enqueue('x','x',{'shell':'oops'})

    def test_second_worker_cannot_steal_running_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            first=ImportJobs(Path(tmp));first.start()
            try:
                second=ImportJobs(Path(tmp))
                with self.assertRaises(RuntimeError):second.start()
            finally:first.close()
            second.start()
            second.close()

class PlaybackCacheTests(unittest.TestCase):
    def test_only_bounded_completed_download_cache_is_exposed(self):
        import json
        with tempfile.TemporaryDirectory() as td:
            jobs=ImportJobs(Path(td));job=jobs.enqueue('https://x.com/example/status/123','URL',{'keep_media':True})
            with jobs.connect() as db:db.execute("UPDATE jobs SET status='done' WHERE id=?",(job['id'],))
            cache=Path(td)/job['id']/'cache';cache.mkdir(parents=True);media=cache/'playback.mp4';media.write_bytes(b'fixture')
            with self.assertRaises(KeyError):jobs.media(job['id'])
            (cache/'playback.json').write_text(json.dumps({'file':'playback.mp4','size':7}))
            self.assertEqual(jobs.media(job['id']),(media,'video','video/mp4'))
            media.write_bytes(b'changed size')
            with self.assertRaises(KeyError):jobs.media(job['id'])

class PlaybackRecoveryTests(unittest.TestCase):
    def test_done_job_retries_only_missing_requested_playback_with_cached_transcript(self):
        import json
        with tempfile.TemporaryDirectory() as td:
            jobs = ImportJobs(Path(td))
            job = jobs.enqueue('https://x.com/example/status/123', 'URL', {'keep_media': True})
            identifier = job['id']
            with jobs.connect() as db:
                db.execute("UPDATE jobs SET status='done' WHERE id=?", (identifier,))
            self.assertFalse(jobs.get(identifier)['playback_retryable'])
            with self.assertRaises(ValueError): jobs.retry(identifier)
            cache = Path(td) / identifier / 'cache'
            cache.mkdir(parents=True)
            (cache / 'document.json').write_text('{"segments": []}')
            self.assertTrue(jobs.get(identifier)['playback_retryable'])
            (cache / 'playback.mp4').write_bytes(b'fixture')
            (cache / 'playback.json').write_text(json.dumps({'file':'playback.mp4','size':7}))
            self.assertFalse(jobs.get(identifier)['playback_retryable'])
            with self.assertRaises(ValueError): jobs.retry(identifier)
            (cache / 'playback.json').unlink()
            self.assertEqual(jobs.retry(identifier)['status'], 'queued')
            with self.assertRaises(ValueError): jobs.retry(identifier)
            self.assertTrue((cache / 'document.json').is_file())

    def test_done_job_without_requested_playback_cannot_be_reprocessed(self):
        with tempfile.TemporaryDirectory() as td:
            jobs = ImportJobs(Path(td))
            for source, options in [('https://x.com/example/status/123', {}), ('local.mp4', {'keep_media':True})]:
                job = jobs.enqueue(source, 'Title', options)
                with jobs.connect() as db:
                    db.execute("UPDATE jobs SET status='done' WHERE id=?", (job['id'],))
                self.assertFalse(jobs.get(job['id'])['playback_retryable'])
                with self.assertRaises(ValueError): jobs.retry(job['id'])
