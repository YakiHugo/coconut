# Private access from your own devices (opt-in development profile)

Coconut still binds only `127.0.0.1`. Without an explicit profile it rejects all
proxy-marked requests and non-local hosts. This feature does not install software,
change networking, sign in, register a background service, or enable sharing.
The computer running Coconut must remain online. This is one library on one
computer, not real-time collaboration or automatic synchronization between databases.

## Deployment prerequisites and trust boundary

After the owner specifically approves installation, account/device authorization,
network access, and any persistent service setup, an administrator can configure
[Tailscale Serve](https://tailscale.com/kb/1312/serve) as a private HTTPS reverse
proxy to the existing loopback service. Do not use Funnel. Restrict tailnet access
to the owner's intended devices using the applicable access policy. Coconut also
checks one exact owner login, so access granted to some other tailnet user alone
does not grant access to the reader. Tagged clients without user identity fail closed.

The explicit `tailscale-serve` profile trusts the local Serve process to overwrite
identity headers after verifying the tailnet identity. Coconut requires the exact
HTTPS Host, owner login, forwarded Host and HTTPS protocol, a loopback peer, and
same-origin browser requests. Funnel, duplicate security headers, wrong identity,
and proxy headers attached to a localhost Host are rejected. Forwarded headers
alone are never authentication. The identity behavior is documented in
[Tailscale's Serve implementation](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go).

This is a single-user, trusted-computer boundary, not authentication against
malicious local processes. A process already running on that computer can call
its loopback service. Do not put another untrusted proxy in front of the port,
rewrite the Host to localhost, forward arbitrary client identity headers, or bind
the service to `0.0.0.0`. This profile does not add passwords or store credentials.

## Explicit configuration, after approval

Choose the HTTPS origin actually assigned by Serve, without a trailing slash or
path, and the exact ASCII login that Serve identifies for the owner. These example
values are fictional; substitute the verified values. Set variables only for the
Coconut process you intend to expose:

```sh
COCONUT_PRIVATE_PROXY=tailscale-serve \
COCONUT_PRIVATE_ORIGIN=https://your-computer.your-tailnet.ts.net \
COCONUT_PRIVATE_OWNER=owner@example.test \
COCONUT_BACKEND_LABEL='My computer' \
node desktop/server.mjs --port 8080
```

The same variables work with `npm run dev`. Both real entrypoints validate the
profile before starting. Partial settings fail closed. The default development
port is 8080. The optional backend label is a short human-readable name, not a
filesystem path. The desktop packaged app does not automatically inherit/enable
this profile; use the explicit CLI/development service.

The CLI uses its usual `~/.coconut/library` and `~/.coconut/tasks`; development uses
its own repository-local `.coconut/dev/` directories. `COCONUT_LIBRARY_DIRECTORY`
can select an existing absolute canonical library location, but never run two
writers over that same directory. Stop the other service first. Access from a
phone does not itself migrate a browser's existing library. Complete any required
migration on the computer, then verify both devices report the same library ID.

After separately approved Serve setup, the private reverse proxy target should be
`http://127.0.0.1:8080`. The administrator can use `tailscale serve --bg
http://127.0.0.1:8080` and verify with `tailscale serve status`; this command creates
persistent network configuration and must not be run without that approval.
Verify its reported HTTPS origin exactly matches the configured origin and that
Funnel is disabled. Keep the serving computer awake while using the phone.

To stop Coconut access, stop its process and remove the profile environment
variables before restarting. Managing or resetting Serve itself is a separate
network configuration action. No launchd registration is included.

## What an authorized owner can do

- Read, search, annotate, import text, and save into the canonical library, with
  the existing revision/CAS conflict checks and idempotent receipts.
- Explicitly ask questions or translate, using the existing single sending-scope
  and subscription-quota consent. Opening a page or fetching health never calls a
  model. Provider login/setup remains an action on the serving computer.
- Explicitly submit and resume background summaries. The same task IDs, attempt
  IDs, checkpoint rules, consent, and idempotency keys apply. Disconnecting after
  acceptance does not cancel a durable task or automatically retry an uncertain
  request. Reconnect and query the original task/receipt.
- Use existing bounded public-caption and podcast imports by explicit action.

Native media tokens/paths and library migration management remain local-only.
A phone cannot use a file picker on the serving computer. Public-source media
routes remain available; they do not grant arbitrary filesystem access.

`/api/health` and `/api/v1/executor` return request-specific `client` capabilities,
a stable opaque client ID, backend display name, and canonical library ID. The
executor reports `remoteSubmission: true` only to the authorized private owner.
Remote health omits storage paths. Error codes and actionable provider failures
remain visible, with local paths redacted from diagnostics. A successful response
means online at that instant; the client must disable dependent actions on failed
refreshes and recheck identity/library after reconnecting. It must not infer trust
from a hostname or interpret an old capability response as permanent authority.

## Verification before use

Run `node --test tests/desktop-private-client.test.mjs` and `npm run test:desktop`.
The private-profile suite uses only temporary loopback servers, fictional owner
identities and fake providers. It covers real CLI/development entrypoints,
unauthorized requests, proxy-localhost downgrade, Funnel, duplicate headers,
passive zero-provider discovery, same-library CAS writes, explicit AI/translation,
and idempotent submission/resume. It does not install or test a live tailnet.
Before declaring a real deployment usable, separately verify the approved phone
can read the intended library, an unauthorized identity cannot, connection loss
is shown honestly, and explicit actions retain their normal consent.
