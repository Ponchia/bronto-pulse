# Changelog

## Unreleased

- Batch small-portfolio report reads into one request-scoped SQL snapshot,
  retaining the same coverage semantics and avoiding repeated D1 round trips.

- Add an explicit private D1 backup helper with bounded exports, verified SQLite
  restore, private gzip archives, safe retention and no off-box custody claims.

- Avoid duplicate catalog registration on cold scheduled collection and locale
  collation for fixed-format ISO report dates without changing data boundaries.
- Classify documented GitHub quota HTTP 403 responses as rate limits, avoid
  immediate quota retries and release response streams before long retry waits.

- Collect approved Sense6 daily counters through an explicitly pinned native D1
  binding, using the existing fixed aggregate-only query and row budgets. This
  avoids an account API token for same-account installations.

- Integrate bounded read-only Search Console URL inspection, service-account
  support and offline visibility benchmarks with Free-profile execution and
  owner-verified Access authentication. Require the additive inspection migration
  before starting a Free-profile Worker; no provider grant or model traffic is
  created by the source changes.
- Avoid repeated ICU initialization for UTC report and provider dates; cache a
  bounded set of non-UTC calendar formatters and enumerate date ranges once.

- Add explicit owner-only Cloudflare Access authentication with signed JWT
  verification, issuer/audience/hostname pinning and a bounded cached key set.
- Preserve token authentication by default; Access mode rejects spoofed identity
  headers and never falls back to bearer credentials or initializes private data
  for an unverified identity.

- Add an explicit bounded Free execution profile and ready-only collection rotation.
- Avoid rewriting unchanged catalogs, and publish release annotations in one
  fenced SQL statement rather than one statement per release.
- Keep missing private grants visible while public GitHub datasets refresh.

- Fix native Cloudflare Workers fetch receiver: wrap global fetch in a bare call
  rather than invoking its unbound reference as an HttpClient method. Add a
  runtime regression using a receiver-sensitive fetch implementation.

- Preserve bounded, secret-safe connection failure categories across retries so
  production Worker errors distinguish timeouts, runtime rejections and transport
  disconnections without persisting provider exception messages or URLs.

- Use Workers-compatible manual redirects and reject every provider 3xx response
  without following it, retrying it or exposing upstream URLs and response bodies.
- Reject scheduled invocations after failed collection jobs, while preserving
  successful independent jobs and releasing scheduler leases.
- Exercise the bundled scheduled handler, native Request and D1 inside workerd
  in CI, including failure preservation and a successful recovery collection.

- Authenticate Worker requests before initializing D1; serve login/static assets
  and liveness independently, retaining fail-closed private data access.
- Preserve redacted configuration failures and HEAD/security headers; keep failed
  initialization from clearing a newer cached context.

## Unreleased

### Public source preview

- Public MIT repository with standard GitHub-hosted CI and pinned CodeQL analysis.
- Clear separation between public source, unpublished npm distribution and private deployments.
- Publication checks for tracked private artifacts, deployment defaults and secret-free workflows.
- Anonymous cloning, contributor guidance, private vulnerability reporting and public-release documentation.
- GitHub no-reply author metadata before publication; code history preserved.

### Added

- Deterministic project/portfolio briefings with traceable evidence and explicit omissions.
- Offline collection planning, dry-run sync and bounded date-chunk backfill.
- Private CSV and Markdown downloads, exclusive CLI output and formula-safe CSV text.
- Browser briefing/plan views, persistent view URLs, actionable health and stale-export protection.
- Clean-consumer package smoke checks, generated-schema consistency and repository quality gates.
- Configuration, reporting, quickstart and maintainer release guides; issue forms, CODEOWNERS and dependency-update configuration.

### Corrected

- Separate configured reporting secrets from generated local startup tokens; explicit tokens never enter the display path.
- Replace trailing-slash regexes with linear scanning, including direct library callers outside configuration size limits.

- Offline package verification now uses locked runtime tarballs rather than relying on a warmed registry metadata cache.

- Snapshot net-change baselines and suppression of misleading partial/estimated comparisons.
- Consistent completed-date defaults, effective-date boundary handling and weighted observation checks.
- Per-group capability probes, observed-data lag, interrupted-run health and historical run lookup.
- Lease release after run-creation failure and independently scoped rotation cursors.
- Bounded streaming login bodies, proper HEAD responses and isolated fork/public CI routing.

## 0.1.0 — initial implementation

- Portable project/resource config and effective path scopes.
- GitHub, npm, Cloudflare RUM, Google Search Console and Sense6 aggregate adapters.
- Fenced staged publication, coverage and safe failure states on SQLite/D1.
- Authenticated read-only API, CLI, private report export/import and demo UI.
- Metric arithmetic, privacy boundaries, provider contracts and browser checks.

This is the first implementation, not a claim of completed long-term production
validation or automatic credential/deployment provisioning.
