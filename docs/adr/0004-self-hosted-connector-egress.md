# ADR 0004: Self-hosted analytics egress is an explicit runtime boundary

Lifecycle: proposal

Status: Proposed; **no self-hosted provider transport is shipped by this ADR**.

## Context

Pulse's current Plausible and Umami adapters use fixed public HTTPS origins,
bounded read operations and server-side API keys. A self-hosted installation
of Pulse should eventually read data from an independently self-hosted
Plausible Community Edition or Umami instance. It must not turn the source
configuration into an arbitrary credential-bearing HTTP proxy.

A generic 'baseUrl' field is dangerous: a malicious or misconfigured target,
redirect or DNS rebinding can send tokens to cloud metadata, internal services,
loopback endpoints or an attacker-controlled server. A hostname DNS check
followed by normal DNS resolution on connection is not a safe defense.

The dashboard and read-only API must never let a browser, MCP client or
query string set a collector's destination.

## Decision

1. Preserve the existing fixed SaaS origins and API path allowlists.
   Self-hosted deployments use an explicit _new transport mode_, not a
   relaxation of the global HTTP client.

2. Prefer a first **Node/OCI-only pinned HTTPS transport**. An
   operator-controlled private configuration declares the exact intended
   instance hostname and provider variant. A separate trusted setting pins
   a numerical destination. The socket must connect to that validated
   address, with no second DNS lookup, while retaining the original hostname
   for TLS SNI, certificate verification and HTTP Host.

3. Private-network access requires a separate, explicit operator admission
   and matching egress policy. Metadata addresses, link-local, multicast,
   unspecified, broadcast and unsafe aliases remain prohibited. A narrow
   first version may support pinned IPv4 only, pending IPv6 and mapped-address
   coverage. No default public proxy or open network access is enabled.

4. Limit requests to provider-specific read paths, methods, query keys and
   response budgets. No password-login workflow or provider administrative
   API is added. Prefer per-instance revocable API keys over reused broad
   credentials. All redirects fail closed and no response bodies or secrets
   appear in public diagnostics.

5. Retain _provider instance identity_ separately from the website that
   provider measures. Switching from hosted to self-hosted, or between
   self-hosted instances, creates a new resource identity and effective-dated
   mapping. Existing historical observations remain untouched.

6. Workers must **fail closed** for self-hosted transport until a Worker
   implementation provides equivalent destination-pinning guarantees. An
   ordinary Worker Fetch call does not prove those properties.

7. Third-party connector processes, if introduced later, receive separately
   scoped credentials and network access. They return bounded validated
   observations over a versioned protocol. Never dynamically load untrusted
   npm code into the existing collector's credential process.

## Rejected alternatives

| Approach                                               | Outcome                    | Reason                                                   |
| ------------------------------------------------------ | -------------------------- | -------------------------------------------------------- |
| Arbitrary URL field with ordinary fetch                | Rejected                   | SSRF, redirects, credential forwarding and DNS rebinding |
| DNS pre-check followed by normal network resolution    | Rejected                   | Time-of-check/time-of-use race                           |
| Automatically permit all private networks              | Rejected                   | Metadata/internal-service exposure                       |
| Force every OSS user to move to a paid analytics SaaS  | Rejected                   | Conflicts with self-hosting value proposition            |
| Pinned HTTPS destination with explicit local admission | Preferred first experiment | Small, auditable, independently testable                 |
| Out-of-process connector with network namespace        | Future option              | Better credential isolation but more infrastructure      |

## Provider endpoint distinctions

**Plausible hosted:** existing POST on
https://plausible.io/api/v2/query.
**Plausible self-hosted CE:** proposed POST to the instance-specific
/api/v2/query, subject to independently verified version and
authentication behavior.

**Umami Cloud:** existing GET on
https://api.umami.is/v1/websites/{id}/pageviews.
**Umami self-hosted:** proposed GET to its own
/api/websites/{id}/pageviews. Its documented API key must belong to that
instance, not Umami Cloud.

Plausible Stats is a read-only query API despite HTTP POST; the Events and
Sites APIs are separate, write-capable capabilities. The variant identity,
not just a provider name, determines which endpoint is permitted.

## Required acceptance gates

- Admission refuses untrusted URLs, userinfo, altered methods, unexpected
  ports/paths/query keys, encoded hostname tricks and unconfigured origins
  **before** credential access or network traffic.
- Network tests prove the actual socket connects to the pinned address;
  DNS rebinding, alternate lookup, private-address aliases and all blocked
  metadata ranges fail. IPv6 support needs explicit additional tests.
- TLS tests refuse a wrong certificate name, untrusted CA and insecure
  verification bypass. The request keeps the pinned hostname as SNI and Host.
  No redirects or cross-origin retries carry API credentials.
- API tests cover 401/403, expired/revoked keys, 429, 5xx, oversized bodies,
  malformed JSON, incomplete rows, different service versions and quota
  recovery. Failed collection preserves previous valid history.
- Source identity tests forbid historic mutation when an instance changes.
  Hosted adapter behavior, exports, reports, worker contracts and
  cross-provider no-double-counting remain unchanged.
- An isolated TLS fixture plus a real, consenting, self-hosted provider
  must pass before advertising the connection as supported.
- Node/OCI integration uses a separate, least-privilege credential per
  source and excludes arbitrary browser-triggered collection. Restart,
  backups and restore are independent of Cloudflare.

## Consequences

The tempting 'paste an instance URL' experience is postponed until its
security proof exists. This ADR does not enable endpoints, migrate data,
install software, change credentials, authorize infrastructure or modify
production. A future implementation requires adversarial tests and a
separate reviewed PR.

References:
[Umami API overview](https://docs.umami.is/docs/api),
[Umami API authentication](https://docs.umami.is/docs/api/authentication),
[Plausible Stats API](https://plausible.io/docs/stats-api),
[OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).
