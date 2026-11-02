"""Real upstream Urllib TLS/CONNECT with authored loopback servers, never a platform proof."""
import ast
import contextlib
import gzip
import inspect
import http.server
import importlib.util
import os
from pathlib import Path
import select
import shutil
import socket
import socketserver
import ssl
import subprocess
import tempfile
import threading
import unittest
import zlib
from unittest.mock import Mock, patch

AVAILABLE = importlib.util.find_spec('yt_dlp') is not None
if AVAILABLE:
    from scripts import owner_video_source as source
    from yt_dlp.networking import Request
    from yt_dlp.networking._urllib import UrllibRH
    from yt_dlp.networking import _helper

SOURCE_URL = 'https://www.youtube.com/watch?v=BaW_jenozKc'
BODY = b'\x00\x00\x00\x18ftypM4A ' + b'authored source bytes' * 4


class Origin(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args): pass

    def do_GET(self):
        self.server.requests.append(self.path)
        self.server.encodings.append(self.headers.get('Accept-Encoding'))
        body = BODY
        encoding = None
        if self.path.startswith('/compressed'):
            encoding = 'gzip'
            body = gzip.compress(b'x' * 65536 if self.path == '/compressed-bomb' else BODY)
            if self.path == '/compressed-deflate': encoding, body = 'deflate', zlib.compress(BODY)
            if self.path == '/compressed-raw-deflate': encoding, body = 'deflate', zlib.compress(BODY)[2:-4]
            if self.path == '/compressed-truncated': body = body[:-5]
            if self.path == '/compressed-crc': body = body[:-8] + b'00000000'
            if self.path == '/compressed-trailing': body += b'trailing'
            if self.path == '/compressed-concatenated': body += gzip.compress(BODY)
            if self.path == '/compressed-stack': encoding = 'gzip, deflate'
            if self.path == '/compressed-unsupported': encoding = 'br'
            if self.path == '/compressed-raw-limit': body = gzip.compress(bytes(range(256))*4)
        targets={'/compressed-redirect':'/must-not-follow','/redirect-big':'/must-not-follow','/downgrade':'http://127.0.0.1/must-not-connect','/ftp-redirect':'ftp://fixture.invalid/must-not-connect','/data-redirect':'data:text/plain,authored','/file-redirect':'file:///tmp/authored-never-read','/userinfo-redirect':'https://authored:credential@fixture.invalid/must-not-connect'}
        redirect=self.path in targets
        self.send_response(403 if self.path == '/compressed-denied' else 302 if redirect else 200)
        if redirect:self.send_header('Location',targets[self.path])
        if self.path=='/compressed-duplicate':self.send_header('Content-Encoding','identity')
        if encoding:self.send_header('Content-Encoding',encoding)
        self.send_header('Content-Type', 'audio/mp4')
        if self.path not in ('/unknown-length','/redirect-big'):
            self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            pass


class Tunnel(socketserver.StreamRequestHandler):
    def handle(self):
        first = self.rfile.readline(4097)
        headers = []
        while True:
            line = self.rfile.readline(4097)
            if line in (b'\r\n', b'\n', b''):
                break
            headers.append(line)
            if len(headers) > 30:
                return
        self.server.requests.append((first, headers))
        if self.server.reject:
            self.wfile.write(b'HTTP/1.1 502 Authored rejection\r\nContent-Length: 0\r\n\r\n')
            self.wfile.flush()
            return
        # This fixture never resolves or connects the requested host. It only
        # relays to its own authored origin and refuses unknown CONNECT targets.
        allowed = (b'CONNECT fixture.invalid:443 HTTP/1.0\r\n',
                   b'CONNECT fixture.invalid:443 HTTP/1.1\r\n',
                   b'CONNECT wrong.invalid:443 HTTP/1.0\r\n',
                   b'CONNECT wrong.invalid:443 HTTP/1.1\r\n')
        if first not in allowed:
            self.wfile.write(b'HTTP/1.1 403 Authored scope rejection\r\nContent-Length: 0\r\n\r\n')
            self.wfile.flush()
            return
        with socket.create_connection(self.server.origin, timeout=3) as origin:
            self.wfile.write(b'HTTP/1.1 200 Connection established\r\n\r\n')
            self.wfile.flush()
            while True:
                readable, _, _ = select.select([self.connection, origin], [], [], 3)
                if not readable:
                    return
                for incoming in readable:
                    try:
                        data = incoming.recv(65536)
                        if not data:
                            return
                        (origin if incoming is self.connection else self.connection).sendall(data)
                    except (ConnectionError, OSError):
                        return


class ProxyServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


@unittest.skipUnless(AVAILABLE, 'Pinned yt-dlp required; this is not a live-platform test')
class OwnerNetworkConfigurationTests(unittest.TestCase):
    def test_process_boundary_rejects_ambiguous_environment_proxy_urls(self):
        for value in ['http://@proxy.invalid', 'http:// proxy.invalid',
                      'http://proxy.invalid\\path', 'http://user:password@proxy.invalid']:
            with self.subTest(value=value):
                with self.assertRaises(source.StopProof) as stopped:
                    source.network_options({'mode': 'environment', 'environment': {'https_proxy': value}})
                self.assertEqual(stopped.exception.outcome, 'proxy_configuration_invalid')

    def test_environment_uses_stdlib_lowercase_precedence_and_restores_parent(self):
        authored = {'HTTP_PROXY': 'http://uppercase.invalid:8080',
                    'http_proxy': 'http://lowercase.invalid:8081',
                    'NO_PROXY': 'upper.invalid', 'no_proxy': 'lower.invalid'}
        with patch.dict(os.environ, {'HTTP_PROXY': 'http://parent.invalid:8090'}, clear=True), \
                patch.object(source.urllib.request, 'getproxies', side_effect=AssertionError('No OS discovery')):
            original = dict(os.environ)
            self.assertEqual(source.network_options({'mode': 'environment', 'environment': authored}),
                             {'http': authored['http_proxy'], 'https': authored['http_proxy'], 'no': 'lower.invalid'})
            self.assertEqual(dict(os.environ), original)
            self.assertEqual(source.network_options({'mode': 'environment', 'environment': {}}), {})
            self.assertEqual(source.network_options({'mode': 'direct'}), {'all': '__noproxy__'})

    def test_raw_response_is_closed_if_deadline_expires_before_read(self):
        import io
        from types import SimpleNamespace
        raw=io.BytesIO(b'authored')
        def expired():raise source.StopProof('budget_exceeded')
        owner=SimpleNamespace(stage='metadata',check_budget=expired)
        response=source.RawResponseBudget(raw,owner)
        with self.assertRaises(source.StopProof):response.read()
        self.assertTrue(raw.closed)

    def test_internal_proxy_override_stops_before_request_director(self):
        with source.OwnerVideoDL(SOURCE_URL) as owner:
            with patch.object(owner, 'build_request_director', side_effect=AssertionError('No transport')):
                with self.assertRaises(source.StopProof) as stopped:
                    owner.urlopen(Request('https://fixture.invalid/source', proxies={'all': 'http://127.0.0.1:9'}))
            self.assertEqual(stopped.exception.outcome, 'unsupported_request')
            self.assertEqual(owner.count, 0)


