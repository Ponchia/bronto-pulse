# Built-in connector catalog

Lifecycle: current

`pulse connectors --json` lists supported built-in sources, metric names,
group capabilities, auth modes and fixed endpoints **without loading a
configuration, opening the database or making network requests**. A connected
private dashboard can read `GET /api/v1/connectors` with the same access
controls as the other reporting APIs. Listing a connector is not evidence that
account access has been granted or a collector run succeeded.

## Plausible Stats API v2 (initial reference adapter)

Add an explicit, least-privilege team Stats API token to the server environment,
configured through a `tokenEnv` reference. On hosted Plausible, **Stats API
availability is plan-restricted**; check your plan and team access. Source
configuration:

```json
{
  "id": "analytics-plausible",
  "provider": "plausible",
  "siteId": "example.org",
  "timezone": "Europe/Madrid",
  "connection": "plausible-token"
}
```

The adapter queries `https://plausible.io/api/v2/query` using daily
`pageviews` and `visitors`, with `include.imports=false`. Configure a
timezone matching the Plausible site's reporting timezone. Imported GA4
or other imported history is omitted in this first version, not
silently deduplicated or assumed to be native. Daily visitors have
aggregation `none` and cannot be summed into monthly unique people.

## Umami Cloud v3 (initial reference adapter)

Use an Umami Cloud API key through an env reference and the website's
reported ID:

```json
{
  "id": "analytics-umami",
  "provider": "umami",
  "websiteId": "website-123",
  "connection": "umami-token"
}
```

The adapter queries only
`https://api.umami.is/v1/websites/{websiteId}/pageviews` in UTC day
buckets. The native response distinguishes daily pageviews and sessions.
Umami sessions cannot be summed to infer distinct monthly people. Provider
response dates, integer counts, request bounds and duplicates are checked.
No unsupported chart fields or private event detail are requested.

## Shared project mapping

Both resources may be bound to the same project as **separate** sources,
alongside Search Console, GitHub and npm:

```json
{
  "version": 1,
  "connections": [
    { "id": "plausible-token", "provider": "plausible", "tokenEnv": "PLAUSIBLE_STATS_TOKEN" },
    { "id": "umami-token", "provider": "umami", "tokenEnv": "UMAMI_CLOUD_KEY" }
  ],
  "resources": [
    {
      "id": "analytics-plausible",
      "provider": "plausible",
      "siteId": "example.org",
      "timezone": "Europe/Madrid",
      "connection": "plausible-token"
    },
    {
      "id": "analytics-umami",
      "provider": "umami",
      "websiteId": "website-123",
      "connection": "umami-token"
    }
  ],
  "projects": [
    {
      "id": "example",
      "label": "Example website",
      "resources": [{ "resource": "analytics-plausible" }, { "resource": "analytics-umami" }]
    }
  ]
}
```

This example creates neither a provider credential nor a scheduled job.
Run offline `pulse validate` and `pulse plan`; then account-specific
`pulse probe --resource ...` before a bounded `pulse sync`.
Do not share private configuration files, runtime secrets, source responses,
or query text in public issues/CI.

A Plausible Community Edition or Umami instance you run yourself is reached
through a separate pinned transport in the Node and OCI runtime, never by
changing a URL. See [self-hosted analytics source connectors](self-hosted-provider-adapters.md)
for its configuration and [ADR 0004](adr/0004-self-hosted-connector-egress.md)
for the threat model. A Worker refuses those sources.

**Maturity:** the hosted and the self-hosted variants are synthetic-tested.
No live account or installation was probed while authoring these adapters.
Their validation stays synthetic until a consenting operator connects a
matching account or instance.

See [providers](providers.md), [metric contracts](metrics.md) and
[product direction](product-strategy.md).
