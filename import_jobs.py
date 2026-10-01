"""Durable single-worker local import jobs. No cloud credentials or paid fallback."""
from __future__ import annotations

import json
import contextlib
import fcntl
import os
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path


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

    @contextlib.contextmanager
    def connect(self):
        db = sqlite3.connect(self.db_path, timeout=10)
        db.row_factory = sqlite3.Row
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

    def enqueue(self, source: str, title: str, options: dict | None = None, *, job_id: str | None = None) -> dict:
        options = {} if options is None else options
        if not isinstance(options, dict):
            raise ValueError('Import options must be an object')
        if set(options) - {'language', 'force_transcribe', 'model'}:
            raise ValueError('Unknown import option')
        if options.get('language') not in (None, '', 'zh', 'en', 'ja', 'ko', 'fr', 'de', 'es'):
            raise ValueError('Unsupported language hint')
        if options.get('model', 'small') not in ('tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'):
            raise ValueError('Unsupported local model')
        if 'force_transcribe' in options and not isinstance(options['force_transcribe'], bool):
            raise ValueError('force_transcribe must be boolean')
        identifier = job_id or uuid.uuid4().hex
        now = time.time()
        with self.connect() as db:
            db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)', (identifier, source, title[:300], json.dumps(options), 'queued', 'Waiting', None, now, now))
        self.wakeup.set()
        return self.get(identifier)

    def get(self, identifier: str) -> dict:
        with self.connect() as db:
            row = db.execute('SELECT * FROM jobs WHERE id=?', (identifier,)).fetchone()
        if row is None:
            raise KeyError('Job not found')
        data = dict(row)
        data.pop('source')
        data['options'] = json.loads(data['options'])
        return data

    def list(self):
        with self.connect() as db:
            ids = [row[0] for row in db.execute('SELECT id FROM jobs ORDER BY created DESC LIMIT 100')]
        return [self.get(identifier) for identifier in ids]

    def retry(self, identifier: str):
        with self.connect() as db:
            changed = db.execute("UPDATE jobs SET status='queued', stage='Waiting', error=NULL, updated=? WHERE id=? AND status IN ('failed','interrupted','cancelled')", (time.time(), identifier)).rowcount
        if not changed:
            raise ValueError('Only failed, interrupted or cancelled jobs can be retried')
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
        return document

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
        try:
            with self.lock:
                if self.get(identifier)['status'] != 'running':
                    return
                process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, start_new_session=True, pass_fds=(self.ownership.fileno(),) if self.ownership else ())
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
