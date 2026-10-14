# Maintainer release and repository operations

Lifecycle: current

## Current release boundary

The repository and package are private during validation. `private: true` in
`package.json`, the repository privacy contract and disabled public Worker URLs
are deliberate safeguards. MIT licensing is not a claim that private collected
analytics are public. There is no automated npm or website publication workflow.

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
No registry write occurs. The npm cache populated by `npm ci` supplies dependencies.

D1 tests exercise an actual local D1-compatible runtime rather than just a mock.
Browser tests use only synthetic data and cover narrow widths, downloads,
read-only planning, refresh failure, login and storage boundaries.

## CI trust

Actions are pinned to immutable commits and checkout credentials are not retained.
The optional `PULSE_RUNNER` variable is considered only for private, same-repository
code. Fork pull requests and any future public repository use isolated hosted
runners rather than silently skipping validation. Never use elevated
`pull_request_target` execution for untrusted code.

A billing-blocked hosted job is **not** a failed source test and is **not** a
successful check. Record the blocked run separately from local evidence. Selecting
a trusted runner or changing billing is an explicit operator action; do not
weaken merge requirements or fabricate a successful check to get past a block.

## Preparing a future public release

1. Resolve issue #1's live-account, scheduler, recovery and CI activation evidence.
2. Review package contents, documentation, private data boundaries and license.
3. Review the changelog and version together; retain documented migration paths.
4. Obtain the maintainer's explicit decision on repository and package publication.
5. Change the private safeguards only as part of that reviewed release change.
6. Test the exact package bytes in a clean consumer, then verify the published
   artifact independently when publication is eventually authorized.

Do not describe a dry-run bundle or fixture-tested connector as an operational
production installation. Security reports must follow [SECURITY.md](../SECURITY.md)
and must never include real credentials in an issue template.

Primary guidance: [GitHub Actions security](https://docs.github.com/en/actions/reference/security/secure-use).
