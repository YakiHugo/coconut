"""Read only Bilibili authentication rows from a selected Edge profile.

This process has no network access code. Its stdout is a private parent pipe,
never an HTTP response or log. Browser databases are opened read-only.
"""
import contextlib
import io
import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import patch

class QuietLogger:
    def debug(self, *args, **kwargs): pass
    def info(self, *args, **kwargs): pass
    def warning(self, *args, **kwargs): pass
    def error(self, *args, **kwargs): pass


def read_session(database, decryptor_factory=None):
    from yt_dlp.cookies import MacChromeCookieDecryptor, _process_chrome_cookie
    connection = sqlite3.connect(Path(database).as_uri() + '?mode=ro', uri=True, timeout=2)
    try:
        version = int(connection.execute("SELECT value FROM meta WHERE key='version'").fetchone()[0])
        # Filter BEFORE fetching or decrypting: unrelated sites never enter Python.
        rows = connection.execute(
            'SELECT host_key,name,value,encrypted_value,path,expires_utc,is_secure FROM cookies '
            "WHERE host_key IN ('.bilibili.com','bilibili.com') AND path='/' "
            "AND name IN ('SESSDATA','bili_jct','DedeUserID') ORDER BY host_key").fetchall()
    finally:
        connection.close()
    if not rows:
        return {'status': 'not_logged_in'}
    decryptor = (decryptor_factory(version) if decryptor_factory else
                 MacChromeCookieDecryptor('Microsoft Edge', QuietLogger(), meta_version=version))
    cookies = {}
    for row in rows:
        encoded = tuple(value.encode() if isinstance(value, str) else value for value in row)
        _, cookie = _process_chrome_cookie(decryptor, *encoded)
        if cookie and not cookie.is_expired(time.time()) and cookie.value:
            if len(cookie.value) <= 4096 and all(0x21 <= ord(c) <= 0x7e and c not in ';,"\\' for c in cookie.value):
                cookies[cookie.name] = cookie.value
    return ({'status': 'ready', 'cookies': cookies} if cookies.get('SESSDATA') and
            sum(map(len, cookies.values())) <= 6000 else {'status': 'not_logged_in'})


def keychain_password(_name, _logger):
    result = subprocess.run(['/usr/bin/security', 'find-generic-password', '-w',
                             '-a', 'Microsoft Edge', '-s', 'Microsoft Edge Safe Storage'],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30, check=False)
    return result.stdout.rstrip(b'\n') if result.returncode == 0 else None


def main():
    if sys.platform != 'darwin':
        return {'status': 'unsupported'}
    request = json.loads(sys.stdin.buffer.read(8193))
    if set(request) != {'database'} or not isinstance(request['database'], str):
        return {'status': 'unavailable'}
    import yt_dlp.cookies
    with patch.object(yt_dlp.cookies, '_get_mac_keyring_password', keychain_password):
        return read_session(request['database'])


if __name__ == '__main__':
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = main()
    except Exception:
        result = {'status': 'unavailable'}
    sys.stdout.write(json.dumps(result, separators=(',', ':')))
