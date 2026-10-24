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
   an ignored `wrangler.private.jsonc` copied from `wrangler.jsonc`. The checked-in
   database ID is a placeholder. Pass `--config wrangler.private.jsonc` to Wrangler.
2. Apply `migrations/` to the selected database; use local D1 first.
3. Store `PULSE_CONFIG` as the JSON configuration and `PULSE_API_TOKEN` as a
   strong random secret. Add only the provider secrets actually referenced by
   your connections. Never place them in `vars` or source control.
4. Run `npm run worker:check`. Configure a custom private hostname and, ideally,
   an additional Cloudflare Access policy before enabling a route. The checked-in
   config disables workers.dev and preview URLs.
5. Deploy explicitly after verifying the private route. Cron triggers are disabled
   in the checked-in example. Enable a schedule only in your ignored configuration
   after checking dataset access and recovery. The handler processes up to eight
   independent jobs per invocation using a rotation cursor; `PULSE_MAX_JOBS` can
   bound it between 1 and 32.
   For staged activation, set `PULSE_PROVIDER` to exactly one of `github`, `npm`,
   `cloudflare`, `gsc` or `sense6`. For example, `npm` collects only configured npm
   packages while other credentials are awaiting authorization. Unset it to rotate
   through all configured providers. Invalid values fail before database work;
   filtering never marks uncollected providers as healthy.
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

Public-source CI always uses standard GitHub-hosted `ubuntu-24.04` runners.
No self-hosted runner or repository variable is consulted. Fork pull requests
run with read-only validation permissions and synthetic data, never maintainer
provider credentials. CodeQL publishes only source-analysis findings.

GitHub Actions in this repository validates code; it is not the deployment or
collector scheduler. Do not put private analytics backups into public CI artifacts.

For cron/systemd, invoke a one-shot `pulse sync --max-jobs 8 --rotate` with a
persistent database and secret environment. No timer is enabled automatically.
GitHub scheduled workflows can be delayed or disabled for inactivity; monitor
`pulse doctor` and do not rely on ephemeral Actions artifacts as durable history.

## Cold-start and authentication boundary

The Worker authenticates reporting requests before opening D1 or parsing private
provider configuration. The login page, its fixed static assets, rejected requests
and `/health` liveness endpoint do not initialize storage. A missing or short API
token keeps private routes locked even when database configuration is incomplete.
Successful login proves token ownership, not provider access or database readiness.

Authorized data routes initialize the private store lazily; unavailable storage or
invalid configuration returns a redacted HTTP 503 with private-cache and security
headers. `/health` is deliberately only process liveness, not a D1 readiness test.
Use an authenticated reporting request for that check. Fixture tests establish
these boundaries; no reduction in live-account billed usage is claimed.

## Explicit Free-tier execution profile

Set `PULSE_EXECUTION_PROFILE=free` and `PULSE_MAX_JOBS=1` after applying D1
migrations. This mode checks the schema version instead of rerunning schema DDL
on every cold start. It caps a collection at eight provider requests (including
retries), 256 KiB per response and 250 observations. Incomplete or over-budget
results cannot replace published history. These are engineering bounds, not a
promise that arbitrary providers fit Cloudflare's CPU budget: measure real
invocation CPU and D1 usage before expanding collection. Never upgrade a plan
implicitly to make a failing collector pass.

`PULSE_READY_ONLY=true` rotates only jobs whose grants are configured. Public
GitHub repository snapshots and release metadata may run anonymously without
copying an operator's broad CLI token into Cloudflare. Traffic remains explicitly
`credentials_missing` in health, and an invalid configured grant is not silently
replaced with anonymous access. The mode has its own rotation cursor. No ready
jobs means no refresh, not evidence of a healthy installation.

An installation can use one job every 15 minutes (96 invocations/day), provided
its total job count gives every source sufficient refresh frequency. The provider
selection must be deliberately removed to move beyond an npm-only activation.
Keep invocation logging enabled while validating CPU and outcomes; aggregate
collector logs contain no provider URLs, payloads or credentials. Query limits
and the account-wide Free allowances still apply.

## Owner-only Cloudflare Access login

Bearer-token login remains the default. A private Worker may explicitly opt into
Cloudflare Access instead, without deploying a second dashboard password. Attach
an owner-only Access policy to **all traffic** before enabling a route. Then set
`PULSE_AUTH_MODE=access`, `PULSE_ACCESS_TEAM` (the exact team hostname ending in
`.cloudflareaccess.com`), `PULSE_ACCESS_AUD` (this application's AUD tag),
`PULSE_ACCESS_HOSTNAME` (one exact HTTPS dashboard hostname), and
`PULSE_ACCESS_EMAILS` (a small comma-separated owner allowlist). These are public
identity-validation settings, not bearer credentials.

Pulse uses `jose` to verify the signed `Cf-Access-Jwt-Assertion` on every protected
request: RS256 signature, pinned issuer and audience, expiry, issued-at time,
application-token type, owner email and exact request hostname. Public signing
keys are fetched only from the pinned team certificate endpoint, without following
redirects, with a bounded response and a cached key set. Unverifiable identities
fail closed before private storage is opened. Plain forwarded email headers do not
authenticate, and bearer tokens cannot bypass a configured Access mode.

Token-login routes redirect verified Access users to the dashboard. Logout uses
Access's logout endpoint and retains same-origin CSRF checks. A missing setting or
key-service failure never switches to anonymous or bearer access. Keep the default
`workers_dev=false` until the complete protection is tested. Access account limits
and the Workers Free CPU limits still require installation validation.

Reference: [Cloudflare's JWT validation contract](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

### Additive search-monitoring migration

Before deploying a Free-profile Worker with URL-inspection reporting, apply
`migrations/0002_url_inspections.sql` to the intended D1 database after taking a
backup. The initial migration is unchanged. The Free profile verifies that both
the supported base schema and the additive inspection table exist before any
collection or private reporting initialization. Merging source does not grant
Search Console access or start inspections; the inspection CLI still requires an
explicit bounded URL list and a read-only provider credential.
