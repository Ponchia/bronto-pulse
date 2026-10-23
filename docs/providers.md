# Provider setup and evidence

Lifecycle: current

Run `pulse probe --json` before activating a source. A fixture passing is not
evidence that your account grants access. All collectors use a fixed HTTPS
origin allowlist, bounded response sizes, three-attempt retry budgets and safe
errors. Provider requests use manual redirect handling for Workers compatibility.
All 3xx responses fail with `REDIRECT`, without following the Location header,
retrying the redirect or storing upstream bodies. Credentials never move to a
redirect target. There is no dashboard scraping or access-token capture from browsers.

## GitHub

Configure a connection using `tokenEnv`, or GitHub App environment references
`appIdEnv`, `privateKeyEnv` and `installationIdEnv`. App private keys must be
unencrypted PKCS8. Convert the issued key locally if necessary; do not upload it
to source control. Install on selected repositories only. Repository traffic
requires **Administration: read**; repository metadata and release reads need
appropriate metadata/contents access. Public metadata can be queried without a
connection, while traffic cannot.

Views and clones expose the recent rolling 14-day window with UTC daily buckets.
Top referrers and paths are rolling top-ten snapshots. Repo totals are current
snapshots; releases use tag names and sanitized URLs, not author profiles or
release bodies. The REST API version is explicitly pinned in the adapter.

Source: [GitHub traffic REST reference](https://docs.github.com/en/rest/metrics/traffic).

## npm

No credential is used. Configure a scoped or unscoped package. Daily history
uses the public downloads endpoint in chunks no larger than 365 days, verifying
that returned start/end/package identity match the request. Today is excluded;
yesterday is marked provisional. Provider failures or missing dates are not
turned into zero downloads. These are distribution events, not human adoption.

Source: [npm download count reference](https://github.com/npm/registry/blob/main/docs/download-counts.md).

## Cloudflare Web Analytics

Use a read-only token authorized for the selected account's Analytics datasets.
`accountId` and **RUM siteTag** identify the resource. The siteTag is not the
public `data-cf-beacon` token. The collector never installs or changes a beacon.
RUM data already collected by the website is required.

`probe` asks for the account-specific dataset settings and tests a real query.
The `totals`, `pages` and `referrers` groups use
`rumPageloadEventsAdaptiveGroups`; `performance` uses
`rumPerformanceEventsAdaptiveGroups`. The optional `vitals` group uses
`rumWebVitalsEventsAdaptiveGroups`. Field names and permission availability
must be validated against the account schema. Unsupported fields fail the
individual group and do not fake a measurement. The default is totals/pages.

Duration normalization is explicit (`microseconds`, the default, or
`milliseconds`). Confirm the unit before relying on performance numbers.
Negative no-sample sentinel values are unavailable. Sampling flags are kept;
counts are not multiplied by a guessed sample factor. Group-limit equality
is treated as possible truncation and requires a smaller query window.

Sources: [GraphQL limits](https://developers.cloudflare.com/analytics/graphql-api/limits/),
[query basics](https://developers.cloudflare.com/analytics/graphql-api/getting-started/querying-basics/),
[Web Analytics metric meanings](https://developers.cloudflare.com/web-analytics/data-metrics/high-level-metrics/).

## Google Search Console

Use a short-lived `tokenEnv`, or OAuth `clientIdEnv`, `clientSecretEnv` and
`refreshTokenEnv` for unattended collection. Grant only
`https://www.googleapis.com/auth/webmasters.readonly`. Add the exact URL-prefix
or `sc-domain:` property to which that Google identity has access. An external
OAuth app left in Testing can lose refresh access after seven days; configure
the Google app's publishing/consent state deliberately. Credentials are never
requested through the browser reporting UI.

Totals, canonical pages and optional queries remain separate groups. Pacific
source dates are preserved. Incomplete recent dates are provisional. Pagination
is bounded and does not make Google's internally limited rows exhaustive.
Queries are disabled unless `collectQueries` is true. Page URLs have query
strings and fragments removed. No search term is logged in an operational error.

Sources: [Search Analytics query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query),
[OAuth expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

## Sense6 optional counters

Configure its Cloudflare account and D1 database ID with an appropriate private
read/query permission. Only the fixed query over `daily_metrics(day,test,metric,count)`
is supported. Test/event pairs are constrained to the Sense6 allowlist. Extra
fields are rejected. This is not a general SQL endpoint and never retrieves
answers, scores, local journals, participant identities or exact event times.
The product counter is not interchangeable with Cloudflare visits/pageviews.
