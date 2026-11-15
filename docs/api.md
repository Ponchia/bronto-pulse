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

| Route                                                     | Result                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/v1/brief?from=...&to=...`                       | Deterministic portfolio briefings                                            |
| `GET /api/v1/review?from=...&to=...`                      | Read-only owner agenda across independent projects                           |
| `GET /api/v1/projects/:id/brief?from=...&to=...`          | One project briefing with evidence                                           |
| `GET /api/v1/plan?resource=id&group=name&from=...&to=...` | Offline focused collection plan; 64-job default cap, never invokes providers |

The owner review returns `projects` with one source-backed example per
investigation, supported-change and evidence-qualification lane, and exact
`nextChecks` from the existing investigation contract. `totals` counts
projects, not people, while `omittedLeads` discloses investigation truncation.
There is no new source read, provider call or score. See
[owner review](reporting.md#owner-review-what-deserves-attention).

A briefing also has an `investigation` object with `findings`,
`omittedFindings` and `limitation`. See [investigation leads](investigation-leads.md).

Project reports accept `format=json`, `format=markdown` or `format=csv`.
Brief and owner-review endpoints accept JSON or Markdown. Downloads carry `no-store`, attachment
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

## Investigation and relationship views

The authenticated project report now includes additive `investigation` and
`resources` sections. Original metric cards and observations are unchanged.

- `GET /api/v1/projects/<id>/investigation?from=2026-10-12&to=2026-10-13`
  returns the project, exact requested window, generation time and deterministic
  investigation leads. Optional `limit=1..100` controls the lead count (default 20);
  `omittedFindings` records the remainder. Each lead has source references, interpretation limits
  and bounded next checks. A next check is an instruction to inspect evidence,
  never an automatically executed collector or external request.
- `GET /api/v1/projects/<id>/graph` returns the explicit configuration projection:
  resources, declared websites and effective-dated relationships. It has no date
  filters because the graph retains the declared binding intervals. No ownership,
  deployment or package-to-repository link is inferred. Credentials, connection
  environment names and private provider account identifiers are omitted.

Both support JSON only, retain normal owner authentication and `no-store`, and
expose no collection or configuration mutation. The graph also has an offline
CLI equivalent: `pulse graph PROJECT --config /private/pulse.config.json --json`.
That command reads only the configuration and opens no database or network.
See the [pilot acceptance guide](pilot-acceptance.md) for live qualification;
synthetic fixture success is not account access or a completed pilot.

Next-check buttons from the owner review or project investigation preserve the
stated source and period in a browser deep link. A link to collection health is
filtered locally using the authenticated health result; a link to the collection
plan uses the read-only resource/group API selector; a source-report link keeps
the full report but focuses its metric cards. None of these links executes a
provider request, backfills unavailable history, or requests a new permission.
The browser can clear the selection, reload it, and navigate Back/Forward.

The current access boundary is installation-owner access, not per-project access.
The graph can therefore name other projects explicitly sharing a resource. A future
per-project authorization model must filter those relationships before returning them.

## Query selection is explicit

Authenticated API requests reject unsupported or repeated query parameters with
HTTP 400 before loading private configuration or storage. Authentication is still
checked first. An unrecognized endpoint returns 404; neither case starts a
collector or broadens an access grant.

Date-aware reports, briefs, owner review, portfolio, plans, investigations and source comparisons
accept `from`, `to` or `days`. `days` is a decimal integer from 1 to 366, ends on the
last completed UTC date by default, and may combine with `to`. An explicit `from`
cannot combine with `days`. These are the same report windows used by the CLI;
provider-native calendars remain attached to each metric.

| Endpoint                                              | Additional query parameters                  |
| ----------------------------------------------------- | -------------------------------------------- |
| Project report                                        | `format=json`, `markdown` or `csv`           |
| Portfolio/project brief                               | `format=json` or `markdown`                  |
| Owner review                                          | `format=json` or `markdown`                  |
| Investigation                                         | `limit=1..100`, `format=json`                |
| Collection plan                                       | `resource`, `group`; dates                   |
| Source comparison                                     | `primary`, `secondary`, `same_site`          |
| Configuration graph                                   | `format=json`; no date filters               |
| Runs                                                  | `resource`, `limit=1..1000`; no date filters |
| Projects, connectors, health, metrics, private export | None                                         |

The plan endpoint additionally accepts `resource` and `group`, matching the
already-supported CLI selection. Both are optional validated identifiers.
Unknown or disabled resource selections and unmatched groups return HTTP 400
rather than expanding to all collection jobs. The selected preview is still
read-only: it neither authenticates to a provider nor collects missing history.
The portfolio endpoint continues to accept dates only. In particular,
`/api/v1/export?resource=...` is rejected: the backup endpoint does not implement
partial export. A selector or misspelling must not silently return broader data.
