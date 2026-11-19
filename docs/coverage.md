# Portfolio configuration coverage

Lifecycle: current

`pulse coverage --input /private/inventory.json --config /private/pulse.config.json`
compares an explicit OSS and website-source inventory with the selected installation. It is offline:
no database, credentials, provider requests, configuration changes or schedules.

```json
{
  "version": 1,
  "asOf": "2026-11-16",
  "resources": [
    { "provider": "github", "repository": "example/library" },
    { "provider": "npm", "package": "@example/library" },
    { "provider": "cloudflare", "hostname": "example.org" },
    { "provider": "gsc", "siteUrl": "https://example.org/" }
  ]
}
```

GitHub defaults to all six supported groups; supply `groups` to deliberately
check a smaller scope. A metadata-only repository cannot satisfy traffic
coverage. An npm package is a separate resource from its source repository.
Cloudflare inventories match a configured **exact hostname**, not a beacon
token or guessed account ID. By default the audit requires totals, pages,
referrers, Web Vitals and performance groups; specify \`groups\` to limit the
requirement. A shared GitHub Pages host alone does not prove that each
project path is attributed. To check one documentation project, specify
\`projectId\` and \`pathPrefix\` on a Cloudflare inventory entry, for example
\`{ "provider": "cloudflare", "hostname": "ponchia.github.io", "projectId":
"bronto-ui", "pathPrefix": "/bronto-ui/", "groups": ["pages"] }\`. A matching
resource must be bound to that project with the exact path scope. This checks
configuration only, not whether traffic was actually measured; project-scoped
pageviews do not become property-level visitor totals.

Search Console inventories match an **exact property identity**:
\`https://example.org/\` and \`sc-domain:example.org\` are deliberately distinct,
even if both relate to the same website. By default the audit requires
\`totals\`, \`pages\` and \`queries\`; \`collectQueries: false\` is reported as
partial coverage rather than evidence of zero search interest.

The optional \`asOf\` ISO calendar date checks whether an active resource is
bound to a project on that date. Without it, historical and future bindings
count as configured; no historical observations are inferred. Use this when
auditing domain migrations such as an old hostname and a new canonical one.

Disabled or unbound resources are reported separately from missing resources.
Repository and hostname matching are case-insensitive; package and Search Console property matching are exact. Duplicate
identities and unsupported input fields are rejected. Inventories are bounded
to 500 resources and CLI input to a bounded 256 KiB read. Keep real inventories
private. Output is JSON on stdout; unsupported `--out` is explicitly rejected
before reading configuration or printing identities.

Exit 0 means every requested identity/group has an enabled, project-bound
configuration. Exit 2 means configuration gaps; invalid input exits 1.
**Configured does not mean collected, indexed, discoverable or healthy.** Use `pulse probe` to verify
actual account access and `pulse doctor` to inspect current observations. This
check does not interpret binding dates as historical coverage or prove that a
package has independent users.

Before expanding a Worker portfolio, verify website ownership and property IDs as well as package identities and first
publication dates, preserve existing mappings, and preview `pulse plan` with a
bounded window. More groups lengthen a one-job-per-trigger rotation. Keep the
existing Free-profile request/observation limits; do not raise quotas, copy a
broad CLI token, or enable new grants to make this check pass. Collection and
production publication need their own operator authorization and evidence.

## Stored collection evidence

`pulse coverage-report --input /private/inventory.json --db /private/pulse.db --json`
uses the same intended inventory and reads the configuration already registered in
an existing database. It opens SQLite read-only: it cannot create a database,
migrate it, change configuration or contact a provider. An explicit `--config`
file must match the registered configuration. Omit it to use that stored mapping.
Use `--remote-d1` instead of `--db` for the hosted operator connection described in
[operations](operations.md); this uses the administrative D1 API for stored reads
and does not call a collection provider.

The denominator includes every intended identity/group, including missing,
disabled, unbound, unconfigured and never-published datasets. Each matching
resource retains its own last attempt, last successful publication, collection
recency, latest observed source date and source-data lag. A success from one
resource cannot conceal an access failure from another. A successful empty
publication remains distinct from an observed zero. Permission evidence records
a past success or the latest stored access error; it does not verify current
provider access. Reads may straddle a concurrent publication, and a recent source
date does not establish complete historical coverage.

Output is bounded JSON. Exit 0 means the intended configuration is complete;
exit 2 means configuration gaps, and exit 1 means invalid input or failed reads.
Collection freshness and source lag remain separate reported fields rather than
being collapsed into that configuration exit code. Keep inventories and reports
private.
