# Offline-only caption CONNECT fixture

No certificate or private key is stored in this repository.

`tests/test_caption_proxy_transport.py` requires an existing OpenSSL executable
(on PATH, as supplied by the Ubuntu CI runner). It invokes the official local
`openssl req` command with a dedicated authored configuration to generate a new
RSA key and one-day self-signed certificate in a private temporary directory.
No downloads or package installation occur, and no key/certificate bytes are
printed or uploaded. Generation failure fails the tests rather than skipping the
transport proof. The temporary directory is removed after the module, including
test failures; generation exceptions/timeouts also clean up immediately.

The certificate names `www.youtube.com` solely to test original-host SNI and
certificate validation through a local CONNECT fixture. Only tests explicitly
passing its temporary path as `ca_file` trust it. It is never installed in a
system trust store; production continues using certifi. Tests also prove default
trust rejects it, and explicit fixture trust rejects another origin hostname.

All responses are authored fixture text, not live platform evidence. Run:

```sh
python -m unittest discover -s tests -p test_caption_proxy_transport.py -v
```
