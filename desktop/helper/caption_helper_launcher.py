"""Coconut's JSON-only native caption process; not yt-dlp's general-purpose CLI.

Copyright Coconut contributors. MIT (repository LICENSE).
The frozen runtime contains unmodified, separately licensed upstream components.
"""
import base64
import contextlib
import io
import json
import os
import ssl
from pathlib import Path
import sys
import urllib.parse

import yt_dlp
import certifi
from yt_dlp.version import __version__

PROTOCOL = 1
MAX_INPUT = 8192
MAX_CAPTION = 1024 * 1024
# Pin Python API plugin state before any downloader is constructed.
from yt_dlp.globals import plugin_dirs, plugin_ies, plugin_pps, all_plugins_loaded
plugin_dirs.value = []
plugin_ies.value = {}
plugin_pps.value = {}
all_plugins_loaded.value = True

PUBLIC_EXTRACTION = True  # Guarded X route verified in CI; other providers stay disabled.


class QuietOutput(io.TextIOBase):
    def write(self, text): return len(text)


class QuietLogger:
    def debug(self, _message): pass
    def warning(self, _message): pass
    def error(self, _message): pass


def authored_fixture(endpoint):
    """Only the original loopback fixture. Never accepts caller-supplied info JSON."""
    url = urllib.parse.urlsplit(endpoint)
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port
            or url.username or url.password or url.query or url.fragment
            or url.path not in ('/authored.vtt', '/slow.vtt', '/oversized.vtt')):
        return {'status': 'unavailable'}
    info = {'id': 'coconut-authored-proof', 'title': 'Original Coconut native helper proof',
            'duration': 4, 'language': 'en', 'extractor': 'CoconutAuthoredFixture',
            'extractor_key': 'CoconutAuthoredFixture', 'webpage_url': 'https://coconut.invalid/authored-proof',
            'formats': [{'format_id': 'never-download', 'url': 'https://coconut.invalid/forbidden-media.mp4', 'ext': 'mp4'}],
            'subtitles': {'en': [{'ext': 'vtt', 'url': endpoint}]}, 'automatic_captions': {}}
    params = {'quiet': True, 'no_warnings': True, 'logger': QuietLogger(), 'skip_download': True,
              'writesubtitles': True, 'writeautomaticsub': False, 'subtitleslangs': ['en'],
              'subtitlesformat': 'vtt', 'outtmpl': 'caption.%(ext)s', 'cachedir': False,
              'cookiefile': None, 'cookiesfrombrowser': None, 'usenetrc': False, 'proxy': '',
              'js_runtimes': {}, 'remote_components': [], 'noplaylist': True, 'retries': 0,
              'fragment_retries': 0, 'extractor_retries': 0, 'file_access_retries': 0,
              'socket_timeout': 5, 'max_filesize': MAX_CAPTION, 'overwrites': False}
    with yt_dlp.YoutubeDL(params, auto_init=False) as ydl:
        original_urlopen = ydl.urlopen
        def fixture_only(request):
            requested = request if isinstance(request, str) else request.url
            if requested != endpoint:
                raise ValueError('fixture network denied')
            return original_urlopen(request)
        ydl.urlopen = fixture_only
        result = ydl.process_ie_result(info, download=True)
    if sorted(result.get('requested_subtitles', {})) != ['en']:
        return {'status': 'unavailable'}
    filename = Path('caption.en.vtt')
    if not filename.is_file() or filename.is_symlink() or not 0 < filename.stat().st_size <= MAX_CAPTION:
        return {'status': 'unavailable'}
    body = filename.read_bytes()
    if not body.startswith(b'WEBVTT\n'):
        return {'status': 'unavailable'}
    return {'status': 'ok', 'source': {'url': info['webpage_url'], 'id': info['id'], 'title': info['title'],
            'duration': 4, 'extractor': info['extractor'], 'language': 'en', 'automatic': False,
            'translated': False, 'live': False},
            'track': {'language': 'en', 'captionMethod': 'platform_provided', 'languageBasis': 'authored-fixture',
                      'reviewStatus': 'unreviewed'}, 'format': 'vtt', 'captionBase64': base64.b64encode(body).decode('ascii')}


