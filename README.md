# Bronto Pulse

**Private, portable project analytics. No additional visitor tracker.**

Bronto Pulse keeps a source-aware history of how software and websites are
discovered, distributed and used. A project can reference GitHub repositories,
npm packages, Cloudflare Web Analytics, Search Console and existing Sense6
anonymous counters. Related projects can share a website property without
silently double-counting each other's paths.

The code is MIT-licensed. Collected data and provider credentials are **private**
by default. This initial implementation is not a hosted multi-tenant product.
The repository is private during validation; changing visibility and publishing
the npm package are separate operator decisions.

## Run the complete demo

Requires Node.js 24.15 or newer (24.x recommended). Local storage uses
`node:sqlite`; no native npm database addon or external database is required.

```sh
npm ci
npm run check
npm run demo -- --serve
```

Open the loopback address printed by the CLI and enter its one-session token.
All demo values are **synthetic** and clearly labeled. The demo cannot be
mixed into a live database and does not make provider API requests.

## Start a real private installation

```sh
npm run build
node dist/cli.js init
# Review pulse.config.json. It is ignored by Git.
# Create .env from .env.example and use selected-resource credentials.
node --env-file=.env dist/cli.js validate
node --env-file=.env dist/cli.js probe --json
node --env-file=.env dist/cli.js sync --provider github
node --env-file=.env dist/cli.js sync --provider npm
node --env-file=.env dist/cli.js report pulse --days 30
node --env-file=.env dist/cli.js serve
```

The quickstart deliberately uses a public TypeScript npm series and the Pulse
repository as separate projects, not an invented shared adoption funnel.
[examples/full.json](examples/full.json) demonstrates the complete provider
configuration with placeholder account identifiers. Substitute verified IDs
before collection. Missing permissions become explicit health states, not
zeroes. `probe` is read-only; `sync` saves history.

## Implemented capabilities

| Area           | Behavior                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub         | Daily views/clones, non-additive uniques, top-ten rolling referrers/paths, stars/forks snapshots, release annotations and asset totals                              |
| npm            | Daily scoped or unscoped package downloads, bounded historical chunks, response-window validation                                                                   |
| Cloudflare     | Account RUM totals, page attribution, referrer groups, performance/CWV adapters with sampling and no-sample semantics; capabilities must be tested for your account |
| Search Console | Separate totals/page/query scopes, bounded pagination, Pacific dates, partial-data metadata, weighted CTR/position, OAuth refresh                                   |
| Sense6         | Optional fixed aggregate-only D1 query; no arbitrary SQL, participant or result reads                                                                               |
| Storage        | SQLite and D1 drivers, fenced leases, staged atomic publication, coverage, run history, portable private export/import                                              |
| Interfaces     | CLI, authenticated read-only HTTP API, responsive dashboard, deterministic Markdown/JSON reports                                                                    |
| Deployment     | Local process, container, or bounded scheduled Cloudflare Worker with D1 and private assets                                                                         |

Provider adapters are integration-tested with strict fixtures. Live account
validation is distinct from a passing fixture test. No provider token or Google
consent grant is invented. A configured but inaccessible dataset reports the
failure while preserving previous successful observations.

## What the numbers do not mean

Downloads and clones are not unique people. Daily uniques cannot be summed into
monthly uniques. Rolling referral windows overlap. Daily percentiles cannot be
averaged. Search Console page/query rows are not the same dataset as property
totals. Cloudflare visits are not per-project sessions. Missing data remains
missing, and a successful empty response is not automatically a confirmed zero.

The interface makes these boundaries inspectable through metric definitions,
coverage, collection health and source annotations. It reports correlations,
not reconstructed visitor journeys or causal conversions.

## Commands

Run `node dist/cli.js --help` for the current command surface.

```sh
pulse doctor --json
pulse sync --resource docs --group pages --from 2026-10-01 --to 2026-10-07
pulse compare project-one project-two --days 30 --json
pulse annotate --resource ui-repository --date 2026-10-14 --title 'Documentation release'
pulse export --out /private/backup/pulse.json
pulse import --db /private/restored.db --input /private/backup/pulse.json
```

`pulse` is available after linking/installing the package; from a checkout use
`node dist/cli.js` or `npm run pulse --` instead. Exports contain private metrics
and may include explicitly enabled query text. Never commit them to Git.

## Quality gates

```sh
npm run check          # TypeScript, contract tests, documentation, build
npm run test:browser   # Dashboard flows and 320/390/1440px layout checks
npm run test:d1        # Real local D1-compatible runtime contract (Miniflare)
npm run worker:check   # Cloudflare deployment bundle dry run; no publication
```

The [documentation router](docs/README.md) covers architecture, metric contracts,
provider permissions, private deployment, API usage, operations and limitations.
See [SECURITY.md](SECURITY.md) before exposing an installation.
