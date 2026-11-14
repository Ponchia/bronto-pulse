# Self-hosted analytics source connectors

Lifecycle: current

Pulse can read daily traffic from a Plausible Community Edition or Umami
instance that the operator runs. It does so through a pinned HTTPS transport
that exists only in the Node and OCI runtime. The security contract is
[ADR 0004](adr/0004-self-hosted-connector-egress.md).

**Maturity: synthetic-tested, account-unverified.** The transport and both
adapters pass adversarial tests against a local TLS fixture. No real
Plausible Community Edition or Umami installation has been read yet. Treat
the first run against your instance as a pilot and compare its numbers with
the provider's own dashboard before relying on them.

## Provider variants

| Variant                     | Read                                                | Runtime           | Status in Pulse                      |
| --------------------------- | --------------------------------------------------- | ----------------- | ------------------------------------ |
| Plausible hosted            | `POST /api/v2/query` on `plausible.io`              | Node and Worker   | Hosted adapter, account-unverified   |
| Plausible Community Edition | `POST /api/v2/query` on the operator instance       | Node and OCI only | Synthetic-tested, account-unverified |
| Umami Cloud                 | `GET /v1/websites/{id}/pageviews` on `api.umami.is` | Node and Worker   | Hosted adapter, account-unverified   |
| Umami self-hosted           | `GET /api/websites/{id}/pageviews` on the instance  | Node and OCI only | Synthetic-tested, account-unverified |

Self-hosted Umami serves its API under `/api`; Umami Cloud uses `/v1`. The
variant, not the provider name, selects the path. Plausible's Stats API is a
read-only query although it uses POST. Pulse sends the same query to a
Community Edition instance as to the hosted service, with imported history
excluded. `pulse connectors --json` lists each variant under `selfHosted`.

## Configure an instance

A self-hosted instance is declared on the connection, next to the credential
it belongs to. The site names the same instance:

```json
{
  "connections": [
    {
      "id": "umami-home",
      "provider": "umami",
      "tokenEnv": "UMAMI_HOME_API_KEY",
      "selfHosted": {
        "instance": "home",
        "hostname": "analytics.example.org",
        "port": 443,
        "addressEnv": "UMAMI_HOME_ADDRESS"
      }
    }
  ],
  "resources": [
    {
      "id": "site-umami-home",
      "provider": "umami",
      "websiteId": "website-123",
      "connection": "umami-home",
      "instance": "home"
    }
  ]
}
```

| Field        | Meaning                                                                                |
| ------------ | -------------------------------------------------------------------------------------- |
| `instance`   | Your label for the installation. It is part of the stored identity.                    |
| `hostname`   | Exact lower-case name on the instance's certificate. Used for TLS and `Host` only.     |
| `port`       | 443 by default. Otherwise an unprivileged port from 1024 to 65535.                     |
| `addressEnv` | Name of the deployment setting that holds the address. It differs from the credential. |

There is no URL, scheme, path or header field, and unknown fields are
rejected. The hostname is never resolved. The address comes from the
deployment environment, not from the project configuration:

```sh
UMAMI_HOME_API_KEY=...            # a key created on this instance
UMAMI_HOME_ADDRESS=192.168.10.20  # one canonical IPv4 literal
PULSE_SELFHOSTED_PRIVATE_ADDRESSES=192.168.10.20
```

`PULSE_SELFHOSTED_PRIVATE_ADDRESSES` is a comma-separated list of exact
RFC 1918 addresses the deployment may reach. A private pin that is not on the
list is refused. The list takes no ranges, wildcards or spaces, and one
invalid entry voids the whole list. A public address needs no admission.

An instance whose certificate comes from a private authority needs that
authority in Node's trust store. Start Pulse with `NODE_EXTRA_CA_CERTS`
pointing at the authority certificate. Pulse has no setting that relaxes
certificate verification, and it refuses self-hosted reads when
`NODE_TLS_REJECT_UNAUTHORIZED=0` is set for the process.

Then validate, probe and collect as for any source:

```sh
pulse validate --json
pulse probe --resource site-umami-home --json
pulse sync --resource site-umami-home
```

## What the transport enforces

- **One destination.** Each read opens a fresh TLS connection to the pinned
  literal address. No DNS lookup, proxy, connection pool or keep-alive is
  involved. The connection is abandoned if the peer address differs.
- **Certificate for the declared name.** The hostname is the TLS server name
  and the name the certificate must verify for. A certificate for another
  name, for the address only, from an unknown authority, expired or not yet
  valid stops the read before the credential is sent.