def main():
    if sys.argv[1:] != ['--protocol=1']:
        return {'status': 'unavailable'}
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        return {'status': 'unavailable'}
    request = json.loads(raw)
    if not isinstance(request, dict):
        return {'status': 'unavailable'}
    operation = request.get('operation')
    if operation == 'version' and set(request) == {'operation'}:
        from scripts.public_x_caption_guard import extract_public_captions
        from scripts.public_video_caption_guard import extract_public_video_captions
        assert callable(extract_public_captions) and callable(extract_public_video_captions)
        trust=ssl.create_default_context(cafile=certifi.where())
        assert trust.check_hostname and trust.verify_mode == ssl.CERT_REQUIRED
        return {'status': 'ok', 'protocol': PROTOCOL, 'version': __version__,
                'python': '.'.join(map(str, sys.version_info[:3])), 'publicExtraction': PUBLIC_EXTRACTION,
                'guardProtocol': 1, 'tlsRootsVerified': True,
                'developmentProviders': ['x', 'youtube', 'bilibili'], 'developmentProxyProtocol': 1}
    if operation == 'authored-fixture' and set(request) == {'operation', 'endpoint'}:
        if not isinstance(request['endpoint'], str) or len(request['endpoint']) > 200:
            return {'status': 'unavailable'}
        return authored_fixture(request['endpoint'])
    extraction_keys = {'operation', 'url', 'language'}
    development_proxy = operation == 'extract-development' and set(request) == extraction_keys | {'trustedProxy'}
    if operation in ('extract', 'extract-development') and (set(request) == extraction_keys or development_proxy):
        if not isinstance(request['url'], str) or len(request['url']) > 2048:
            return {'status': 'unavailable'}
        language = request['language']
        if language is not None and (not isinstance(language, str) or len(language) > 30):
            return {'status': 'language_required'}
        proxy = None
        if development_proxy:
            from scripts.caption_proxy_transport import validate_proxy
            from scripts.public_x_caption_guard import StopProof
            proxy = request['trustedProxy']
            try:
                if proxy is None or validate_proxy(proxy) is None or urllib.parse.urlsplit(request['url']).hostname not in ('www.youtube.com', 'www.bilibili.com'):
                    raise ValueError('Invalid proxy scope')
            except (StopProof, ValueError):
                return {'status': 'guard_stopped', 'diagnostic': {'stage': 'initialization',
                        'reason': 'proxy_configuration_invalid', 'requests_attempted': 0, 'responses_received': 0}}
        from scripts.public_x_caption_guard import extract_public_captions
        if operation == 'extract-development' and urllib.parse.urlsplit(request['url']).hostname in ('www.youtube.com', 'www.bilibili.com'):
            from scripts.public_video_caption_guard import extract_public_video_captions
            result = extract_public_video_captions(request['url'], language, ca_file=certifi.where(), proxy=proxy)
        else:
            result = extract_public_captions(request['url'], language, ca_file=certifi.where())
        if result.get('status') in ('access_restricted', 'unavailable', 'language_required', 'network_unavailable', 'metadata_incomplete', 'no_matching_captions', 'extractor_failed', 'caption_file_invalid', 'caption_parse_failed', 'guard_stopped'):
            return {key: result[key] for key in ('status', 'diagnostic', 'languages') if key in result}
        body = result.pop('bytes', None)
        if not isinstance(body, bytes) or not 0 < len(body) <= MAX_CAPTION:
            return {'status': 'caption_file_invalid'}
        return {**result, 'status': 'ok', 'captionBase64': base64.b64encode(body).decode('ascii')}
    # No data input can turn on a different route, plugin, shell or downloader.
    return {'status': 'unavailable'}


if __name__ == '__main__':
    os.umask(0o077)
    try:
        # Do not leak library diagnostics, URLs, tokens, local paths or input in
        # stdout/stderr. The protocol has only bounded structured outcomes.
        with contextlib.redirect_stdout(QuietOutput()), contextlib.redirect_stderr(QuietOutput()):
            response = main()
    except Exception:
        response = {'status': 'extractor_failed', 'diagnostic': {'stage': 'helper_execution',
                    'reason': 'helper_error', 'requests_attempted': None, 'responses_received': None}}
    sys.stdout.write(json.dumps(response, ensure_ascii=True, separators=(',', ':')) + '\n')
