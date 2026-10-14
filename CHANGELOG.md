# Changelog

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
