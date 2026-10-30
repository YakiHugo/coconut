#!/usr/bin/env python3
"""Serve the Coconut local MVP on loopback. Do not expose this server publicly."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import sqlite3
import stat
import tempfile
import uuid
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from import_jobs import (ImportJobs, UPLOAD_MEDIA_TYPES, InvalidUploadOperation,
                         UploadOperationConflict, validate_upload_operation)
from local_asr import executor_status
from subtitle_import import validate_video_url
from language_tools import LocalTranslator
from ai_reader import subscription_status, codex_status, ask, subscription_translate

# Local implementation resource boundaries, not provider limits.
MAX_UPLOAD = 200 * 1024 * 1024
MAX_JSON = 16 * 1024
MEDIA_EXTENSIONS = set(UPLOAD_MEDIA_TYPES) | {'.srt', '.vtt'}


def upload_operation_from_query(query, *, operation_id=None, size=None):
    """Parse one unambiguous identity; fingerprints are client lookup hints."""
    def single(name, default=None):
        values = query.get(name)
        if values is None and default is not None:
            return default
        if values is None or len(values) != 1:
            raise InvalidUploadOperation(f'Provide exactly one {name}')
        return values[0]

    def integer(name):
        value = single(name)
        if not re.fullmatch(r'[0-9]{1,16}', value):
            raise InvalidUploadOperation(f'{name} must be a nonnegative integer')
        return int(value)

    if operation_id is None:
        operation_id = single('operation_id')
    elif 'operation_id' in query and single('operation_id') != operation_id:
        raise InvalidUploadOperation('operation_id query does not match its URL')
    if size is None:
        size = integer('size')
    elif 'size' in query and integer('size') != size:
        raise InvalidUploadOperation('size must match Content-Length')
    return validate_upload_operation({
        'operation_id': operation_id, 'filename': single('filename'), 'size': size,
        'fingerprint': single('fingerprint'), 'last_modified': integer('last_modified'),
        'language': single('language', ''),
    })


def discard_uncommitted_upload(jobs, identifier, source):
    """Remove only this request's unowned upload, even after an uncertain commit."""
    try:
        committed = jobs.owns_upload_source(identifier, str(source))
    except Exception:
        # If the database cannot establish ownership, keep the bytes. A later
        # recovery query is safer than deleting a possibly committed source.
        return
    if not committed:
        source.unlink(missing_ok=True)
        source.parent.rmdir()


