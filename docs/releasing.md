# Maintainer release and repository operations

Lifecycle: current

## Current release boundary

The GitHub repository is public and MIT-licensed as a **source preview**. The
npm package remains unpublished and `private: true` deliberately prevents
accidental registry publication. Public source, npm distribution and a hosted
analytics deployment are three independent decisions.

Collected analytics, credentials, backup archives and local deployment settings
are never public release material. The checked-in Worker configuration disables
public preview URLs and cron triggers. There is no automatic npm, website or
collector-deployment workflow.

## Review gates

From a fresh checkout with the locked dependencies:

```sh
npm ci
npm run check
npm run test:d1
npm run worker:check
npm run test:browser
npm audit
```

`check` covers formatting, strict TypeScript, unit/CLI/API regressions, documentation,
compilation, generated schema consistency, installed-package verification and
repository policy. `package:check` packs a tarball into temporary storage,
rejects unexpected/private entries, installs it in a clean **offline** consumer
and exercises imports plus CLI initialization. It removes its temporary files.
No registry write occurs. A generated consumer lockfile reuses the runtime
tarball URLs and integrity hashes from the repository lock. `npm ci --offline`
therefore needs only tarballs already fetched by the main install, not a previously
warmed registry-metadata cache.

D1 tests exercise an actual local D1-compatible runtime rather than just a mock.
Browser tests use only synthetic data and cover narrow widths, downloads,
read-only planning, refresh failure, login and storage boundaries.

## CI trust

All CI and CodeQL jobs use the standard GitHub-hosted `ubuntu-24.04` label.
There is no repository-variable or self-hosted fallback. Actions are pinned to
immutable commits; checkout credentials are not retained. Validation has
`contents: read` only. CodeQL has the additional `security-events: write` permission
needed to publish its analysis, but receives no provider secrets.

Fork contributions use `pull_request`, never elevated `pull_request_target`.
CI uses synthetic fixtures only and cannot read or synchronize a live installation.
There are no recurring collection workflows or artifact-upload steps. Dependency
caching uses the normal bounded GitHub cache; do not opt into paid cache capacity
or larger runners without an explicit maintainer decision.

Standard hosted-runner execution is free for public repositories; larger runners
and separate storage products have different billing rules. See
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Old private-repository jobs that never started are historical failures, not evidence
of either a source defect or a passing check. Do not bypass a required check.

## Review before a future package or hosted release

1. Review the public code, license, generated schemas and exact package contents.
2. Resolve live-account and operational validation separately in issue #1.
3. Update the changelog and version together, with documented migration paths.
4. Obtain the maintainer's explicit decision before npm or deployment publication.
5. Remove the npm publication guard only in that reviewed package-release change.
6. Test the exact package bytes in a clean consumer, then verify the published
   artifact independently when registry publication is authorized.

An external contributor can reproduce source checks using Node, npm and the
locked browser; maintainer-only workspace tools are optional.

Do not describe a dry-run bundle or fixture-tested connector as an operational
production installation. Security reports must follow [SECURITY.md](../SECURITY.md)
and must never include real credentials in an issue template.

Primary guidance: [GitHub Actions security](https://docs.github.com/en/actions/reference/security/secure-use).
