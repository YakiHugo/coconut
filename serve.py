#!/usr/bin/env python3
"""Serve the Coconut local MVP on loopback. Do not expose this server publicly."""
from __future__ import annotations

import argparse
import json
import re
import signal
import tempfile
import uuid
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from import_jobs import ImportJobs
from subtitle_import import validate_video_url

# Local implementation resource boundaries, not provider limits.
MAX_UPLOAD = 200 * 1024 * 1024
MAX_JSON = 16 * 1024
MEDIA_EXTENSIONS = {'.mp3', '.mp4', '.wav', '.m4a', '.webm', '.ogg', '.flac', '.srt', '.vtt'}


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
        self.wfile.write(body)

    def do_GET(self):
        if not self._allowed():
            return
        path = urlparse(self.path).path
        try:
            if path == '/api/health':
                return self._json(200, {'local_worker': True, 'paid_processing': False, 'max_upload_bytes': MAX_UPLOAD})
            if path == '/api/jobs':
                return self._json(200, {'jobs': self.jobs.list()})
            match = re.fullmatch(r'/api/jobs/([a-f0-9]{32})(/result)?', path)
            if match:
                return self._json(200, self.jobs.result(match[1]) if match[2] else self.jobs.get(match[1]))
            if path not in ('/', '/index.html', '/app.js', '/core.js', '/jobs.js', '/style.css'):
                return self._json(404, {'error': 'Not found'})
            super().do_GET()
        except KeyError:
            self._json(404, {'error': 'Job not found'})
        except ValueError as error:
            self._json(409, {'error': str(error)})

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
                filename = parse_qs(parsed.query).get('filename', ['media'])[0]
                suffix = Path(filename).suffix.lower()
                if suffix not in MEDIA_EXTENSIONS:
                    return self._json(400, {'error': 'Unsupported media extension'})
                identifier = uuid.uuid4().hex
                folder = self.jobs.directory / identifier
                folder.mkdir()
                source = folder / ('source' + suffix)
                try:
                    with source.open('wb') as output:
                        remaining = length
                        while remaining:
                            chunk = self.rfile.read(min(remaining, 1024 * 1024))
                            if not chunk:
                                raise ValueError('Upload ended before all bytes arrived')
                            output.write(chunk)
                            remaining -= len(chunk)
                    options = {'language': parse_qs(parsed.query).get('language', [''])[0] or None}
                    job = self.jobs.enqueue(str(source), Path(filename).name, options, job_id=identifier)
                except BaseException:
                    # Only this request's incomplete, generated upload is removed.
                    source.unlink(missing_ok=True)
                    folder.rmdir()
                    raise
                return self._json(201, job)
            if media != 'application/json' or length < 0 or length > MAX_JSON:
                return self._json(400, {'error': 'Use a small JSON request'})
            body = self.rfile.read(length)
            data = json.loads(body) if body else {}
            if not isinstance(data, dict):
                raise ValueError('Expected an object')
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
        except (ValueError, TypeError, OSError) as error:
            self._json(400, {'error': str(error)[:300]})
        except KeyError:
            self._json(404, {'error': 'Job not found'})


def build_server(directory: Path, port: int = 8080):
    jobs = ImportJobs(directory)
    server = ThreadingHTTPServer(('127.0.0.1', port), partial(Handler, jobs=jobs))
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
