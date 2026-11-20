# Maintainer release and repository operations

Lifecycle: current

## Current release boundary

The GitHub repository is public and MIT-licensed as a **source preview**. Public
source, npm distribution and a hosted analytics deployment are three independent
decisions. The maintainer decided npm distribution on 30 October 2026: betas only,
as `@ponchia/pulse` under the `beta` dist-tag, through the reviewed release
workflow below. Since 6 November 2026 the workflow also owns the dist-tags,
including `latest` (see [dist-tags](#dist-tags)); nobody moves them by hand.

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

## Container deployment artifacts

`container.yml` is an explicit manual workflow on reviewed `main`. It first
runs the complete reusable CI, then builds the pinned Dockerfile once on a
standard GitHub-hosted runner. The existing synthetic OCI acceptance checks
that exact local image, including authentication, Host/Origin rejection,
Secure login cookies and SQLite persistence after a restart. The workflow then
pushes the same image to `ghcr.io/ponchia/bronto-pulse:sha-<commit>` and pulls
its registry digest back, comparing both image identity and source revision.

The built-in job token receives `packages: write` only in the publication job.
No provider credentials, private configuration, live analytics or cluster
credentials enter the build or smoke test. There is no automatic deployment,
version bump, npm publication or moving `latest` image tag. GitOps deployments
must pin the reported `ghcr.io/ponchia/bronto-pulse@sha256:...` digest; a source
commit tag is a convenience, not an immutable identity.

Start it with `gh workflow run container.yml --ref main` after the reviewed
source has merged. Read its completed run and digest summary before updating
an installation. A successful registry push is a publication even if a later
readback fails: inspect that exact digest rather than publishing again to
recover a verification result. Rebuilding the same source does not prove
byte-identical images.

A first GHCR package defaults to private even when the linked source repository
is public. Check access explicitly and use an already authorized pull identity
or a separately reviewed visibility change. Do not broaden a registry token to
work around a failed pull. Container registry storage and bandwidth are currently
free according to [GitHub Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages);
recheck that policy before changing the distribution approach.

For a locally built image, `PULSE_SMOKE_IMAGE=<local-image> bash scripts/oci-smoke.sh`
runs the same acceptance without rebuilding or deleting the supplied image.
Without that variable, the script retains its disposable build-and-cleanup flow.
Only synthetic data is used in either mode.

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
5. `sync-dist-tags` runs in the `npm-publish` environment after its own
   approval and applies the [dist-tag policy](#dist-tags). It never publishes.

The publisher is the one Bronto UI, Annotations, Layout and Visual Models use:
the unchanged npm 11.21.1 source pinned in `tooling/publisher/source.json`, its
dependencies from `tooling/publisher/package-lock.json` (with pinned `undici`
and `ip-address` fixes, plus reviewed `glob` 14.0.2 and `minimatch` 11.0.1
security replacements for unchanged upstream direct dependencies), and a
complete audit. `source.json` binds each major replacement to its original
source range, patched exact version and GHSA. Complete installed-graph and
source-file integrity checks remain mandatory. Registry npm 11.21.1 and 12.2.1 bundle
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

| Setting           | Value                                 |
| ----------------- | ------------------------------------- |
| Provider          | GitHub Actions                        |
| Organization/user | `Ponchia`                             |
| Repository        | `bronto-pulse`                        |
| Workflow          | `release.yml`                         |
| Environment       | `npm-publish`                         |
| Allowed actions   | Allow npm publish, Allow npm dist-tag |

### Dist-tags

The maintainer decided on 6 November 2026 that the release workflow owns the
dist-tags. After `verify-registry`, the `sync-dist-tags` job runs
`scripts/sync-dist-tags.mjs` with the same audited publisher, authenticated by
the trusted publisher's **Allow npm dist-tag** permission. It applies one policy:

- While the package has no stable version, `latest` follows the newest beta, so
  `npm install @ponchia/pulse` receives it.
- `latest` never moves backwards, and never to a prerelease once a stable
  version exists.
- A prerelease channel tag (`next`, `beta`, `rc`, `alpha`, `canary`) that points
  below `latest` is removed. Other tags are never touched.

The job refuses a registry read that does not yet include the released version
and confirms the resulting tags before it succeeds. Rerun it alone to reapply the
policy; with nothing to change it is a no-op. `--dry-run` prints the plan without
changing anything.

### Recovering a previously published version

A successful immutable package upload, registry verification, and channel
reconciliation are separate outcomes. Inspect the **actual jobs in that release
run** before retrying. A rerun uses the workflow from its original commit;
changes later merged to `main` do not add jobs to a historical run.

As of **15 November 2026**, the registry reports `beta: 0.2.0-beta.3` and
`latest: 0.2.0-beta.1`. The tagged [beta.3 release run](https://github.com/Ponchia/bronto-pulse/actions/runs/43713340556)
passed `verify`, `preflight`, `publish-npm` and `verify-registry`,
including the immutable package bytes, integrity and provenance. Both protected
GitHub `npm-publish` environment approvals were accepted.

The final `sync-dist-tags` job failed with an npm `E403` that specifically
denied dist-tag management to the trusted publisher. This is not a failed or
missing package release. npm requires the package maintainer to enable
**Allow npm dist-tag** for the exact `Ponchia / bronto-pulse / release.yml /
npm-publish` trusted publisher under the package's npmjs.com **Settings →
Trusted publishing**. The configuration change needs the maintainer's
authenticated npm account and 2FA when prompted; a GitHub environment approval
cannot grant npm account permissions. See npm's
[trusted publisher guidance](https://docs.npmjs.com/trusted-publishers/#managing-dist-tags-with-trusted-publishing).

Only **after** npm reports that permission enabled, review the current registry
tags and use GitHub's **Re-run failed jobs** on the
[original beta.3 run](https://github.com/Ponchia/bronto-pulse/actions/runs/43713340556)
(or `gh run rerun 43713340556 --failed`). Honor its protected environment
review again if prompted. Confirm the resulting `latest` and `beta` aliases
from the registry, then close [issue #71](https://github.com/Ponchia/bronto-pulse/issues/71).
Do not rerun `publish-npm`, reuse an immutable version, replace the publisher
with a long-lived token or bypass npm's account-level 2FA check.

The [beta.2 release run](https://github.com/Ponchia/bronto-pulse/actions/runs/42036737324)
predated `sync-dist-tags` and has no channel job to rerun. Its completed,
immutable publication is unchanged by this recovery.

Before any approved change, use `scripts/sync-dist-tags.mjs --dry-run` with the
audited source-locked publisher and an already published `--version` to review
its exact add/remove plan. Afterward, verify registry aliases and unchanged
package integrity separately. A plan or passing fixture test is not a successful
registry mutation.

### First npm publication

Done on 30 October 2026: the maintainer bootstrapped 0.2.0-beta.0 this way, and
npm also pointed `latest` at it because a new package needs one. Every later version uses the tag workflow
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
