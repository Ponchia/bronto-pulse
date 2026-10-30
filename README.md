# Bronto Pulse

**Open-source project analytics. Private history. No additional visitor tracker.**

Bronto Pulse keeps a source-aware history of how software and websites are
discovered, distributed and used. A project can reference GitHub repositories,
npm packages, Cloudflare Web Analytics, Search Console and existing Sense6
anonymous counters. Related projects can share a website property without
silently double-counting each other's paths.

**Status: public source preview.** The code is MIT-licensed; collected analytics,
provider credentials and deployments remain **private** by default. This is not
a hosted service or a production-readiness claim. Betas are published to npm as
[`@ponchia/pulse`](https://www.npmjs.com/package/@ponchia/pulse) under the `beta`
dist-tag ([release process](docs/releasing.md#npm-beta-releases)). See the
[validation matrix](docs/validation.md) for the difference between fixture tests
and live account verification.

## Install

Requires Node.js 24.15 or newer. Install the CLI and library into a project:

```sh
npm install @ponchia/pulse@beta
npx pulse --help
```

Use 0.2.0-beta.1 or later: the `pulse` command in 0.2.0-beta.0 exits without
running. The demo below and the development checks use a source checkout.

## Run the complete demo

Requires Node.js 24.15 or newer (24.x recommended). Local storage uses
`node:sqlite`; no native npm database addon or external database is required.

```sh
git clone https://github.com/Ponchia/bronto-pulse.git
cd bronto-pulse
npm ci
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

## Operator workflow

Preview a bounded sync before making provider requests, then read an evidence-based
briefing or export a source-aware CSV:

```sh
node dist/cli.js plan --provider github --json
node dist/cli.js sync --provider github --dry-run --json
node dist/cli.js brief --days 30
node dist/cli.js report pulse --format csv --out /private/pulse-report.csv
```

`plan` and `validate` never open the database or the network. Backfill supports
explicit date chunks and budgets. Briefings keep coverage problems, limited
measurements and missing baselines visible; snapshot changes are net changes,
not gross new users. No tracker or LLM service is added.

Read the [quickstart](docs/quickstart.md), [configuration guide](docs/configuration.md)
and [reporting contracts](docs/reporting.md) before connecting live sources.

## Implemented capabilities

| Area           | Behavior                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub         | Daily views/clones, non-additive uniques, top-ten rolling referrers/paths, stars/forks snapshots, release annotations and asset totals                              |
| npm            | Daily scoped or unscoped package downloads, bounded historical chunks, response-window validation                                                                   |
| Cloudflare     | Account RUM totals, page attribution, referrer groups, performance/CWV adapters with sampling and no-sample semantics; capabilities must be tested for your account |
| Search Console | Separate totals/page/query scopes, bounded pagination, Pacific dates, partial-data metadata, weighted CTR/position, OAuth refresh                                   |
| Sense6         | Optional fixed aggregate-only D1 query; no arbitrary SQL, participant or result reads                                                                               |
| Storage        | SQLite and D1 drivers, fenced leases, staged atomic publication, coverage, run history, portable private export/import                                              |
| Interfaces     | CLI, authenticated read-only API, dashboard, offline collection plans, evidence briefings and private JSON/Markdown/CSV reports                                     |
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

`pulse` is available after installing the package (`npx pulse` in a project); from
a checkout use `node dist/cli.js` or `npm run pulse --` instead. Exports contain private metrics
and may include explicitly enabled query text. Never commit them to Git.

## Quality gates

```sh
npm run check          # Source/test types, contracts, docs, schema and installed package
npm run test:browser   # Dashboard flows and 320/390/1440px layout checks
npm run test:d1        # Real local D1-compatible runtime contract (Miniflare)
npm run test:worker    # Bundled scheduled handler + native fetch contracts in workerd
npm run worker:check   # Cloudflare deployment bundle dry run; no publication
```

The [documentation router](docs/README.md) covers architecture, metric contracts,
provider permissions, private deployment, API usage, operations and limitations.
See [SECURITY.md](SECURITY.md) before exposing an installation.

## Contributing and security

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [documentation router](docs/README.md).
CI runs on standard GitHub-hosted Ubuntu runners using synthetic fixtures; it
requires no maintainer infrastructure or live provider secrets. Source publication
does not enable recurring collection or publish your local data.

Report vulnerabilities through [private security advisories](https://github.com/Ponchia/bronto-pulse/security/advisories/new),
not a public issue. Ordinary bugs and feature requests use the issue templates.
The project is developed with substantial AI assistance; the maintainer remains
responsible for review, tests and release decisions. See the contributor policy
for how to report limitations and supply reproducible evidence.
