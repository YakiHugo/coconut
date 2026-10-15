"""Explicit development-caption HTTP CONNECT transport; no ambient proxy discovery.

The owner trusts the selected loopback proxy to resolve and route permitted origin
hostnames. Unlike direct mode, this cannot attest the proxy's destination IP.
Origin TLS verification and the caller's provider/URL policy remain mandatory.
"""
import http.client
import re
import socket
import ssl
import urllib.request

from scripts.public_x_caption_guard import StopProof


def validate_proxy(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise StopProof('proxy_configuration_invalid')
    match = re.fullmatch(r'http://(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})/?', value)
    if not match or int(match[2]) > 65535:
        raise StopProof('proxy_configuration_invalid')
    return match[1].strip('[]'), int(match[2])


class TrustedProxyHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, proxy, *, context):
        # Revalidate even internal normalized input; no arbitrary socket targets.
        host, port = proxy
        endpoint = validate_proxy(f'http://{"[::1]" if host == "::1" else host}:{port}')
        if not context.check_hostname or context.verify_mode != ssl.CERT_REQUIRED:
            raise StopProof('proxy_configuration_invalid')
        super().__init__(context=context)
        self.endpoint = endpoint

    def https_open(self, request):
        endpoint = self.endpoint

        class TunnelConnection(http.client.HTTPSConnection):
            def __init__(self, origin, **kwargs):
                # urllib passes a validated origin authority, never a proxy URL.
                super().__init__(origin, **kwargs)
                target, port = self.host, self.port
                if port != 443 or target not in (
                    'www.youtube.com', 'www.bilibili.com', 'api.bilibili.com',
                    'aisubtitle.hdslb.com', 'subtitle.bilibili.com', 'subtitle.hdslb.com',
                    'i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com',
                ):
                    raise StopProof('request_scope_stopped')
                self.host, self.port = endpoint
                self.set_tunnel(target, 443)
                self._create_connection = self.connect_endpoint

            def connect_endpoint(self, address, timeout, source_address=None):
                if address != endpoint or source_address is not None:
                    raise StopProof('request_scope_stopped')
                raw = socket.socket(socket.AF_INET6 if endpoint[0] == '::1' else socket.AF_INET,
                                    socket.SOCK_STREAM)
                try:
                    raw.settimeout(timeout)
                    raw.connect(endpoint)
                    return raw
                except BaseException:
                    raw.close()
                    raise

            def _tunnel(self):
                # stdlib response parsing bounds line/header sizes. No proxy auth,
                # redirects, retries or response bodies are consumed here.
                target = self._tunnel_host + ':443'
                self.send(f'CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n'.encode('ascii'))
                response = http.client.HTTPResponse(self.sock, method='CONNECT')
                try:
                    response.begin()
                    if response.status != 200:
                        raise StopProof('proxy_auth_required' if response.status == 407 else 'proxy_connect_rejected')
                finally:
                    response.close()

            def connect(self):
                try:
                    # stdlib wraps the tunnel using the ORIGINAL hostname as SNI.
                    super().connect()
                except ssl.SSLError:
                    self.close()
                    raise StopProof('origin_tls_failed') from None
                except StopProof:
                    self.close()
                    raise
                except (OSError, http.client.HTTPException):
                    self.close()
                    raise StopProof('proxy_unavailable') from None

        return self.do_open(TunnelConnection, request, context=self._context)
