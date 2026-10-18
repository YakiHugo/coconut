"""Offline CONNECT/TLS boundary proof. No platform, extractor, or model calls."""
import contextlib
import os
import shutil
import subprocess
import tempfile
import socket
import ssl
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from scripts import caption_proxy_transport as proxy_transport
from scripts import public_video_caption_guard as guard

CERT = KEY = None


@contextlib.contextmanager
def temporary_certificates():
    """Generate local, one-day fixture material; never persist or print its bytes."""
    openssl = shutil.which('openssl')
    if not openssl:
        raise RuntimeError('Offline CONNECT tests require an existing OpenSSL executable')
    with tempfile.TemporaryDirectory(prefix='coconut-caption-test-tls-') as directory:
        root = Path(directory)
        cert, key, config = root/'cert.pem', root/'key.pem', root/'openssl.cnf'
        config.write_text('[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n'
                          '[dn]\nCN=www.youtube.com\nO=Offline caption proxy test only\n'
                          '[ext]\nsubjectAltName=DNS:www.youtube.com\nbasicConstraints=critical,CA:TRUE\n')
        subprocess.run([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-days', '1', '-sha256', '-config', str(config),
                        '-keyout', str(key), '-out', str(cert)],
                       check=True, timeout=20, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        yield str(cert), str(key)


def setUpModule():
    global CERT, KEY
    certificates = temporary_certificates()
    CERT, KEY = certificates.__enter__()
    # unittest invokes module cleanups even if a test fails. Generation errors
    # unwind TemporaryDirectory before returning, including subprocess timeout.
    unittest.addModuleCleanup(certificates.__exit__, None, None, None)

YOUTUBE = 'https://www.youtube.com/watch?v=BaW_jenozKc'
CAPTION = 'https://www.youtube.com/api/timedtext?v=BaW_jenozKc&fmt=vtt'
BODY = b'WEBVTT\n\n00:00.000 --> 00:01.000\nOffline authored fixture.\n'


def request(url=CAPTION, headers=None):
    return SimpleNamespace(url=url, method='GET', data=None, headers=headers or {})


def read_headers(connection):
    data = bytearray()
    while not data.endswith(b'\r\n\r\n'):
        chunk = connection.recv(1)
        if not chunk:
            raise EOFError('connection ended before headers')
        data.extend(chunk)
        if len(data) > 32768:
            raise ValueError('oversized test request')
    return bytes(data)


class ConnectFixture:
    """Loopback-only proxy: accepts CONNECT, then serves fixture origin TLS."""
    def __init__(self, connect_status=200, origin_status=200, location=None, body=BODY):
        self.body = body
        self.connect_status = connect_status
        self.origin_status = origin_status
        self.location = location
        self.connect_requests = []
        self.origin_requests = []
        self.sni = []
        self.errors = []
        self.connections = 0
        self.stop = threading.Event()
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(('127.0.0.1', 0))
        self.listener.listen(4)
        self.listener.settimeout(0.1)
        self.url = 'http://127.0.0.1:' + str(self.listener.getsockname()[1])
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.load_cert_chain(CERT, KEY)
        self.context.set_servername_callback(lambda _socket, name, _ctx: self.sni.append(name))
        self.thread = threading.Thread(target=self.serve, daemon=True)

    def serve(self):
        while not self.stop.is_set():
            try:
                connection, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            self.connections += 1
            connection.settimeout(3)
            try:
                self.connect_requests.append(read_headers(connection))
                if self.connect_status != 200:
                    connection.sendall(('HTTP/1.1 %d Denied\r\nContent-Length: 0\r\nConnection: close\r\n\r\n' % self.connect_status).encode())
                    continue
                connection.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                connection = self.context.wrap_socket(connection, server_side=True)
                self.origin_requests.append(read_headers(connection))
                extra = ('Location: %s\r\n' % self.location) if self.location else ''
                connection.sendall(('HTTP/1.1 %d Fixture\r\nContent-Type: text/vtt\r\nContent-Length: %d\r\n%sConnection: close\r\n\r\n' % (self.origin_status, len(self.body), extra)).encode() + self.body)
            except (ssl.SSLError, EOFError, ConnectionResetError):
                # Expected when the client rejects this fixture's certificate.
                pass
            except Exception as error:
                self.errors.append(error)
            finally:
                connection.close()

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.listener.close()
        self.thread.join(4)
        if self.thread.is_alive():
            raise AssertionError('fixture server did not stop')
        if self.errors:
            raise AssertionError(self.errors)


@contextlib.contextmanager
def no_origin_dns():
    original = socket.getaddrinfo
    lookups = []
    def resolve(host, *args, **kwargs):
        lookups.append(host)
        if host not in ('127.0.0.1', '::1'):
            raise AssertionError('origin DNS or fallback attempted: ' + str(host))
        return original(host, *args, **kwargs)
    with patch.object(socket, 'getaddrinfo', side_effect=resolve):
        yield lookups


class ProxyConfigurationTests(unittest.TestCase):
    def test_temporary_certificate_material_is_removed_after_use(self):
        with temporary_certificates() as (cert, key):
            directory = Path(key).parent
            self.assertTrue(Path(cert).is_file())
            self.assertTrue(Path(key).is_file())
        self.assertFalse(directory.exists())

    def test_generation_failure_removes_temporary_directory(self):
        directories = []
        create = tempfile.TemporaryDirectory
        def remember(*args, **kwargs):
            temporary = create(*args, **kwargs)
            directories.append(Path(temporary.name))
            return temporary
        with patch.object(tempfile, 'TemporaryDirectory', side_effect=remember), \
                patch.object(subprocess, 'run', side_effect=TimeoutError('fixture generation timeout')):
            with self.assertRaises(TimeoutError), temporary_certificates():
                self.fail('failed generation must not yield material')
        self.assertEqual(len(directories), 1)
        self.assertFalse(directories[0].exists())

    def test_exact_loopback_addresses_and_optional_trailing_slash(self):
        self.assertIsNone(proxy_transport.validate_proxy(None))
        for value, expected in [('http://127.0.0.1:1', ('127.0.0.1', 1)),
                                ('http://127.0.0.1:65535/', ('127.0.0.1', 65535)),
                                ('http://[::1]:8080', ('::1', 8080))]:
            with self.subTest(value=value):
                self.assertEqual(proxy_transport.validate_proxy(value), expected)

    def test_invalid_configuration_never_opens_a_socket(self):
        invalid = ['', 'http://localhost:8080', 'https://127.0.0.1:8080',
            'socks5://127.0.0.1:8080', 'http://127.0.0.2:8080',
            'http://192.168.1.1:8080', 'http://198.18.0.1:8080',
            'http://example.com:8080', 'http://127.0.0.1',
            'http://127.0.0.1:0', 'http://127.0.0.1:65536',
            'http://127.0.0.1:abc', 'http://user:pass@127.0.0.1:8080',
            'http://127.0.0.1:8080/path', 'http://127.0.0.1:8080?x=1',
            'http://127.0.0.1:8080#x', ' http://127.0.0.1:8080',
            'http://127.0.0.1:8080\n', 'http://[::ffff:127.0.0.1]:8080']
        with patch.object(socket, 'socket') as create:
            for value in invalid:
                with self.subTest(value=value), self.assertRaises(guard.StopProof) as caught:
                    guard.VideoTransport(YOUTUBE, proxy=value)
                self.assertEqual(caught.exception.outcome, 'proxy_configuration_invalid')
            create.assert_not_called()


    def test_unverified_tls_context_is_rejected(self):
        with patch.object(socket, 'socket') as create:
            with self.assertRaises(guard.StopProof) as caught:
                proxy_transport.TrustedProxyHTTPSHandler(('127.0.0.1', 8080),
                    context=ssl._create_unverified_context())
            self.assertEqual(caught.exception.outcome, 'proxy_configuration_invalid')
            create.assert_not_called()


class ConnectTransportTests(unittest.TestCase):
    def test_real_connect_verified_origin_tls_and_no_origin_dns(self):
        with ConnectFixture() as proxy, no_origin_dns():
            transport = guard.VideoTransport(YOUTUBE, ca_file=CERT, proxy=proxy.url)
            body, _, status = transport.send(request())
            self.assertEqual((body, status), (BODY, 200))
            self.assertEqual((transport.count, transport.responses, transport.total), (1, 1, len(BODY)))
            self.assertEqual(proxy.connections, 1)
            self.assertTrue(proxy.connect_requests[0].startswith(b'CONNECT www.youtube.com:443 HTTP/1.'))
            self.assertEqual(proxy.sni, ['www.youtube.com'])
            self.assertTrue(proxy.origin_requests[0].startswith(b'GET /api/timedtext?'))
            self.assertIn(b'Host: www.youtube.com\r\n', proxy.origin_requests[0])
            self.assertNotIn(b'Proxy-Authorization:', proxy.connect_requests[0])

    def test_untrusted_certificate_stops_without_direct_fallback(self):
        with ConnectFixture() as proxy, no_origin_dns():
            transport = guard.VideoTransport(YOUTUBE, proxy=proxy.url)
            with self.assertRaises(guard.StopProof) as caught:
                transport.send(request())
            self.assertEqual(caught.exception.outcome, 'origin_tls_failed')
            self.assertEqual(proxy.connections, 1)
            self.assertEqual(proxy.origin_requests, [])
            self.assertEqual((transport.count, transport.responses, transport.total), (1, 0, 0))

    def test_trusted_certificate_for_wrong_hostname_is_rejected(self):
        bilibili = 'https://www.bilibili.com/video/BV1xx411c7mD'
        with ConnectFixture() as proxy, no_origin_dns():
            transport = guard.VideoTransport(bilibili, ca_file=CERT, proxy=proxy.url)
            with self.assertRaises(guard.StopProof) as caught:
                transport.send(request(bilibili))
            self.assertEqual(caught.exception.outcome, 'origin_tls_failed')
            self.assertEqual(proxy.sni, ['www.bilibili.com'])
            self.assertEqual(proxy.connections, 1)
            self.assertEqual(proxy.origin_requests, [])
            self.assertEqual((transport.count, transport.responses, transport.total), (1, 0, 0))

    def test_connect_authentication_or_access_denial_is_terminal(self):
        for status in (407, 403):
            with self.subTest(status=status), ConnectFixture(connect_status=status) as proxy, no_origin_dns():
                transport = guard.VideoTransport(YOUTUBE, ca_file=CERT, proxy=proxy.url)
                with self.assertRaises(guard.StopProof) as caught:
                    transport.send(request())
                self.assertEqual(caught.exception.outcome, 'proxy_auth_required' if status == 407 else 'proxy_connect_rejected')
                self.assertEqual(proxy.connections, 1)
                self.assertEqual(proxy.origin_requests, [])
                self.assertEqual((transport.count, transport.responses, transport.total), (1, 0, 0))

    def test_origin_access_denials_count_only_origin_response_and_never_retry(self):
        for status in (401, 403, 429):
            with self.subTest(status=status), ConnectFixture(origin_status=status) as proxy, no_origin_dns():
                transport = guard.VideoTransport(YOUTUBE, ca_file=CERT, proxy=proxy.url)
                with self.assertRaises(guard.StopProof) as caught:
                    transport.send(request())
                self.assertEqual(caught.exception.outcome, {401: 'login_required', 403: 'http_access_denied', 429: 'rate_limited'}[status])
                self.assertEqual(proxy.connections, 1)
                self.assertEqual(len(proxy.origin_requests), 1)
                self.assertEqual((transport.count, transport.responses, transport.total), (1, 1, 0))

    def test_caption_response_budget_exact_boundary_and_one_byte_over(self):
        for size in (guard.MAX_CAPTION, guard.MAX_CAPTION + 1):
            with self.subTest(size=size), ConnectFixture(body=b'x' * size) as proxy, no_origin_dns():
                transport = guard.VideoTransport(YOUTUBE, ca_file=CERT, proxy=proxy.url)
                if size == guard.MAX_CAPTION:
                    self.assertEqual(len(transport.send(request())[0]), size)
                else:
                    with self.assertRaises(guard.StopProof) as caught:
                        transport.send(request())
                    self.assertEqual(caught.exception.outcome, 'budget_exceeded')
                self.assertEqual((transport.count, transport.responses, transport.total), (1, 1, size))
                self.assertEqual(proxy.connections, 1)

    def test_request_budget_stops_before_another_connect(self):
        with ConnectFixture() as proxy, no_origin_dns():
            transport = guard.VideoTransport(YOUTUBE, ca_file=CERT, proxy=proxy.url)
            transport.count = guard.MAX_REQUESTS - 1
            self.assertEqual(transport.send(request())[0], BODY)
            with self.assertRaises(guard.StopProof) as caught:
                transport.send(request())
            self.assertEqual(caught.exception.outcome, 'budget_exceeded')
            self.assertEqual(transport.count, guard.MAX_REQUESTS)
            self.assertEqual(transport.responses, 1)
            self.assertEqual(proxy.connections, 1)

    def test_total_response_budget_exact_boundary_then_exceeded(self):
        with ConnectFixture() as proxy, no_origin_dns():
            transport = guard.VideoTransport(YOUTUBE, ca_file=CERT, proxy=proxy.url)
            transport.total = guard.MAX_TOTAL - len(BODY)
            self.assertEqual(transport.send(request())[0], BODY)
            self.assertEqual(transport.total, guard.MAX_TOTAL)
            with self.assertRaises(guard.StopProof) as caught:
                transport.send(request())
            self.assertEqual(caught.exception.outcome, 'budget_exceeded')
            self.assertEqual((transport.count, transport.responses), (2, 2))
            self.assertEqual(transport.total, guard.MAX_TOTAL + len(BODY))
            self.assertEqual(proxy.connections, 2)

    def test_redirects_even_same_origin_are_terminal(self):
        for location in (YOUTUBE, 'https://accounts.google.com/login'):
            with self.subTest(location=location), ConnectFixture(origin_status=302, location=location) as proxy, no_origin_dns():
                transport = guard.VideoTransport(YOUTUBE, ca_file=CERT, proxy=proxy.url)
                with self.assertRaises(guard.StopProof):
                    transport.send(request())
                self.assertEqual(proxy.connections, 1)
                self.assertEqual(len(proxy.origin_requests), 1)

    def test_scope_rejections_happen_before_connect(self):
        with ConnectFixture() as proxy, no_origin_dns(), patch.object(socket, 'create_connection') as connect:
            transport = guard.VideoTransport(YOUTUBE, ca_file=CERT, proxy=proxy.url)
            for denied in [request('https://rr1.googlevideo.com/videoplayback'),
                           request('https://accounts.google.com/login'),
                           request(CAPTION + '&tlang=fr'),
                           request('https://127.0.0.1/api/timedtext?v=BaW_jenozKc&fmt=vtt'),
                           request('https://10.0.0.1/api/timedtext?v=BaW_jenozKc&fmt=vtt'),
                           request('https://198.18.0.1/api/timedtext?v=BaW_jenozKc&fmt=vtt'),
                           request('https://[::1]/api/timedtext?v=BaW_jenozKc&fmt=vtt'),
                           request('https://www.youtube.com:444/api/timedtext?v=BaW_jenozKc&fmt=vtt'),
                           request('https://www.youtube.com/api/timedtext?v=other_video&fmt=vtt'),
                           request(headers={'Cookie': 'session=private'}),
                           request(headers={'Authorization': 'Bearer private'}),
                           request(headers={'Proxy-Authorization': 'Basic private'}),
                           request(headers={'Host': 'evil.test'}),
                           request(headers={'Connection': 'upgrade'}),
                           request(headers={'Proxy-Connection': 'keep-alive'})]:
                with self.subTest(url=denied.url, headers=denied.headers), self.assertRaises(guard.StopProof):
                    transport.send(denied)
            connect.assert_not_called()
            self.assertEqual(proxy.connections, 0)

    def test_unavailable_proxy_has_no_direct_fallback(self):
        # Reserve a loopback port without listening, so it cannot be reassigned.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as unavailable, no_origin_dns():
            unavailable.bind(('127.0.0.1', 0))
            transport = guard.VideoTransport(YOUTUBE, ca_file=CERT,
                proxy='http://127.0.0.1:' + str(unavailable.getsockname()[1]))
            with self.assertRaises(guard.StopProof) as caught:
                transport.send(request())
            self.assertEqual(caught.exception.outcome, 'proxy_unavailable')
            self.assertEqual(transport.count, 1)

    def test_ambient_proxy_and_no_proxy_cannot_override_explicit_endpoint(self):
        environment = {'HTTP_PROXY': 'http://ambient.invalid:8080',
                       'HTTPS_PROXY': 'http://ambient.invalid:8080',
                       'ALL_PROXY': 'socks5://ambient.invalid:8080',
                       'NO_PROXY': '*', 'no_proxy': '*'}
        with ConnectFixture() as proxy, no_origin_dns(), patch.dict(os.environ, environment):
            transport = guard.VideoTransport(YOUTUBE, ca_file=CERT, proxy=proxy.url)
            self.assertEqual(transport.send(request())[0], BODY)
            self.assertEqual(proxy.connections, 1)

    def test_direct_mode_still_rejects_fake_ip_before_socket_creation(self):
        records = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('198.18.0.1', 443))]
        transport = guard.VideoTransport(YOUTUBE)
        with patch.object(socket, 'getaddrinfo', return_value=records), patch.object(socket, 'socket') as create:
            with self.assertRaises(guard.StopProof) as caught:
                transport.send(request())
            self.assertEqual(caught.exception.outcome, 'non_public_address')
            create.assert_not_called()


if __name__ == '__main__':
    unittest.main()
