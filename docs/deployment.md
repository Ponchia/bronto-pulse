# Private deployment

Lifecycle: current

## Local CLI and dashboard

Install locked dependencies with Node 24.15+ and run `npm run build`. Copy an
example configuration to ignored `pulse.config.json`. Use Node's explicit
`--env-file=.env` flag or a secret manager to supply named environment values.
The CLI does not search or scrape other applications for credentials.

The dashboard requires a strong `PULSE_API_TOKEN`. Without one, local `serve`
generates an ephemeral token and prints it once. It binds only to loopback and
rejects Host headers outside loopback. Tunnel or reverse-proxy publication is
an explicit operator step. Provider credentials remain server-side.

The included Dockerfile exposes port 4177 inside the container but the local
server still binds loopback by design. Prefer an authenticated Worker for
remote access or run the container with a deliberate local network strategy.
Do not change the bind address to public without an appropriate proxy/security
review. The image also supports one-shot `sync`, `report`, `export` and `doctor`.

## Cloudflare Workers and D1

This repository contains runnable Worker source, D1-compatible migrations,
static assets and a bounded cron handler. It does not create billable resources
or publish your installation automatically.

1. Create a private D1 database using your own Cloudflare account. Put its ID in
   a local copy of `wrangler.jsonc`. The all-zero ID is a placeholder.
2. Apply `migrations/` to the selected database; use local D1 first.
3. Store `PULSE_CONFIG` as the JSON configuration and `PULSE_API_TOKEN` as a
   strong random secret. Add only the provider secrets actually referenced by
   your connections. Never place them in `vars` or source control.
4. Run `npm run worker:check`. Configure a custom private hostname and, ideally,
   an additional Cloudflare Access policy before enabling a route. The checked-in
   config disables workers.dev and preview URLs.
5. Deploy explicitly. The hourly trigger processes eight independent jobs with
   a persistent rotation cursor; `PULSE_MAX_JOBS` can bound it between 1 and 32.
6. Verify authenticated API access, failure isolation, actual dataset access,
   request/CPU usage and D1 storage. Back up and restore into a second installation.

The Worker authenticates requests itself even if Access sits in front of it.
It never trusts a plain `CF-Access-Authenticated-User-Email` header as proof of
identity. Static assets use `run_worker_first` so they cannot bypass auth.
No reporting endpoint can initiate collection or run arbitrary SQL.

## Costs and scale

Do not assume all work fits the Workers Free CPU budget. JSON parsing and SQL
publication consume CPU even while network waits do not. Start with bounded
queries and measure usage. A paid Worker may be appropriate; no paid plan is
activated by this repository. Detailed path/query cardinality can dominate D1
storage. Keep query collection opt-in and use narrow catch-up windows when an
API returns too many groups.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/).

## GitHub Actions and system schedulers

CI uses GitHub-hosted runners by default. A private repository may be blocked
by the account's hosted-minute/spend limits; a passing local gate is not a
passing hosted run. The workflow supports an explicit `PULSE_RUNNER` repository
variable for a trusted runner. Only private same-repository jobs may use that runner setting; public repositories
and fork pull requests are routed to isolated hosted runners, not silently skipped.
Never run untrusted fork code with self-hosted secrets. Do not set this variable casually on a public repository.

For cron/systemd, invoke a one-shot `pulse sync --max-jobs 8 --rotate` with a
persistent database and secret environment. No timer is enabled automatically.
GitHub scheduled workflows can be delayed or disabled for inactivity; monitor
`pulse doctor` and do not rely on ephemeral Actions artifacts as durable history.