@unittest.skipUnless(AVAILABLE, 'Pinned yt-dlp required; socket checks were not run')
class OwnerNativeTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which('openssl'):
            raise unittest.SkipTest('OpenSSL unavailable: authored TLS transport proof not run')
        cls.directory = tempfile.TemporaryDirectory(prefix='coconut-owner-network-')
        cls.addClassCleanup(cls.directory.cleanup)
        root = Path(cls.directory.name)
        cls.cert, key = root / 'cert.pem', root / 'key.pem'
        config=root/'certificate.cnf'
        # A config file avoids relying on a newer OpenSSL CLI -addext switch on
        # macOS. All keys/certificates are authored and die with this directory.
        config.write_text('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=fixture.invalid\n[extensions]\nsubjectAltName=DNS:fixture.invalid,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n')
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-keyout', str(key), '-out', str(cls.cert), '-config', str(config)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        try:
            cls.origin = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Origin)
        except PermissionError as error:
            raise unittest.SkipTest(f'Loopback sockets denied: actual transport proof not run ({error.errno})')
        cls.origin.daemon_threads = True
        cls.origin.requests = []
        cls.origin.encodings = []
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.cert, key)
        cls.origin.socket = context.wrap_socket(cls.origin.socket, server_side=True)
        thread = threading.Thread(target=cls.origin.serve_forever, daemon=True)
        thread.start()
        cls.addClassCleanup(cls.origin.server_close)
        cls.addClassCleanup(cls.origin.shutdown)
        cls.origin_url = f'https://127.0.0.1:{cls.origin.server_port}'

    @contextlib.contextmanager
    def proxy(self, reject=False):
        server = ProxyServer(('127.0.0.1', 0), Tunnel)
        server.origin = self.origin.server_address
        server.requests, server.reject = [], reject
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server, f'http://127.0.0.1:{server.server_address[1]}'
        finally:
            server.shutdown()
            server.server_close()

    @contextlib.contextmanager
    def downloader(self, network=None, trust=True):
        def load_authored_root(context, use_certifi=True):
            # Replace roots, never certificate verification or hostname checking.
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(context.check_hostname)
            context.load_verify_locations(cafile=str(self.cert))
        trust_context = patch.object(_helper, 'ssl_load_certs', load_authored_root) if trust else contextlib.nullcontext()
        # Production uses an isolated helper environment. Do not let the test
        # runner's own NO_PROXY alter urllib's legacy proxy_bypass() behavior.
        environment = network['environment'] if network and network['mode'] == 'environment' else {'all_proxy':network['proxy']} if network and network['mode'] == 'custom' else {}
        with patch.dict(os.environ, environment, clear=True), trust_context, source.OwnerVideoDL(SOURCE_URL, network=network) as owner:
            self.assertIsInstance(owner._request_director.handlers['Urllib'], UrllibRH)
            self.assertEqual(set(owner._request_director.handlers), {'Urllib'})
            yield owner

    def test_direct_native_tls_accepts_authored_trusted_certificate(self):
        with self.downloader() as owner:
            with owner.urlopen(self.origin_url + '/direct') as response:
                self.assertEqual(response.read(), BODY)
            self.assertEqual((owner.count, owner.responses), (1, 1))
        self.assertIn('/direct', self.origin.requests)

    def test_direct_native_tls_rejects_untrusted_certificate(self):
        before = len(self.origin.requests)
        with self.downloader(trust=False) as owner:
            with self.assertRaises(source.StopProof) as stopped:
                owner.urlopen(self.origin_url + '/untrusted')
            self.assertEqual(stopped.exception.outcome, 'transport_unavailable')
        self.assertEqual(len(self.origin.requests), before)

    def test_native_custom_connect_uses_proxy_and_preserves_origin_tls(self):
        with self.proxy() as (proxy, endpoint), self.downloader({'mode': 'custom', 'proxy': endpoint}) as owner:
            with owner.urlopen('https://fixture.invalid/proxied') as response:
                self.assertEqual(response.read(), BODY)
            self.assertEqual(len(proxy.requests), 1)
            self.assertTrue(proxy.requests[0][0].startswith(b'CONNECT fixture.invalid:443 '))
            self.assertFalse(any(b'authorization:' in header.lower() for header in proxy.requests[0][1]))
        self.assertIn('/proxied', self.origin.requests)

    def test_proxy_tls_still_rejects_wrong_origin_hostname(self):
        before = len(self.origin.requests)
        with self.proxy() as (proxy, endpoint), self.downloader({'mode': 'custom', 'proxy': endpoint}) as owner:
            with self.assertRaises(source.StopProof) as stopped:
                owner.urlopen('https://wrong.invalid/wrong-host')
            self.assertEqual(stopped.exception.outcome, 'transport_unavailable')
            self.assertEqual(len(proxy.requests), 1)
        self.assertEqual(len(self.origin.requests), before)

    def test_connect_rejection_never_falls_back_to_reachable_direct_origin(self):
        before = len(self.origin.requests)
        with self.proxy(reject=True) as (proxy, endpoint), self.downloader({'mode': 'custom', 'proxy': endpoint}) as owner:
            with self.assertRaises(source.StopProof):
                owner.urlopen(self.origin_url + '/must-not-fallback')
            self.assertEqual(len(proxy.requests), 1)
            self.assertEqual(owner.count, 1)
        self.assertEqual(len(self.origin.requests), before)

    def test_environment_lowercase_proxy_reaches_native_connect(self):
        with self.proxy() as (proxy, endpoint):
            config = {'mode': 'environment', 'environment': {
                'HTTPS_PROXY': 'http://127.0.0.1:1', 'https_proxy': endpoint}}
            with self.downloader(config) as owner:
                with owner.urlopen('https://fixture.invalid/environment') as response:
                    self.assertEqual(response.read(), BODY)
            self.assertEqual(len(proxy.requests), 1)

    def test_environment_no_proxy_bypasses_authored_proxy_without_os_discovery(self):
        with self.proxy(reject=True) as (proxy, endpoint):
            config = {'mode': 'environment', 'environment': {'https_proxy': endpoint, 'NO_PROXY': '127.0.0.1'}}
            with self.downloader(config) as owner:
                with owner.urlopen(self.origin_url + '/bypass') as response:
                    self.assertEqual(response.read(), BODY)
            self.assertEqual(proxy.requests, [])

    def test_explicit_proxy_never_uses_macos_system_bypass(self):
        # Compile the actual macOS branch from this Python stdlib rather than
        # reimplementing its decision. CI on Linux must exercise the same code
        # which can otherwise silently bypass an explicit proxy on macOS.
        tree = ast.parse(inspect.getsource(source.urllib.request))
        branches = [node for node in ast.walk(tree) if isinstance(node, ast.If)
                    and isinstance(node.test, ast.Compare)
                    and isinstance(node.test.left, ast.Attribute)
                    and isinstance(node.test.left.value, ast.Name)
                    and node.test.left.value.id == 'sys' and node.test.left.attr == 'platform'
                    and len(node.test.comparators) == 1
                    and isinstance(node.test.comparators[0], ast.Constant)
                    and node.test.comparators[0].value == 'darwin']
        self.assertEqual(len(branches), 1, 'Locate the real stdlib macOS branch')
        definitions = [node for node in branches[0].body if isinstance(node, ast.FunctionDef)
                       and node.name == 'proxy_bypass']
        self.assertEqual(len(definitions), 1, 'Locate the real macOS bypass function')
        system_bypass = Mock(side_effect=AssertionError('OS proxy bypass must not run'))
        namespace = {'getproxies_environment': source.urllib.request.getproxies_environment,
                     'proxy_bypass_environment': source.urllib.request.proxy_bypass_environment,
                     'proxy_bypass_macosx_sysconf': system_bypass}
        module = ast.fix_missing_locations(ast.Module(body=definitions, type_ignores=[]))
        exec(compile(module, source.urllib.request.__file__, 'exec'), namespace)
        mac_bypass = namespace['proxy_bypass']
        # Negative control proves the unconfigured helper used the OS branch;
        # a simulated test that merely always returned False would miss this.
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(AssertionError, 'OS proxy bypass'):
                mac_bypass('fixture.invalid')
        system_bypass.assert_called_once_with('fixture.invalid')
        system_bypass.reset_mock()
        with self.proxy() as (proxy,endpoint):
            configs=[{'mode':'custom','proxy':endpoint},
                     {'mode':'environment','environment':{'https_proxy':endpoint,'NO_PROXY':'not-fixture.invalid'}}]
            for config in configs:
                with self.subTest(mode=config['mode']),self.downloader(config) as owner,patch.object(source.urllib.request,'proxy_bypass',side_effect=mac_bypass) as bypass:
                    with owner.urlopen('https://fixture.invalid/no-os-bypass') as response:
                        self.assertEqual(response.read(),BODY)
                    self.assertGreater(bypass.call_count,0)
            self.assertEqual(len(proxy.requests),2)
            system_bypass.assert_not_called()

    def test_bounded_gzip_and_zlib_text_bypass_unbounded_native_decoder(self):
        from yt_dlp.networking._urllib import HTTPHandler
        for stage in ('metadata', 'caption_download'):
            for path in ('/compressed', '/compressed-deflate'):
                with self.subTest(stage=stage, path=path), self.downloader() as owner, patch.object(HTTPHandler, 'gz', side_effect=AssertionError('Native decoder must not run')) as gz, patch.object(HTTPHandler, 'deflate', side_effect=AssertionError('Native decoder must not run')) as df:
                    owner.stage = stage
                    with owner.urlopen(self.origin_url + path) as response:
                        self.assertEqual(response.read(), BODY)
                        self.assertIsNone(response.headers.get('Content-Encoding'))
                        self.assertEqual(int(response.headers.get('Content-Length')), len(BODY))
                    self.assertGreater(owner.raw_metadata_bytes, 0)
                    self.assertEqual(owner.raw_metadata_bytes + owner.expanded_metadata_bytes, len(BODY))
                    gz.assert_not_called(); df.assert_not_called()
                self.assertEqual(self.origin.encodings[-1], 'identity')

    def test_compressed_media_and_ambiguous_encodings_are_rejected_before_body_read(self):
        for stage, path in [('media_download', '/compressed'), ('media_download', '/compressed-deflate'),
                            ('metadata', '/compressed-duplicate'), ('metadata', '/compressed-stack'), ('metadata', '/compressed-unsupported')]:
            with self.subTest(stage=stage, path=path), self.downloader() as owner:
                owner.stage = stage; owner.media_url = self.origin_url + path
                with self.assertRaises(source.StopProof) as stopped: owner.urlopen(owner.media_url)
                self.assertEqual(stopped.exception.outcome, 'encoded_response_rejected')
                self.assertEqual((owner.raw_metadata_bytes, owner.raw_media_bytes), (0, 0))

    def test_compressed_text_must_have_complete_single_standard_member(self):
        for path in ('/compressed-truncated', '/compressed-crc', '/compressed-trailing', '/compressed-concatenated', '/compressed-raw-deflate'):
            with self.subTest(path=path), self.downloader() as owner:
                with self.assertRaises(source.StopProof) as stopped: owner.urlopen(self.origin_url + path)
                self.assertEqual(stopped.exception.outcome, 'encoded_response_rejected')

    def test_both_compressed_raw_bytes_and_expansion_are_bounded(self):
        for path, raw_limit in (('/compressed-bomb', False), ('/compressed-raw-limit', True)):
            with self.subTest(path=path), self.downloader() as owner, patch.object(source, 'MAX_METADATA', 128):
                with self.assertRaises(source.StopProof) as stopped: owner.urlopen(self.origin_url + path)
                self.assertEqual(stopped.exception.outcome, 'budget_exceeded')
                self.assertLessEqual(owner.raw_metadata_bytes, 129)
                if raw_limit: self.assertEqual(owner.raw_metadata_bytes, 129)
        with self.downloader() as owner, patch.object(source, 'MAX_CAPTION', 128):
            owner.stage = 'caption_download'
            with self.assertRaises(source.StopProof) as stopped: owner.urlopen(self.origin_url + '/compressed-bomb')
            self.assertEqual(stopped.exception.outcome, 'budget_exceeded')

    def test_expanded_redirect_bodies_and_later_responses_share_aggregate_budget(self):
        with self.downloader() as owner, patch.object(source, 'MAX_TOTAL', len(BODY) + 16):
            before = len(self.origin.requests)
            with self.assertRaises(source.StopProof) as stopped: owner.urlopen(self.origin_url + '/compressed-redirect')
            self.assertEqual(stopped.exception.outcome, 'budget_exceeded')
            self.assertEqual(self.origin.requests[before:], ['/compressed-redirect', '/must-not-follow'])
            self.assertEqual(owner.raw_metadata_bytes + owner.expanded_metadata_bytes, len(BODY) + 17)

    def test_denial_is_terminal_before_any_compressed_body_decode(self):
        with self.downloader() as owner, patch.object(source.zlib, 'decompressobj', side_effect=AssertionError('No denial decoding')) as decode:
            with self.assertRaises(source.StopProof) as stopped: owner.urlopen(self.origin_url + '/compressed-denied')
            self.assertEqual(stopped.exception.outcome, 'http_access_denied')
            self.assertEqual(owner.raw_metadata_bytes, 0); decode.assert_not_called()

    def test_unknown_length_metadata_and_internal_redirect_reads_are_bounded(self):
        for path in ('/unknown-length','/redirect-big'):
            with self.subTest(path=path),self.downloader() as owner,patch.object(source,'MAX_METADATA',16):
                before=len(self.origin.requests)
                with self.assertRaises(source.StopProof) as stopped:
                    owner.urlopen(self.origin_url+path)
                self.assertEqual(stopped.exception.outcome,'budget_exceeded')
                self.assertEqual(owner.raw_metadata_bytes,17)
                self.assertEqual(self.origin.requests[before:],[path])

    def test_native_redirect_cannot_downgrade_tls(self):
        with self.downloader() as owner:
            with self.assertRaises(source.StopProof) as stopped:
                owner.urlopen(self.origin_url+'/downgrade')
            self.assertEqual(stopped.exception.outcome,'request_scope_stopped')
            self.assertEqual((owner.count,owner.responses),(1,1))

    def test_native_redirect_cannot_start_plaintext_ftp(self):
        with self.downloader() as owner,patch.object(source.urllib.request.FTPHandler,'ftp_open',side_effect=AssertionError('FTP must be rejected before transport')) as ftp:
            with self.assertRaises(source.StopProof) as stopped:
                owner.urlopen(self.origin_url+'/ftp-redirect')
            self.assertEqual(stopped.exception.outcome,'request_scope_stopped')
            ftp.assert_not_called()

    def test_redirect_cannot_open_data_file_or_authenticated_target(self):
        for path in ('/data-redirect','/file-redirect','/userinfo-redirect'):
            with self.subTest(path=path),self.downloader() as owner,patch.object(source.urllib.request.DataHandler,'data_open',side_effect=AssertionError('Data URL must not open')) as data,patch.object(source.urllib.request.FileHandler,'file_open',side_effect=AssertionError('File URL must not open')) as file:
                with self.assertRaises(source.StopProof):owner.urlopen(self.origin_url+path)
                data.assert_not_called();file.assert_not_called()

    def test_unknown_length_media_is_bounded_before_bytes_reach_downloader(self):
        with self.downloader() as owner, patch.object(source, 'MAX_MEDIA', 16):
            owner.stage = 'media_download'
            owner.media_url = self.origin_url + '/unknown-length'
            with owner.urlopen(owner.media_url) as response:
                self.assertIsNone(response.headers.get('Content-Length'))
                with self.assertRaises(source.StopProof) as stopped:
                    response.read(4096)
                self.assertEqual(stopped.exception.outcome, 'budget_exceeded')
                self.assertEqual(owner.media_bytes, 0)
                self.assertEqual(owner.raw_media_bytes, 17)

    def test_read_all_negative_size_cannot_bypass_media_read_budget(self):
        with self.downloader() as owner, patch.object(source, 'MAX_MEDIA', 16):
            owner.stage = 'media_download'
            owner.media_url = self.origin_url + '/unknown-length'
            with owner.urlopen(owner.media_url) as response:
                with self.assertRaises(source.StopProof) as stopped:
                    response.read(-1)
                self.assertEqual(stopped.exception.outcome, 'budget_exceeded')
                self.assertEqual(owner.media_bytes, 0)
                self.assertEqual(owner.raw_media_bytes, 17, 'Unbounded read occurred before the budget check')


if __name__ == '__main__':
    unittest.main()
