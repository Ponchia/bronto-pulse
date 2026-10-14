# First run and private installation

Lifecycle: current

## Explore without connecting an account

Use Node.js 24.15 or newer; Node 24 is the tested line. From a repository checkout:

```sh
npm ci
npm run check
npm run demo -- --serve
```

The process binds to `127.0.0.1:4177`, prints a temporary reporting token and
seeds **synthetic** data in `.pulse/demo.db`. Open the printed address and use
the token to sign in. No provider requests are made. A local server on a remote
devbox is not automatically exposed to your laptop or the Internet; use your
existing authorized SSH forwarding to reach its loopback port.

The portfolio, briefing, collection plan, project reports and collection-health
views all use the same contracts as the CLI. Date/project/view selections remain
in the URL, not in browser storage. Tokens are never put in the URL. JSON,
Markdown and CSV reports stay private and are not website publication features.

## Configure a real installation

Keep demo and live databases separate:

```sh
node dist/cli.js init
# Edit the ignored pulse.config.json with your verified resource identifiers.
# Copy .env.example to .env and supply only the credentials you need.
node dist/cli.js validate --json
node dist/cli.js plan --json
node --env-file=.env dist/cli.js probe --provider github --json
node --env-file=.env dist/cli.js sync --provider github
node --env-file=.env dist/cli.js doctor --json
```

`init` refuses to overwrite an existing configuration. `validate` and `plan`
never open a database or call a provider. `probe` calls only the selected provider
read APIs and also does not create or modify a database. It reports each selected
group separately: repository metadata access is not proof of traffic access.

An API failure is not a zero. The default example includes separate Pulse and
TypeScript projects to demonstrate GitHub and npm without implying that the
TypeScript package belongs to Pulse. Replace it before interpreting your own
portfolio. See [provider setup](providers.md) and [configuration](configuration.md).

## Read a report

Replace `PROJECT` with a project identifier from your configuration:

```sh
node dist/cli.js report PROJECT --days 30
node dist/cli.js brief PROJECT --days 30
node dist/cli.js brief --json
node dist/cli.js report PROJECT --format csv --out reports/project.csv
node dist/cli.js brief PROJECT --format markdown --out reports/project.md
```

Create the destination directory yourself with appropriate permissions. New
output files are mode 0600 where supported; an existing file is never overwritten.
The default reporting interval ends on the last completed **UTC** date. Stored
Search Console dates retain their Pacific-time convention inside that date range.
`--to` anchors `--days`; an explicit `--from` overrides the calculated start.

A report with only a few newly collected days cannot establish a 30-day trend.
The briefing makes that limitation visible instead of manufacturing growth.

## Repair and backfill

Review the offline plan before executing requests:

```sh
node dist/cli.js plan --resource PACKAGE --from 2026-10-01 --to 2026-10-13 --chunk-days 7
node dist/cli.js sync --provider github --dry-run --json
node --env-file=.env dist/cli.js backfill --resource PACKAGE --from 2026-10-01 --to 2026-10-13 --chunk-days 7 --max-jobs 8
```

Replace `PACKAGE` with a resource ID. Backfill executes bounded jobs serially.
Each chunk publishes independently after validation; a failed chunk does not
erase successful chunks. An oversized plan is rejected before provider requests.
Narrow the selection or deliberately increase the budget, at most 1,000 jobs.
Current GitHub snapshots and rolling top-ten summaries cannot be reconstructed
for a past date; plans mark them as **current snapshots**, not historical data.
GitHub traffic outside its rolling window cannot be backfilled at all.

No command here enables a recurring timer, changes account grants or provisions
a Worker. See [deployment](deployment.md) when those operator actions are intended.
