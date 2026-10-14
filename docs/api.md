# Read-only reporting API

Lifecycle: current

Every `/api/v1/` endpoint requires `Authorization: Bearer <PULSE_API_TOKEN>` or
a signed browser session. Session cookies are HTTP-only, SameSite Strict,
secure over HTTPS and expire after one hour. `/health` is a minimal public
liveness check with no project information.

| Route                                                           | Result                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| `GET /api/v1/projects`                                          | Project catalog without provider credentials                 |
| `GET /api/v1/projects/:id/report?from=YYYY-MM-DD&to=YYYY-MM-DD` | Project report, quality, series, source details, annotations |
| `GET /api/v1/portfolio?from=...&to=...`                         | Separate project reports; no cross-source adoption sum       |
| `GET /api/v1/health`                                            | Credential presence, failures and stale groups               |
| `GET /api/v1/runs?resource=id&limit=100`                        | Bounded collection run history                               |
| `GET /api/v1/metrics`                                           | Metric definitions and aggregation caveats                   |
| `GET /api/v1/export`                                            | Private portable archive; refuses concurrent collection      |

`POST /login` accepts a URL-encoded reporting token with same-origin validation.
`POST /logout` deletes the signed session. Other writes are unavailable through
HTTP. The API does not accept provider URLs, arbitrary SQL, OAuth credentials,
collector actions or new project configuration.

A report has `schemaVersion`, `project`, `window`, `cards`, `breakdowns`,
`warnings` and `annotations`. A card includes `metric`, `resourceId`, `unit`,
`aggregation`, `timezone`, `methodology`, `value`, `latestValue`, `latestPeriod`,
`coverage`, `points` and `comparison`. Non-additive statistics have `value:null`
and may have a latest source bucket. Unavailable is not zero.

The exact same structures are returned by CLI `--json`, so Spatial or another
agent can consume them without screen scraping. There is no dedicated MCP
server yet: use this authenticated API, or invoke a local CLI with a bounded
report command. A future MCP adapter must remain read-only by default.