def byte_range(value: str, size: int) -> tuple[int, int]:
    """Parse one byte range; multipart or malformed ranges are not supported."""
    match = re.fullmatch(r'bytes=([0-9]*)-([0-9]*)', value)
    if not match or not any(match.groups()) or not size:
        raise ValueError('Invalid range')
    first, last = match.groups()
    if not first:
        suffix = int(last)
        if suffix <= 0:
            raise ValueError('Invalid range')
        return max(0, size - suffix), size - 1
    start = int(first)
    end = min(int(last), size - 1) if last else size - 1
    if start >= size or start > end:
        raise ValueError('Invalid range')
    return start, end


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, jobs: ImportJobs, **kwargs):
        self.jobs = jobs
        super().__init__(*args, directory=str(Path(__file__).parent / 'reader'), **kwargs)

    def log_message(self, format, *args):
        # Avoid logging user video URLs or filenames.
        pass

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _allowed(self):
        port = self.server.server_port
        hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
        if self.headers.get('Host') not in hosts:
            self.send_error(403, 'Use the local loopback address')
            return False
        origin = self.headers.get('Origin')
        if origin and origin not in {f'http://{host}' for host in hosts}:
            self.send_error(403, 'Cross-origin requests are not permitted')
            return False
        return True

    def _json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _media(self, identifier, *, allow_pending_upload=False):
        # Browsers must not use this private endpoint as cross-site embedded media.
        origin = self.headers.get('Origin')
        if ((origin and origin != 'http://' + self.headers.get('Host', '')) or
                self.headers.get('Sec-Fetch-Site') not in (None, 'same-origin', 'none')):
            return self._json(403, {'error': 'Cross-origin requests are not permitted'})
        path, _, content_type = (self.jobs.media(identifier, allow_pending_upload=True)
                                 if allow_pending_upload else self.jobs.media(identifier))
        try:
            # Pin the job directory and reject symlinks swapped in after validation.
            folder = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                     dir_fd=folder)
            finally:
                os.close(folder)
            stream = os.fdopen(descriptor, 'rb')
        except OSError:
            return self._json(404, {'error': 'Media not found'})
        with stream:
            file_stat = os.fstat(stream.fileno())
            if not stat.S_ISREG(file_stat.st_mode):
                return self._json(404, {'error': 'Media not found'})
            size = file_stat.st_size
            start, end = 0, size - 1
            requested_range = self.headers.get('Range')
            if requested_range is not None:
                try:
                    start, end = byte_range(requested_range, size)
                except ValueError:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{size}')
                    self.send_header('Content-Length', '0')
                    self.send_header('Accept-Ranges', 'bytes')
                    self.end_headers()
                    return
            self.send_response(206 if requested_range is not None else 200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(end - start + 1))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
            if requested_range is not None:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.end_headers()
            if self.command == 'HEAD':
                return
            stream.seek(start)
            remaining = end - start + 1
            try:
                while remaining:
                    chunk = stream.read(min(remaining, 64 * 1024))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                # A browser seek cancels the previous media request.
                pass

    def do_HEAD(self):
        # Use the same route allowlist and origin checks as GET.
        self.do_GET()

    def do_GET(self):
        if not self._allowed():
            return
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == '/api/health':
                return self._json(200, {'local_worker': True, 'paid_processing': False, 'max_upload_bytes': MAX_UPLOAD})
            if path == '/api/ingestion-executor/status':
                return self._json(200, executor_status())
            if path == '/api/language-tools':
                return self._json(200, {'ask_exact_selection': 1, 'translation_models': self.server.translator.available(), 'ai': {'codex': codex_status(), 'claude': subscription_status()}})
            if path == '/api/jobs':
                return self._json(200, {'jobs': self.jobs.list()})
            match = re.fullmatch(r'/api/ingestion-executor/operations/([^/]+)', path)
            if match:
                metadata = upload_operation_from_query(
                    parse_qs(parsed.query, keep_blank_values=True), operation_id=match[1])
                return self._json(200, self.jobs.get_upload_operation(metadata))
            match = re.fullmatch(r'/api/ingestion-executor/jobs/([a-f0-9]{32})/media', path)
            if match:
                return self._media(match[1], allow_pending_upload=True)
            match = re.fullmatch(r'/api/jobs/([a-f0-9]{32})/media', path)
            if match:
                return self._media(match[1])
            match = re.fullmatch(r'/api/jobs/([a-f0-9]{32})(/result)?', path)
            if match:
                return self._json(200, self.jobs.result(match[1]) if match[2] else self.jobs.get(match[1]))
            if path not in ('/', '/index.html', '/summary.js', '/editions.js', '/task-client.js', '/client-capabilities.js', '/core.js', '/passages.js', '/passage-playback.js', '/library-store.js', '/indexeddb-document-adapter.js', '/canonical-library.js', '/storage-provider.js', '/react-app.js', '/react-app.css', '/coconut-mark.png'):
                return self._json(404, {'error': 'Not found'})
            if self.command == 'HEAD':
                super().do_HEAD()
            else:
                super().do_GET()
        except KeyError:
            self._json(404, {'error': 'Job not found'})
        except InvalidUploadOperation as error:
            self._json(400, {'error': str(error)})
        except UploadOperationConflict as error:
            self._json(409, {'error': str(error), 'code': 'upload_operation_mismatch'})
        except ValueError as error:
            self._json(409, {'error': str(error)})
        except OSError:
            self._json(404, {'error': 'File not found'})

    def do_POST(self):
        if not self._allowed():
            return
        try:
            parsed = urlparse(self.path)
            length = int(self.headers.get('Content-Length', '0'))
            media = self.headers.get('Content-Type', '').split(';')[0]
            self.connection.settimeout(30)
            if parsed.path == '/api/uploads':
                if media != 'application/octet-stream' or not 0 < length <= MAX_UPLOAD:
                    return self._json(400, {'error': 'Upload must be a supported media file up to 200 MiB'})
                query = parse_qs(parsed.query, keep_blank_values=True)
                local_only_values = query.get('local_only', ['false'])
                if len(local_only_values) != 1 or local_only_values[0] not in ('true', 'false'):
                    raise ValueError('local_only must be true or false')
                local_only = local_only_values[0] == 'true'
                filename = query.get('filename', ['media'])[0]
                suffix = Path(filename).suffix.lower()
                if suffix not in MEDIA_EXTENSIONS:
                    return self._json(400, {'error': 'Unsupported media extension'})
                operation = None
                existing = None
                if {'operation_id', 'fingerprint', 'last_modified'} & set(query):
                    if not local_only:
                        raise InvalidUploadOperation('Upload operations require local_only=true')
                    operation = upload_operation_from_query(query, size=length)
                    try:
                        existing = self.jobs.get_upload_operation(operation)
                    except KeyError:
                        pass
                if local_only and existing is None:
                    status = executor_status()
                    if not status['available']:
                        return self._json(503, {**status, 'error': status['message']})
                identifier = uuid.uuid4().hex
                folder = self.jobs.directory / identifier
                folder.mkdir(mode=0o700)
                source = folder / ('source' + suffix)
                try:
                    digest = hashlib.sha256()
                    with source.open('wb') as output:
                        remaining = length
                        while remaining:
                            chunk = self.rfile.read(min(remaining, 1024 * 1024))
                            if not chunk:
                                raise ValueError('Upload ended before all bytes arrived')
                            output.write(chunk)
                            digest.update(chunk)
                            remaining -= len(chunk)
                        output.flush()
                        os.fsync(output.fileno())
                    # Persist the source name and its newly created job folder
                    # before the database acknowledges ownership of these bytes.
                    for directory in (folder, self.jobs.directory):
                        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                        try:
                            os.fsync(descriptor)
                        finally:
                            os.close(descriptor)
                    options = {'language': query.get('language', [''])[0] or None}
                    if local_only:
                        options['local_only'] = True
                    extra = ({'upload_operation': operation, 'content_hash': digest.hexdigest()}
                             if operation is not None else {})
                    job = self.jobs.enqueue(str(source), Path(filename).name, options,
                                            job_id=identifier, **extra)
                except BaseException:
                    # enqueue() commits before returning its representation. An
                    # error there must not delete a committed source after a lost
                    # ACK; an unreadable ownership check also fails conservatively.
                    discard_uncommitted_upload(self.jobs, identifier, source)
                    raise
                created = job['id'] == identifier
                if not created:
                    discard_uncommitted_upload(self.jobs, identifier, source)
                return self._json(201 if created else 200, job)
            limit = 1024 * 1024 if parsed.path in ('/api/translate','/api/ask','/api/translate-subscription') else MAX_JSON
            if media != 'application/json' or length < 0 or length > limit:
                return self._json(400, {'error': 'Use a small JSON request'})
            body = self.rfile.read(length)
            data = json.loads(body) if body else {}
            if not isinstance(data, dict):
                raise ValueError('Expected an object')
            if parsed.path == '/api/translate':
                if not isinstance(data.get('allow_download', False), bool): raise ValueError('allow_download must be boolean')
                translated = self.server.translator.translate(data.get('source'), data.get('target'), data.get('segments'), data.get('allow_download', False))
                return self._json(200, {'translations': translated})
            if parsed.path == '/api/translate-subscription':
                if data.get('consent') is not True: raise ValueError('Explicit subscription data/usage consent is required')
                return self._json(200, {'translations':subscription_translate(data.get('source'),data.get('target'),data.get('segments'),data.get('provider','codex'),context=data.get('context'),glossary=data.get('glossary'),memory=data.get('memory'),model=data.get('model'))})
            if parsed.path == '/api/ask':
                if data.get('consent') is not True: raise ValueError('Explicit subscription data/usage consent is required')
                return self._json(200, ask(data.get('question'), data.get('language'), data.get('segments'), data.get('provider', 'codex'),model=data.get('model'),**({'exact_selection':data['exact_selection']} if 'exact_selection' in data else {})))
            if parsed.path == '/api/jobs':
                url = data.get('url')
                if not isinstance(url, str):
                    raise ValueError('Provide a video URL')
                validate_video_url(url)
                return self._json(201, self.jobs.enqueue(url, url, data.get('options')))
            match = re.fullmatch(r'/api/jobs/([a-f0-9]{32})/(retry|cancel)', parsed.path)
            if match:
                action = self.jobs.retry if match[2] == 'retry' else self.jobs.cancel
                return self._json(200, action(match[1]))
            self._json(404, {'error': 'Not found'})
        except (BrokenPipeError, ConnectionResetError):
            # The receipt and source remain recoverable when the ACK is lost.
            return
        except UploadOperationConflict as error:
            self._json(409, {'error': str(error), 'code': 'upload_operation_mismatch'})
        except sqlite3.Error:
            self._json(503, {'error': 'Upload storage is temporarily unavailable', 'code': 'storage_unavailable'})
        except ImportError:
            self._json(400, {'error':'本地翻译依赖未安装，请重新运行 install.sh'})
        except (ValueError, TypeError, OSError) as error:
            self._json(400, {'error': str(error)[:300]})
        except KeyError:
            self._json(404, {'error': 'Job not found'})


def build_server(directory: Path, port: int = 8080):
    jobs = ImportJobs(directory)
    server = ThreadingHTTPServer(('127.0.0.1', port), partial(Handler, jobs=jobs))
    server.translator = LocalTranslator(directory / 'translation-models')
    try:
        jobs.start()
    except Exception:
        server.server_close()
        raise
    return server, jobs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--data-dir', type=Path, default=Path.home() / '.coconut')
    args = parser.parse_args()
    server, jobs = build_server(args.data_dir, args.port)
    print(f'Coconut is ready at http://127.0.0.1:{server.server_port}', flush=True)
    def terminate(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, terminate)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        jobs.close()


if __name__ == '__main__':
    main()
