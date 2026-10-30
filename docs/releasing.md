# Maintainer release and repository operations

Lifecycle: current

## Current release boundary

The GitHub repository is public and MIT-licensed as a **source preview**. Public
source, npm distribution and a hosted analytics deployment are three independent
decisions. The maintainer decided npm distribution on 30 October 2026: betas only,
as `@ponchia/pulse` under the `beta` dist-tag, through the reviewed release
workflow below. `latest` is never moved by automation.

Collected analytics, credentials, backup archives and local deployment settings
are never public release material. The checked-in Worker configuration disables
public preview URLs and cron triggers. There is no website or collector-deployment
workflow.

## Review gates

From a fresh checkout with the locked dependencies:

```sh
npm ci
npm run check
npm run test:d1
npm run test:worker
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

Dependency Review checks every pull request for newly introduced high- and
critical-severity advisories, including development dependencies. CodeQL analyzes
source and workflow definitions on changes and weekly, so an idle repository is
also checked against updated queries. These security checks do not execute
project installation hooks or grant access to a live installation.

Fork contributions use `pull_request`, never elevated `pull_request_target`.
CI uses synthetic fixtures only and cannot read or synchronize a live installation.
There are no recurring collection workflows. The release workflow's one artifact
is the checked package archive handed to its publish job. Dependency
caching uses the normal bounded GitHub cache; do not opt into paid cache capacity
or larger runners without an explicit maintainer decision.

Standard hosted-runner execution is free for public repositories; larger runners
and separate storage products have different billing rules. See
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Old private-repository jobs that never started are historical failures, not evidence
of either a source defect or a passing check. Do not bypass a required check.

## npm beta releases

A tag `v<version>-beta.<n>` on reviewed main, matching `package.json`, starts
`release.yml`:

1. `verify` reruns the complete CI unchanged, including its read-only audit of
   the source-locked npm publisher (which also runs on every push and pull request).
2. `preflight` refuses an unbootstrapped package or an existing version, builds
   with lifecycle scripts disabled, runs `package:check` and `publication:check`,
   packs one archive, checks its identity and contents, and records its SHA-256.
3. `publish-npm` runs in the protected `npm-publish` environment. It checks out
   only the publisher files, prepares and audits them again, verifies the archive
   hash and identity, and publishes those bytes with npm OIDC and provenance.
4. `verify-registry` (read-only) compares the registry's integrity and downloaded
   bytes with the archive and checks the `beta` tag and provenance. Rerun only
   that job after propagation delays; never publish a version twice.

The publisher is the one Bronto UI, Annotations, Layout and Visual Models use:
the unchanged npm 11.21.1 source pinned in `tooling/publisher/source.json`, its
dependencies from `tooling/publisher/package-lock.json` (overriding only `undici`
and `ip-address`), and a complete audit. Registry npm 11.21.1 and 12.2.1 bundle
Undici 6.29.0 with a high-severity advisory
([Bronto UI issue 234](https://github.com/Ponchia/bronto-ui/issues/234)), so the
runner's npm never publishes. `npm run publisher:readiness` runs the same
preparation locally and packs this package with it.

Before a release: update `package.json`, the lockfile and the changelog together,
review the exact package contents, and keep live-account validation (issue #1)
separate from package publication.

### npm prerequisites (maintainer actions)

1. Create the `npm-publish` GitHub environment with required reviewers and a
   deployment policy limited to `v*-beta.*` tags.
2. Bootstrap the first version (below). npm only trusts OIDC for an existing package.
3. Configure the trusted publisher with normal interactive account authentication:

| Setting           | Value          |
| ----------------- | -------------- |
| Provider          | GitHub Actions |
| Organization/user | `Ponchia`      |
| Repository        | `bronto-pulse` |
| Workflow          | `release.yml`  |
| Environment       | `npm-publish`  |

### First npm publication

Done on 30 October 2026: the maintainer bootstrapped 0.2.0-beta.0 this way, and
npm also pointed `latest` at it because a new package needs one. Release
automation never moves `latest`. Every later version uses the tag workflow
above. The procedure stays here for a fork or a newly scoped package.

Pack the first beta from reviewed main after `npm ci && npm run check`, then
publish that exact archive with the source-locked publisher, never a locally
installed npm. Keep its login in a throwaway config:

```sh
npm pack --ignore-scripts --pack-destination "$PWD/.release"
VERSION=0.2.0-beta.0
TARBALL="$PWD/.release/ponchia-pulse-$VERSION.tgz"
sha256sum "$TARBALL"
PUBLISHER="$(mktemp -d)"
node scripts/source-publisher.mjs prepare "$PUBLISHER/npm"
node scripts/source-publisher.mjs audit "$PUBLISHER/npm" "$PUBLISHER/audit.json"
NPM_CLI="$PUBLISHER/npm/source/bin/npm-cli.js"
export npm_config_userconfig="$PUBLISHER/npmrc"
node "$NPM_CLI" login --auth-type=web --registry=https://registry.npmjs.org
node "$NPM_CLI" whoami --registry=https://registry.npmjs.org
node "$NPM_CLI" publish "$TARBALL" --ignore-scripts --access public --tag beta \
  --provenance=false --registry=https://registry.npmjs.org
node "$NPM_CLI" logout --registry=https://registry.npmjs.org
rm -rf "$PUBLISHER"
```

Complete browser and 2FA challenges interactively; never paste a password or token
into an issue, transcript or repository. A local bootstrap has no hosted
provenance; do not claim it does. Verify the public archive's SHA-256 matches
before announcing it.

Do not describe a dry-run bundle or fixture-tested connector as an operational
production installation. Security reports must follow [SECURITY.md](../SECURITY.md)
and must never include real credentials in an issue template.

An external contributor can reproduce source checks using Node, npm and the
locked browser; maintainer-only workspace tools are optional.

Primary guidance: [GitHub Actions security](https://docs.github.com/en/actions/reference/security/secure-use).