- **One fixed read per variant.** Method, path and query keys are built from
  the validated site identifier and dates. No caller supplies a path, header
  or body.
- **No redirects.** Any 3xx response fails. The target is never contacted
  and never stored.
- **Bounds.** One total deadline (`settings.requestTimeoutMs`) covers
  connection, handshake, headers and body. The body is limited to 2 MiB,
  response headers to 16 KiB, and compressed responses are refused.
- **One attempt.** A failed read is not repeated inside the job, so a
  misbehaving instance receives the key once. The scheduler retries later.
- **Fixed error messages.** Errors name a category and a setting. They never
  contain the key, the address, the hostname or any part of a response.

## What is always refused

- Loopback, link-local and cloud metadata addresses, shared address space
  (`100.64.0.0/10`), unspecified, multicast, reserved, documentation and
  benchmarking ranges. No setting admits them.
- IPv6 addresses, address lists, ranges and every non-canonical IPv4 spelling.
- A hostname that is an address, a single label, `localhost`, a metadata
  name, or `plausible.io` and `umami.is`, which keep their hosted adapters.
- Password login. Use an API key created on the instance. A key for Umami
  Cloud or the hosted Plausible service is not a key for your instance.

## Identity and history

The stored identity of a self-hosted source contains the instance label,
hostname and port together with the site, for example
`umami:selfhosted:home@analytics.example.org:443:website-123`. A hosted
source keeps its existing identity.

Pulse therefore refuses to reuse a resource ID when a source moves from the
hosted service to an instance, between instances, to another hostname or
port, or to another label. Keep the old resource with `enabled: false`, add
a resource with a new ID, and give the project binding an effective date as
described in [configuration](configuration.md). The pinned address is not
part of the identity: the same installation can move to a new address.

## Cloudflare Workers

A Worker has no pinned transport. A self-hosted source fails there with a
configuration error before its credential is read, ready-only collection
skips it, and the health report names `node-pinned-transport` as missing. An
ordinary Worker `fetch` cannot prove which address it reached, so it is not
used as a substitute.

## Known limits

- No real provider installation has been read. Version differences in
  Plausible Community Edition and Umami responses are untested. The Umami
  instance version is not visible through this endpoint, so observations
  carry the methodology `umami-selfhosted-utc-daily-v1`.
- IPv4 only. IPv6, shared address space used by overlay networks, and
  same-host loopback are not reachable.
- The pinned address is static. If the instance moves, update the setting.
- The transport runs inside the collector process. A separate connector
  process with its own network scope remains a later option in ADR 0004.

## Before calling a pilot successful

1. Create an API key on the instance with read access to one site only.
2. Probe one day and compare pageviews with the provider dashboard for the
   same day and timezone.
3. Check a day without traffic, a revoked key and an unreachable instance.
   Each must fail or report no observation without replacing history.
4. Record the instance version and the result outside the repository.

Sources:
[Umami API overview](https://docs.umami.is/docs/api),
[Umami authentication](https://docs.umami.is/docs/api/authentication),
[Plausible Stats API](https://plausible.io/docs/stats-api),
[OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

## Repeatable hostile acceptance

`npm run test:selfhost:hostile` runs an independent synthetic adversarial suite
against the Node transport, runtime admission and Worker boundary. It requires
OpenSSL and uses temporary certificates and local fixture services; it contacts
no provider account. The suite is separate from ordinary `npm test` and covers
misleading host/address forms, TLS identity, redirects, proxy environment,
request/response bounds, deadlines and production CLI admission. A passing run
qualifies these tested boundaries, not a real provider account or production pilot.

With opt-in due-time scheduling, a self-hosted HTTP 429 also carries its parsed,
normalized `Retry-After` delay into the existing dataset retry guidance. The raw
header is never retained. It does not trigger an in-job retry or activate a
scheduler; explicit manual collection retains the documented operator override.

## Shared collection budgets

Pinned self-hosted reads use the job request budget and the smaller of the
configured response-byte limit and the transport's 2 MiB ceiling. An exhausted
request budget refuses before another credential read. The byte bound is passed
to the socket transport and checked again on its returned bytes; embedding a
custom transport does not disable it. Provider waits remain explicit scheduling
evidence, not permission to retry early.

Retry guidance is accepted only as a complete ASCII header of at most 64
characters. Longer or malformed values are ignored, never truncated into a
different delay; the ordinary failure cooldown then applies. Accepted very
large delays are retained as an explicit indefinite hold, visible in `doctor`
and clearable by an explicit collection, as described in the scheduling guide.
