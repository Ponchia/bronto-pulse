# ADR 0002: Curated connectors, fixed egress and provider-native metric semantics

Lifecycle: current

Status: Accepted for the first built-in adapters. External plugin loading,
arbitrary self-hosted endpoints, HA storage and cross-provider reconciliation
remain proposals.

## Context

The initial five providers (GitHub, npm, Cloudflare RUM, Google Search Console,
Sense6 aggregates) proved source-aware history. Website owners may already use
Plausible, Umami or other analytics. Building another collector pixel would
duplicate their instrumentation; naïvely summing providers would misrepresent
unique people and pageviews.

## Decision

- Built-in connectors are statically registered with declared provider,
  authentication mode, source origin, metric keys, groups, timezone and
  historical capability. This is a **catalogue/manifest**, not an arbitrary
  runtime plugin loader or a stable third-party SDK yet.
- Existing source identifiers and metrics are preserved. New provider metrics
  are namespaced, so `cloudflare.pageviews`, `plausible.pageviews` and
  `umami.pageviews` are separately reportable, never a combined site total.
- Plausible Stats v2 and Umami Cloud v3 use only approved fixed HTTPS origins
  and read-only statistics endpoints, bounded requests and validated JSON.
  They never receive generic SQL, a user-supplied destination URL, contact
  enrichment or arbitrary event data.
- Plausible returns pageviews and **daily visitors in the configured site
  IANA timezone**, with imported history disabled. Daily visitors are
  non-additive. Umami Cloud pageviews and **daily sessions** are queried in UTC
  and sessions are non-additive. Missing response dates are unknown, not zero.
- The existing atomic lease, run history, partition publication and
  project-report semantics remain authoritative. New sources are opt-in and
  existing deployments are not modified.

## Consequences and limitations

Self-hosted Plausible/Umami use custom API origins, which the initial adapters
deliberately do **not** permit. Accepting a URL alongside an API token creates
SSRF/exfiltration and DNS-rebinding hazards. Design and test a separate
allowlisted transport policy before supporting those deployments.

Plausible Stats API is a **Business plan** feature on its hosted service.
The endpoints have account-specific permission and quota constraints. A
passing synthetic test does not prove that a user's account can query them.
Umami Cloud uses `https://api.umami.is/v1` and an API key. No browser tracking
code or paid service is installed by this change.

The manifests are introspectable through `pulse connectors --json` offline
and the authenticated `/api/v1/connectors` read API. They contain no secrets.
Actual provider discovery and user grants remain separate checks. Future
provider versions should be pinned and tested against live account fixtures
before declaring operational support.

References: [Plausible Stats API](https://plausible.io/docs/stats-api),
[Umami API](https://docs.umami.is/docs/api),
[Umami Cloud API keys](https://docs.umami.is/docs/cloud/api-key).
