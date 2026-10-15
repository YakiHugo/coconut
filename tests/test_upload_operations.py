"""Durable upload receipts use only local HTTP/SQLite and opaque byte fixtures."""
import concurrent.futures
import hashlib
import http.client
import json
import socket
import sqlite3
import tempfile
import threading
import time
import unittest
import uuid
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from import_jobs import (ImportJobs, InvalidUploadOperation,
                         UploadOperationConflict, validate_upload_operation)
from serve import Handler, discard_uncommitted_upload


PAYLOAD = b'opaque local media fixture, never decoded or sent externally'
READY = {'available': True, 'code': 'ready', 'model': 'small', 'model_download': False}


def identity(**changes):
    # The client fingerprint is deliberately not the SHA-256 of the entire file.
    # It is an opaque sampled identity hint; replay content is separately hashed.
    return {
        'operation_id': str(uuid.uuid4()), 'filename': 'lecture.mp3',
        'size': len(PAYLOAD), 'fingerprint': 'a' * 64,
        'last_modified': 1720000000000, 'language': 'en', **changes,
    }


class UploadOperationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.jobs = ImportJobs(self.directory)
        # No worker is ever started, including on restart; no fixture can reach ASR.
        self.start_http()
        self.readiness = patch('serve.executor_status', return_value=READY)
        self.readiness.start()

    def start_http(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, jobs=self.jobs))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def stop_http(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def tearDown(self):
        self.readiness.stop()
        self.stop_http()
        self.temp.cleanup()

    def upload_path(self, metadata):
        return '/api/uploads?' + urlencode({'local_only': 'true', **metadata})

    def query_path(self, metadata):
        return '/api/ingestion-executor/operations/' + metadata['operation_id'] + '?' + urlencode(
            {key: value for key, value in metadata.items() if key != 'operation_id'})

    def upload(self, metadata, payload=PAYLOAD):
        request = Request(self.base + self.upload_path(metadata), data=payload,
                          headers={'Content-Type': 'application/octet-stream'})
        with urlopen(request) as response:
            return response.status, json.load(response)

    def lookup(self, metadata):
        with urlopen(self.base + self.query_path(metadata)) as response:
            return json.load(response)

    def assert_http_error(self, status, action):
        with self.assertRaises(HTTPError) as raised:
            action()
        with raised.exception as error:
            self.assertEqual(error.code, status)
            return json.load(error)

    def assert_single_source(self, job, payload=PAYLOAD):
        folders = [path for path in self.directory.iterdir() if path.is_dir()]
        self.assertEqual(folders, [self.directory / job['id']])
        self.assertEqual((folders[0] / 'source.mp3').read_bytes(), payload)
        self.assertEqual(len(self.jobs.list()), 1)
        with self.jobs.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM upload_operations').fetchone()[0], 1)

    def test_restart_and_replay_return_one_persisted_job_without_reenqueue(self):
        metadata = identity()
        status, job = self.upload(metadata)
        self.assertEqual(status, 201)
        self.assertEqual(job['upload_operation'], metadata)
        with self.jobs.connect() as db:
            receipt = db.execute('SELECT * FROM upload_operations').fetchone()
        self.assertEqual(receipt['content_hash'], hashlib.sha256(PAYLOAD).hexdigest())
        self.assertNotEqual(receipt['content_hash'], metadata['fingerprint'])
        self.assertNotIn('content_hash', json.dumps(job))
        self.stop_http()
        self.jobs = ImportJobs(self.directory)
        self.start_http()
        with patch.object(self.jobs.wakeup, 'set') as wakeup:
            status, replay = self.upload(metadata)
        self.assertEqual(status, 200)
        self.assertEqual(replay['id'], job['id'])
        self.assertEqual(self.lookup(metadata)['id'], job['id'])
        self.assertEqual(self.jobs.list()[0]['upload_operation'], metadata)
        wakeup.assert_not_called()
        self.assert_single_source(job)

    def test_matching_replay_and_lookup_ignore_now_unavailable_model(self):
        metadata = identity()
        _, job = self.upload(metadata)
        with self.jobs.connect() as db:
            db.execute("UPDATE jobs SET status='failed' WHERE id=?", (job['id'],))
        with patch('serve.executor_status', side_effect=AssertionError('No readiness for an existing receipt')):
            self.assertEqual(self.lookup(metadata)['id'], job['id'])
            status, replay = self.upload(metadata)
        self.assertEqual(status, 200)
        self.assertEqual(replay['status'], 'failed')
        self.assert_single_source(job)

    def test_concurrent_matching_operations_atomically_create_only_one_job(self):
        metadata = identity()
        barrier = threading.Barrier(2)
        original = self.jobs.enqueue

        def synchronized_enqueue(*args, **kwargs):
            barrier.wait(timeout=5)
            return original(*args, **kwargs)

        with patch.object(self.jobs, 'enqueue', side_effect=synchronized_enqueue), \
                patch.object(self.jobs.wakeup, 'set') as wakeup, \
                concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(self.upload, metadata) for _ in range(2)]
            results = [future.result(timeout=10) for future in futures]
        self.assertEqual(sorted(status for status, _ in results), [200, 201])
        self.assertEqual(results[0][1]['id'], results[1][1]['id'])
        wakeup.assert_called_once_with()
        self.assert_single_source(results[0][1])

    def test_concurrent_same_identity_different_full_content_cannot_create_two_jobs(self):
        metadata = identity()
        different = b'X' + PAYLOAD[1:]
        barrier = threading.Barrier(2)
        original = self.jobs.enqueue

        def synchronized_enqueue(*args, **kwargs):
            barrier.wait(timeout=5)
            return original(*args, **kwargs)

        def submit(payload):
            try:
                return self.upload(metadata, payload)
            except HTTPError as error:
                with error:
                    return error.code, json.load(error)

        with patch.object(self.jobs, 'enqueue', side_effect=synchronized_enqueue), \
                concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(submit, payload) for payload in (PAYLOAD, different)]
            results = [future.result(timeout=10) for future in futures]
        self.assertEqual(sorted(status for status, _ in results), [201, 409])
        winner = next(job for status, job in results if status == 201)
        source = (self.directory / winner['id'] / 'source.mp3').read_bytes()
        self.assertIn(source, (PAYLOAD, different))
        self.assert_single_source(winner, source)

    def test_lookup_is_exact_read_only_and_metadata_mismatch_does_not_mutate_original(self):
        metadata = identity()
        self.assert_http_error(404, lambda: self.lookup(metadata))
        _, job = self.upload(metadata)
        for changes in ({'filename': 'different.mp3'}, {'size': len(PAYLOAD) + 1},
                        {'fingerprint': 'b' * 64}, {'last_modified': 1}, {'language': 'zh'}):
            with self.subTest(changes=changes):
                result = self.assert_http_error(409, lambda: self.lookup({**metadata, **changes}))
                self.assertEqual(result['code'], 'upload_operation_mismatch')
        with patch.object(self.jobs, 'enqueue') as enqueue, patch('serve.executor_status') as status:
            self.assertEqual(self.lookup(metadata)['id'], job['id'])
        enqueue.assert_not_called()
        status.assert_not_called()
        self.assert_single_source(job)

    def test_post_metadata_and_complete_body_hash_mismatch_leave_original_untouched(self):
        metadata = identity()
        _, job = self.upload(metadata)
        for changes in ({'filename': 'different.mp3'}, {'fingerprint': 'b' * 64},
                        {'last_modified': 1}, {'language': 'zh'}):
            with self.subTest(changes=changes):
                self.assert_http_error(409, lambda: self.upload({**metadata, **changes}))
        result = self.assert_http_error(409, lambda: self.upload(metadata, b'X' + PAYLOAD[1:]))
        self.assertIn('contents', result['error'])
        self.assert_single_source(job)
        status, replay = self.upload(metadata)
        self.assertEqual((status, replay['id']), (200, job['id']))

    def test_truncated_new_upload_is_removed_without_a_receipt_or_job(self):
        metadata = identity()
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        connection.putrequest('POST', self.upload_path(metadata))
        connection.putheader('Content-Type', 'application/octet-stream')
        connection.putheader('Content-Length', str(len(PAYLOAD)))
        connection.endheaders()
        connection.send(PAYLOAD[:10])
        connection.sock.shutdown(socket.SHUT_WR)
        response = connection.getresponse()
        self.assertEqual(response.status, 400)
        self.assertIn('before all bytes', json.loads(response.read())['error'])
        connection.close()
        self.assertEqual(self.jobs.list(), [])
        self.assertEqual([path for path in self.directory.iterdir() if path.is_dir()], [])
        self.assert_http_error(404, lambda: self.lookup(metadata))

    def test_truncated_replay_does_not_mutate_committed_upload(self):
        metadata = identity()
        _, job = self.upload(metadata)
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        connection.putrequest('POST', self.upload_path(metadata))
        connection.putheader('Content-Type', 'application/octet-stream')
        connection.putheader('Content-Length', str(len(PAYLOAD)))
        connection.endheaders()
        connection.send(PAYLOAD[:10])
        connection.sock.shutdown(socket.SHUT_WR)
        response = connection.getresponse()
        self.assertEqual(response.status, 400)
        response.read()
        connection.close()
        self.assert_single_source(job)

    def test_body_upload_does_not_hold_a_sqlite_write_transaction(self):
        metadata = identity()
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        connection.putrequest('POST', self.upload_path(metadata))
        connection.putheader('Content-Type', 'application/octet-stream')
        connection.putheader('Content-Length', str(len(PAYLOAD)))
        connection.endheaders()
        connection.send(PAYLOAD[:10])
        deadline = time.monotonic() + 3
        while not any(path.is_dir() for path in self.directory.iterdir()) and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(any(path.is_dir() for path in self.directory.iterdir()))
        with sqlite3.connect(self.jobs.db_path, timeout=0) as db:
            db.execute('BEGIN IMMEDIATE')
            db.rollback()
        connection.send(PAYLOAD[10:])
        response = connection.getresponse()
        self.assertEqual(response.status, 201)
        job = json.loads(response.read())
        connection.close()
        self.assert_single_source(job)

    def test_lost_ack_preserves_atomic_receipt_source_and_same_key_recovery(self):
        metadata = identity()
        original = Handler._json

        def lose_ack(handler, status, data):
            if status == 201:
                raise BrokenPipeError('Simulated lost response after commit')
            return original(handler, status, data)

        with patch.object(Handler, '_json', lose_ack):
            with self.assertRaises(http.client.RemoteDisconnected):
                self.upload(metadata)
        job = self.lookup(metadata)
        self.assert_single_source(job)
        status, replay = self.upload(metadata)
        self.assertEqual((status, replay['id']), (200, job['id']))
        self.assert_single_source(job)

    def test_post_commit_serialization_failure_cannot_delete_committed_source(self):
        metadata = identity()
        with patch.object(self.jobs, 'get', side_effect=OSError('Simulated representation failure')):
            self.assert_http_error(400, lambda: self.upload(metadata))
        recovered = self.lookup(metadata)
        self.assert_single_source(recovered)
        self.assertEqual(self.upload(metadata)[1]['id'], recovered['id'])

    def test_database_insert_failure_rolls_back_job_and_cleans_only_candidate_bytes(self):
        metadata = identity()
        with self.jobs.connect() as db:
            db.execute("CREATE TRIGGER reject_receipt BEFORE INSERT ON upload_operations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
        result = self.assert_http_error(503, lambda: self.upload(metadata))
        self.assertEqual(result['code'], 'storage_unavailable')
        self.assertEqual(self.jobs.list(), [])
        self.assertEqual([path for path in self.directory.iterdir() if path.is_dir()], [])
        self.assert_http_error(404, lambda: self.lookup(metadata))

    def test_preflight_unavailable_creates_neither_operation_nor_upload(self):
        metadata = identity()
        unavailable = {'available': False, 'code': 'missing_model', 'message': 'Model missing'}
        with patch('serve.executor_status', return_value=unavailable):
            self.assert_http_error(503, lambda: self.upload(metadata))
        self.assertEqual(self.jobs.list(), [])
        self.assertEqual([path for path in self.directory.iterdir() if path.is_dir()], [])
        self.assert_http_error(404, lambda: self.lookup(metadata))

    def test_invalid_and_duplicate_metadata_is_rejected_before_upload_or_enqueue(self):
        metadata = identity()
        bad = [
            {**metadata, 'operation_id': metadata['operation_id'].upper()},
            {**metadata, 'operation_id': 'not-a-uuid'},
            {**metadata, 'fingerprint': 'g' * 64},
            {**metadata, 'last_modified': -1},
            {**metadata, 'last_modified': 9007199254740992},
            {**metadata, 'filename': '../lecture.mp3'},
            {**metadata, 'size': len(PAYLOAD) + 1},
            {key: value for key, value in metadata.items() if key != 'fingerprint'},
            {key: value for key, value in metadata.items() if key != 'operation_id'},
        ]
        with patch.object(self.jobs, 'enqueue') as enqueue, patch('serve.executor_status') as status:
            for item in bad:
                with self.subTest(metadata=item):
                    self.assert_http_error(400, lambda: self.upload(item))
            for duplicate in ('filename=lecture.mp3', 'operation_id=' + metadata['operation_id'],
                              'fingerprint=' + metadata['fingerprint'], 'language=en', 'size=' + str(len(PAYLOAD))):
                request = Request(self.base + self.upload_path(metadata) + '&' + duplicate,
                                  data=PAYLOAD, headers={'Content-Type': 'application/octet-stream'})
                self.assert_http_error(400, lambda: urlopen(request))
        enqueue.assert_not_called()
        status.assert_not_called()
        self.assertEqual(self.jobs.list(), [])

    def test_missing_language_is_normalized_and_operations_require_explicit_local_only(self):
        metadata = identity(language='')
        without_language = {key: value for key, value in metadata.items() if key != 'language'}
        status, job = self.upload(without_language)
        self.assertEqual(status, 201)
        self.assertEqual(job['upload_operation'], metadata)
        self.assertEqual(self.lookup(without_language)['id'], job['id'])
        request = Request(self.base + '/api/uploads?' + urlencode(identity()), data=PAYLOAD,
                          headers={'Content-Type': 'application/octet-stream'})
        self.assert_http_error(400, lambda: urlopen(request))

    def test_lookup_preserves_host_and_origin_guards(self):
        metadata = identity()
        _, job = self.upload(metadata)
        for headers in ({'Host': 'evil.example'}, {'Origin': 'https://evil.example'}):
            with self.assertRaises(HTTPError) as error:
                urlopen(Request(self.base + self.query_path(metadata), headers=headers))
            self.assertEqual(error.exception.code, 403)
        self.assert_single_source(job)


class OperationTransactionTests(unittest.TestCase):
    def test_job_insert_rolls_back_if_receipt_insert_fails(self):
        with tempfile.TemporaryDirectory() as td:
            jobs = ImportJobs(Path(td))
            with jobs.connect() as db:
                db.execute("CREATE TRIGGER reject_receipt BEFORE INSERT ON upload_operations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
            metadata = identity()
            with self.assertRaises(sqlite3.IntegrityError):
                jobs.enqueue('/fixture.mp3', metadata['filename'], {'local_only': True, 'language': 'en'},
                             upload_operation=metadata, content_hash=hashlib.sha256(PAYLOAD).hexdigest())
            self.assertEqual(jobs.list(), [])
            with self.assertRaises(KeyError):
                jobs.get_upload_operation(metadata)

    def test_invalid_internal_metadata_cannot_create_receipts(self):
        with tempfile.TemporaryDirectory() as td:
            jobs = ImportJobs(Path(td))
            for metadata in (identity(size=True), identity(last_modified=True), identity(language=None),
                             identity(fingerprint='z'), identity(filename='path\\source.mp3')):
                with self.subTest(metadata=metadata), self.assertRaises(InvalidUploadOperation):
                    validate_upload_operation(metadata)
            metadata = identity()
            for options, digest in (({}, 'a' * 64), ({'local_only': True, 'language': 'zh'}, 'a' * 64),
                                    ({'local_only': True, 'language': 'en'}, None)):
                with self.subTest(options=options, digest=digest), self.assertRaises(InvalidUploadOperation):
                    jobs.enqueue('/fixture.mp3', 'lecture.mp3', options,
                                 upload_operation=metadata, content_hash=digest)
            self.assertEqual(jobs.list(), [])

    def test_cleanup_preserves_source_if_commit_ownership_cannot_be_checked(self):
        with tempfile.TemporaryDirectory() as td:
            source = Path(td) / 'source.mp3'
            source.write_bytes(PAYLOAD)
            jobs = Mock()
            jobs.owns_upload_source.side_effect = sqlite3.OperationalError('database temporarily unavailable')
            discard_uncommitted_upload(jobs, 'a' * 32, source)
            self.assertEqual(source.read_bytes(), PAYLOAD)
