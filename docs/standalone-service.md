# Standalone Coconut service

The same React application and Node service run on a Mac, a private host or a
server behind HTTPS. Electron is optional. Use Node 22.21+ or 24.5+, then:

```sh
npm ci --ignore-scripts
cp .env.example .env
npm start
```

The listener defaults to `127.0.0.1:8080`. Set `COCONUT_PORT` if that port is
occupied. `COCONUT_DATA_DIRECTORY` is an absolute persistent directory, defaulting
to `~/.coconut/service`, containing `library/` and `tasks/`. This is deliberately
separate from legacy desktop/development libraries; explicitly select/copy the
intended complete library with all writers stopped. Never run two writers over
one directory or place a live SQLite database in cloud-sync/network storage.

## Browser access from other devices

Set `COCONUT_PUBLIC_ORIGIN` to the exact public HTTPS origin, without a path or
trailing slash, and `COCONUT_OWNER_TOKEN` to a private randomly generated token.
The login page exchanges the token for an HttpOnly, Secure, SameSite=Strict cookie
valid for 12 hours. The token is never stored in browser localStorage or URLs.
The same secret/origin preserves sessions over service restart; rotating the
secret invalidates existing sessions. `/login` also provides logout.

Terminate HTTPS at a reverse proxy and preserve the public Host header. Forward
to the service's private HTTP listener. Forwarded identity headers grant no
access. Requests with a rewritten localhost Host are rejected, not treated as
local privileged clients. Expose only the HTTPS proxy publicly; use `COCONUT_HOST=0.0.0.0` for a
container/private interface only with the owner profile configured. A public
listener without an HTTPS origin and owner token is rejected at startup.
Plain HTTP owner sessions are supported only on localhost/127.0.0.1 for local
use and browser tests. This is a single-owner service, not multi-user hosting.

The authenticated owner can invoke server-side source acquisition, AI and text
processing regardless of browser location, subject to configured capabilities
and the existing explicit execution consent. Provider credentials and models
belong to the serving machine. Browser-profile login and native filesystem
authorization remain local operations. Nothing installs a model or logs in to a
provider on startup.

## Source networking and trust

The service uses one source-network configuration for identified Xiaoyuzhou and
video adapters. With no explicit setting it reads validated standard proxy
environment variables when present; otherwise it uses ordinary networking,
including transparent TUN. `COCONUT_SOURCE_NETWORK=direct` ignores environment
proxies. `environment` snapshots supported proxy/NO_PROXY variables; `custom`
uses `COCONUT_SOURCE_PROXY`. The old podcast/caption proxy settings are accepted
only when unambiguous. Node's built-in proxy agents own the HTTPS tunnel; Coconut
does not implement another tunnel for this service path. macOS system HTTP/PAC
settings alone are not automatically read by standalone Node.

For identified Xiaoyuzhou HTTPS origins, the authenticated process owner trusts
the serving machine's network, including Fake-IP. Exact origins, redirect scope,
TLS validation, content types, sizes and deadlines remain enforced. This policy
does not pretend that a Fake-IP identifies the true destination address. Generic
RSS/arbitrary URLs retain the existing DNS-validated pinned-socket policy;
non-public results remain rejected. It is not safe to globally allow reserved
addresses or silently downgrade after a denied request. An untrusted multi-user
URL-fetching service needs a separately controlled/isolated egress boundary.

## Verification

`npm run test:service` uses authored local HTTP and storage fixtures. Normal CI
also checks existing browser and actual packaged Electron lifecycle contracts.
These tests never install a model or claim public-platform availability.
