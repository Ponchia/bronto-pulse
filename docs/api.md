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

Additional authenticated endpoints:

| Route                                            | Result                                                        |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `GET /api/v1/brief?from=...&to=...`              | Deterministic portfolio briefings                             |
| `GET /api/v1/projects/:id/brief?from=...&to=...` | One project briefing with evidence                            |
| `GET /api/v1/plan?from=...&to=...`               | Offline date plan, capped at 64 jobs; never invokes providers |

Project reports accept `format=json`, `format=markdown` or `format=csv`.
Brief endpoints accept JSON or Markdown. Downloads carry `no-store`, attachment
filenames and the same authentication boundary. Invalid formats fail rather than
silently producing another representation. HEAD requests authenticate normally
and return headers without a body. Streaming login bodies are bounded to 8 KiB.

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

Health includes `observedThrough`, `dataLagDays`, `dataState` and `nextAction`.
A recent successful request does not guarantee recent observed dates. Daily
sources older than the publication-lag heuristic are `lagging`; an unfinished
run older than one hour is `interrupted`, not perpetually `running`. These are
operator attention signals, not proof that missing buckets should have been zero.
Empty successful results have `dataState: no_observations`. A skipped run with no
previous success is never labeled healthy. Histories are indexed per group so a
busy resource cannot crowd another resource out of the health report.

CLI/API report defaults use the same completed UTC date range. Each card also
exposes `scope`, `latestCollectedAt`, `comparison.kind` and
`comparison.baselinePeriod`. `net_change` refers to snapshots; `period_change`
refers to compatible complete source periods. See [reporting](reporting.md).

Native form POSTs can carry `Origin: null` under the retained `no-referrer`
policy. Login/logout accept that special case only with the browser-managed
`Sec-Fetch-Site: same-origin`; cross-site, sibling-site and conflicting explicit
origins are rejected. Fetch Metadata never substitutes for the login token or
signed session. Non-browser clients without either header retain their existing
explicit-token behavior. This follows the
[Fetch Origin-header algorithm](https://fetch.spec.whatwg.org/#origin-header)
and [Fetch Metadata header semantics](https://www.w3.org/TR/fetch-metadata/).
