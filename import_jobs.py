"""Durable single-worker local import jobs. No cloud credentials or paid fallback."""
from __future__ import annotations

import json
import contextlib
import fcntl
import os
import re
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from local_asr import OFFLINE_ENVIRONMENT


# Only the original, generated upload path may be exposed to the reader.
# Subtitle inputs and downloader/cache files are deliberately not playable.
UPLOAD_MEDIA_TYPES = {
    '.mp3': ('audio', 'audio/mpeg'),
    '.mp4': ('video', 'video/mp4'),
    '.wav': ('audio', 'audio/wav'),
    '.m4a': ('audio', 'audio/mp4'),
    '.webm': ('video', 'video/webm'),
    '.ogg': ('audio', 'audio/ogg'),
    '.flac': ('audio', 'audio/flac'),
}


class UploadOperationConflict(ValueError):
    """An operation ID is already bound to different media or metadata."""


class InvalidUploadOperation(ValueError):
    """Malformed operation metadata must not create a durable receipt."""


def validate_upload_operation(value: dict) -> dict:
    fields = {'operation_id', 'filename', 'size', 'fingerprint', 'last_modified', 'language'}
    if not isinstance(value, dict) or set(value) != fields:
        raise InvalidUploadOperation('Provide complete upload operation metadata')
    identifier = value['operation_id']
    if (not isinstance(identifier, str) or
            not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', identifier)):
        raise InvalidUploadOperation('operation_id must be a lowercase UUID')
    filename = value['filename']
    if (not isinstance(filename, str) or not 1 <= len(filename) <= 300 or
            filename in ('.', '..') or '/' in filename or '\\' in filename or
            any(ord(character) < 32 or ord(character) == 127 for character in filename)):
        raise InvalidUploadOperation('Provide a plain media filename up to 300 characters')
    if type(value['size']) is not int or not 0 < value['size'] <= 200 * 1024 * 1024:
        raise InvalidUploadOperation('Upload operation size must be between 1 byte and 200 MiB')
    if type(value['last_modified']) is not int or not 0 <= value['last_modified'] <= 9007199254740991:
        raise InvalidUploadOperation('last_modified must be a nonnegative safe integer')
    if not isinstance(value['fingerprint'], str) or not re.fullmatch(r'[a-f0-9]{64}', value['fingerprint']):
        raise InvalidUploadOperation('fingerprint must contain 64 lowercase hexadecimal characters')
    if value['language'] not in ('', 'zh', 'en', 'ja', 'ko', 'fr', 'de', 'es'):
        raise InvalidUploadOperation('Unsupported language hint')
    return dict(value)


def _operation_metadata(row) -> dict:
    return {key: row[key] for key in
            ('operation_id', 'filename', 'size', 'fingerprint', 'last_modified', 'language')}


def _match_operation(row, metadata, content_hash=None):
    if _operation_metadata(row) != metadata:
        raise UploadOperationConflict('Upload operation metadata does not match the original upload')
    if content_hash is not None and row['content_hash'] != content_hash:
        raise UploadOperationConflict('Upload operation contents do not match the original upload')


class ImportJobs:
    def __init__(self, directory: Path, *, python: str = sys.executable):
        self.directory = directory.resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.python = python
        self.db_path = self.directory / 'jobs.sqlite3'
        self.lock = threading.Lock()
        self.wakeup = threading.Event()
        self.stopping = threading.Event()
        self.processes: dict[str, subprocess.Popen] = {}
        self.thread = None
        self.ownership = None
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, options TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL, error TEXT, created REAL NOT NULL, updated REAL NOT NULL)')
            db.execute('''CREATE TABLE IF NOT EXISTS upload_operations (
                operation_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
                filename TEXT NOT NULL, size INTEGER NOT NULL, fingerprint TEXT NOT NULL,
                last_modified INTEGER NOT NULL, language TEXT NOT NULL,
                content_hash TEXT NOT NULL, created REAL NOT NULL)''')

    @contextlib.contextmanager
    def connect(self):
        db = sqlite3.connect(self.db_path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def start(self):
        if self.thread:
            return
        self.ownership = (self.directory / 'worker.lock').open('a')
        try:
            fcntl.flock(self.ownership.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.ownership.close()
            self.ownership = None
            raise RuntimeError('Another worker owns this job directory')
        with self.connect() as db:
            db.execute("UPDATE jobs SET status='interrupted', stage='Interrupted; retry to resume', updated=? WHERE status='running'", (time.time(),))
        self.thread = threading.Thread(target=self._work, name='coconut-import', daemon=True)
        self.thread.start()

    def enqueue(self, source: str, title: str, options: dict | None = None, *, job_id: str | None = None,
                upload_operation: dict | None = None, content_hash: str | None = None) -> dict:
        options = {} if options is None else options
        if not isinstance(options, dict):
            raise ValueError('Import options must be an object')
        if set(options) - {'language', 'force_transcribe', 'captions_only', 'model', 'keep_media', 'local_only'}:
            raise ValueError('Unknown import option')
        if options.get('language') not in (None, '', 'zh', 'en', 'ja', 'ko', 'fr', 'de', 'es'):
            raise ValueError('Unsupported language hint')
        if options.get('model', 'small') not in ('tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'):
            raise ValueError('Unsupported local model')
        if 'force_transcribe' in options and not isinstance(options['force_transcribe'], bool):
            raise ValueError('force_transcribe must be boolean')
        if 'captions_only' in options and not isinstance(options['captions_only'], bool):
            raise ValueError('captions_only must be boolean')
        if options.get('captions_only') and options.get('force_transcribe'):
            raise ValueError('captions_only cannot be combined with force_transcribe')
        if 'keep_media' in options and not isinstance(options['keep_media'], bool):
            raise ValueError('keep_media must be boolean')
        if 'local_only' in options and not isinstance(options['local_only'], bool):
            raise ValueError('local_only must be boolean')
        if options.get('local_only'):
            if options.get('model', 'small') != 'small':
                raise ValueError('Local-only ingestion supports the small model only')
            if source.startswith(('http://', 'https://')):
                raise ValueError('Local-only ingestion requires an uploaded local file')
        if upload_operation is not None:
            upload_operation = validate_upload_operation(upload_operation)
            if (options.get('local_only') is not True or title != upload_operation['filename'] or
                    (options.get('language') or '') != upload_operation['language']):
                raise InvalidUploadOperation('Upload operation must match the local-only job filename and language')
            if not isinstance(content_hash, str) or not re.fullmatch(r'[a-f0-9]{64}', content_hash):
                raise InvalidUploadOperation('A full upload content hash is required')
        elif content_hash is not None:
            raise InvalidUploadOperation('A content hash requires upload operation metadata')
        identifier = job_id or uuid.uuid4().hex
        now = time.time()
        created = False
        with self.connect() as db:
            # Upload bytes are complete and fsynced before this short transaction.
            # The unique operation key and job row commit together, so concurrent
            # requests and retries after a lost ACK cannot create a second job.
            db.execute('BEGIN IMMEDIATE')
            receipt = (db.execute('SELECT * FROM upload_operations WHERE operation_id=?',
                                  (upload_operation['operation_id'],)).fetchone()
                       if upload_operation is not None else None)
            if receipt is not None:
                _match_operation(receipt, upload_operation, content_hash)
                identifier = receipt['job_id']
            else:
                db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)', (identifier, source, title[:300], json.dumps(options), 'queued', 'Waiting', None, now, now))
                if upload_operation is not None:
                    db.execute('INSERT INTO upload_operations VALUES (?,?,?,?,?,?,?,?,?)',
                               (upload_operation['operation_id'], identifier, upload_operation['filename'],
                                upload_operation['size'], upload_operation['fingerprint'],
                                upload_operation['last_modified'], upload_operation['language'], content_hash, now))
                created = True
        if created:
            self.wakeup.set()
        return self.get(identifier)

    def get_upload_operation(self, metadata: dict) -> dict:
        metadata = validate_upload_operation(metadata)
        with self.connect() as db:
            receipt = db.execute('SELECT * FROM upload_operations WHERE operation_id=?',
                                 (metadata['operation_id'],)).fetchone()
        if receipt is None:
            raise KeyError('Upload operation not found')
        _match_operation(receipt, metadata)
        return self.get(receipt['job_id'])

    def owns_upload_source(self, identifier: str, source: str) -> bool:
        """Cleanup must never remove an upload after its job commit succeeded."""
        with self.connect() as db:
            row = db.execute('SELECT source FROM jobs WHERE id=?', (identifier,)).fetchone()
        return row is not None and row['source'] == source

    def get(self, identifier: str) -> dict:
        with self.connect() as db:
            row = db.execute('SELECT * FROM jobs WHERE id=?', (identifier,)).fetchone()
            receipt = db.execute('SELECT * FROM upload_operations WHERE job_id=?', (identifier,)).fetchone()
        if row is None:
            raise KeyError('Job not found')
        data = dict(row)
        source = data.pop('source')
        data['options'] = json.loads(data['options'])
        if receipt is not None:
            data['upload_operation'] = _operation_metadata(receipt)
        data['playback_retryable'] = False
        if data['status'] == 'done' and source.startswith('https://') and data['options'].get('keep_media'):
            try:
                self.media(identifier)
            except KeyError:
                # Only resume a completed transcript, never start recognition again
                # because an optional playback copy is missing.
                cache = self.directory / identifier / 'cache' / 'document.json'
                data['playback_retryable'] = cache.is_file()
            except ValueError:
                # Another request may have queued recovery after this snapshot.
                pass
        return data

    def list(self):
        with self.connect() as db:
            ids = [row[0] for row in db.execute('SELECT id FROM jobs ORDER BY created DESC LIMIT 100')]
        return [self.get(identifier) for identifier in ids]

    def retry(self, identifier: str):
        job = self.get(identifier)
        allowed = ('done',) if job['playback_retryable'] else ('failed', 'interrupted', 'cancelled')
        with self.connect() as db:
            changed = db.execute(f"UPDATE jobs SET status='queued', stage='Waiting', error=NULL, updated=? WHERE id=? AND status IN ({','.join('?' for _ in allowed)})", (time.time(), identifier, *allowed)).rowcount
        if not changed:
            raise ValueError('Only failed, interrupted, cancelled jobs or missing requested playback can be retried')
        self.wakeup.set()
        return self.get(identifier)

    def cancel(self, identifier: str):
        with self.lock:
            with self.connect() as db:
                changed = db.execute("UPDATE jobs SET status='cancelled', stage='Cancelled', updated=? WHERE id=? AND status IN ('queued','running')", (time.time(), identifier)).rowcount
            process = self.processes.get(identifier)
            if changed and process and process.poll() is None:
                self._signal_process(process, signal.SIGTERM)
        if not changed:
            raise ValueError('This job cannot be cancelled')
        return self.get(identifier)

    def result(self, identifier: str) -> dict:
        job = self.get(identifier)
        if job['status'] != 'done':
            raise ValueError('Job is not complete')
        document = json.loads((self.directory / identifier / 'transcript.raw.json').read_text())
        if not job['title'].startswith('https://'):
            document['title'] = Path(job['title']).stem
        # Never trust an association embedded in an imported transcript.
        document.pop('source_media', None)
        try:
            _, kind, _ = self.media(identifier)
        except KeyError:
            pass
        else:
            document['source_media'] = {'job_id': identifier, 'kind': kind}
        return document

    def media(self, identifier: str, *, allow_pending_upload: bool = False) -> tuple[Path, str, str]:
        """Resolve bounded original media, optionally before local-only ASR ends."""
        if not re.fullmatch(r'[a-f0-9]{32}', identifier):
            raise KeyError('Job not found')
        with self.connect() as db:
            job = db.execute('SELECT source, status, options FROM jobs WHERE id=?', (identifier,)).fetchone()
        if job is None:
            raise KeyError('Job not found')
        if allow_pending_upload:
            # This capability is only for explicitly local-only uploads. URL
            # download caches and ordinary advanced imports retain their old gate.
            if (json.loads(job['options']).get('local_only') is not True or
                    job['source'].startswith(('http://', 'https://'))):
                raise KeyError('Media not found')
        elif job['status'] != 'done':
            raise ValueError('Job is not complete')
        if job['source'].startswith('https://'):
            from subtitle_import import validate_video_url
            try:
                validate_video_url(job['source'])
            except ValueError:
                raise KeyError('Media not found') from None
            path = self.directory / identifier / 'cache' / 'playback.mp4'
            try:
                marker = path.with_name('playback.json')
                safe = path.resolve() == path and path.is_file() and marker.resolve() == marker and marker.is_file() and 0 < path.stat().st_size <= 200 * 1024 * 1024
                safe = safe and json.loads(marker.read_text()) == {'file': 'playback.mp4', 'size': path.stat().st_size}
            except (OSError, RuntimeError, ValueError):
                safe = False
            if not safe:
                raise KeyError('Media not found')
            return path, 'video', 'video/mp4'
        path = Path(job['source'])
        media_type = UPLOAD_MEDIA_TYPES.get(path.suffix)
        expected = self.directory / identifier / ('source' + path.suffix)
        try:
            safe = path == expected and path.resolve() == expected and path.is_file()
        except (OSError, RuntimeError):
            safe = False
        if not media_type or not safe:
            raise KeyError('Media not found')
        return path, *media_type

    def _status(self, identifier, status, stage, error=None):
        with self.connect() as db:
            db.execute("UPDATE jobs SET status=?, stage=?, error=?, updated=? WHERE id=? AND status='running'", (status, stage, error, time.time(), identifier))

    def _work(self):
        while not self.stopping.is_set():
            with self.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                row = db.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
                if row:
                    db.execute("UPDATE jobs SET status='running', stage='Starting', updated=? WHERE id=?", (time.time(), row['id']))
            if row is None:
                self.wakeup.wait(1)
                self.wakeup.clear()
                continue
            self._run(dict(row))

    def _run(self, job):
        identifier = job['id']
        work = self.directory / identifier
        work.mkdir(exist_ok=True)
        options = json.loads(job['options'])
        command = [self.python, str(Path(__file__).with_name('transcribe.py')), job['source'], '-o', str(work / 'transcript.raw.md'), '--work-dir', str(work / 'cache'), '--no-diarize', '--model', options.get('model', 'small')]
        if options.get('language'):
            command.extend(['--language', options['language']])
        if options.get('force_transcribe'):
            command.append('--force-transcribe')
        if options.get('captions_only'):
            command.append('--captions-only')
        if options.get('keep_media'):
            command.append('--keep-media')
        environment = None
        if options.get('local_only'):
            command.extend(['--local-files-only', '--backend', 'faster-whisper', '--no-align'])
            environment = {**os.environ, **OFFLINE_ENVIRONMENT}
        try:
            with self.lock:
                if self.get(identifier)['status'] != 'running':
                    return
                process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, start_new_session=True, env=environment, pass_fds=(self.ownership.fileno(),) if self.ownership else ())
                self.processes[identifier] = process
            last_error = ''
            for line in process.stderr:
                last_error = line.strip()[-1500:]
                if line.startswith('['):
                    self._status(identifier, 'running', line.strip()[:300])
            code = process.wait()
            process.stderr.close()
            if self.stopping.is_set():
                self._status(identifier, 'interrupted', 'Interrupted; retry to continue')
            elif code == 0 and (work / 'transcript.raw.json').is_file():
                self._status(identifier, 'done', 'Ready to read')
            else:
                self._status(identifier, 'failed', 'Import failed', last_error or f'Process exited {code}')
        except Exception as error:
            self._status(identifier, 'failed', 'Import failed', str(error)[:1500])
        finally:
            with self.lock:
                self.processes.pop(identifier, None)

    @staticmethod
    def _signal_process(process, sig):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass

    def close(self):
        self.stopping.set()
        self.wakeup.set()
        with self.lock:
            for process in self.processes.values():
                if process.poll() is None:
                    self._signal_process(process, signal.SIGTERM)
        if self.thread:
            self.thread.join(timeout=5)
        with self.lock:
            for process in self.processes.values():
                if process.poll() is None:
                    self._signal_process(process, signal.SIGKILL)
        if self.thread:
            self.thread.join(timeout=2)
        if self.ownership:
            self.ownership.close()
            self.ownership = None
