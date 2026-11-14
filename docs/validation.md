# Validation and evidence levels

Lifecycle: current

There are three distinct claims:

1. **Contract tested:** synthetic provider payloads, storage transitions and
   calculations pass the repository tests.
2. **Account probed:** a credentialed read-only request to the actual provider
   succeeds for a specific account, resource, dataset, scope and time window.
3. **Operationally verified:** repeated scheduled collections survive failures,
   corrections and recovery and match the provider for comparable periods.

Do not upgrade a claim just because a dashboard renders. `npm run check`
proves compilation, source contracts and fixtures; `pulse probe` tests configured
account access. One live collection is not a long-running reliability proof.

Tests cover denied permission, malformed JSON, truncated pagination, invalid
resource IDs, corrections that decrease metrics, disappearing dimensions,
zero versus missing data, lease loss, transactional rollback, shared path
boundaries, weighted calculations, non-additive unique counts, private exports,
session signing, CSRF/host restrictions and browser storage boundaries.

Browser tests cover login, portfolio, project drill-down, collection health,
metric definitions and narrow-screen overflow. The UI includes no external
scripts, fonts, telemetry or provider requests. Screenshots are disposable
review artifacts and are excluded from the repository.

The opt-in `npm run test:compose:tls` acceptance test runs a synthetic
rootless Podman Compose dashboard through a temporary Caddy HTTPS reverse
proxy. It validates certificate trust, signed owner access, Host/Origin
checks and persistent SQLite data across a Compose stop/start. This does
not verify public DNS/ACME, real provider credentials, production
operations, HA or long-term scheduler reliability.

Real account tokens and retrieved private metrics must live outside tracked
files. A credential failure is a reported outcome, not a reason to claim that
an integration works. Initial deployment evidence and remaining activation
requirements should be reported separately from code completion.

## Required combined acceptance

Every pull request, main-branch push and release verification runs the ordinary
repository checks, the independent `npm run test:selfhost:hostile` suite and
both browser scenarios (`test:browser` and `test:browser:evidence`). These steps
are mandatory, with no conditional or failure-suppression escape. A workflow
contract test rejects removal or weakening of either additional gate.

The hostile suite needs OpenSSL and generates temporary local TLS identities.
Its fixture, policy, transport, CLI and Worker checks use only synthetic inputs
and loopback servers. The evidence-browser scenario has its own database and
port and verifies independent source comparisons without external requests.
Neither suite establishes access to a real provider account.

## Bounded provider probes

`pulse probe` checks access without opening the installation database or publishing
observations. By default each dataset uses its most recent completed source-local
day: Pacific for Search Console, the configured site timezone for Plausible, and
UTC for the remaining sources. An explicit window requires both `--from` and
`--to` and may span at most seven calendar days. `--days` and `--rotate` are
rejected instead of silently ignored. Invalid windows fail before configuration
loading in the CLI, and before credential/client creation in the library.

Each result includes `requestedWindow` and `sourceTimezone`. On success,
`testedWindow` records the collector's actual returned range, which can differ
because GitHub repository/release totals are current snapshots, referral groups
are rolling windows, or a provider clips history to its retention limit. On
failure `testedWindow` is `null`: the attempted dates do not establish validated
coverage. The row count and existing notes remain visible; an available response
with zero returned rows does not establish zero traffic or complete history.

Use `--resource`, `--group` and `--max-jobs 1` for an account-specific acceptance
check. A successful probe neither enables a source nor schedules its collection.

## Portable OCI runtime smoke

An explicit opt-in `npm run test:oci` builds the Dockerfile with rootless
Podman and exercises the container image as its default non-root user,
using synthetic configuration and a temporary SQLite volume. It tests
host-scoped authentication, spoofed forwarded headers, session cookies and
database persistence after restarting the container. The test is
designed to clean up its generated resources.

This proves local OCI functionality, not a real HTTPS proxy, Docker Compose
orchestration, cloud migration, multi-replica storage, provider auth
longevity or unattended backup recovery. Keep those as distinct
operational acceptance gates.

## Pinned self-hosted transport

`tests/selfhost-policy.test.ts` and `tests/selfhost-transport.test.ts` run
in `npm test`. The second file opens real TLS connections to a server on
127.0.0.1 whose authority and certificates are generated in memory for each
run. It reaches loopback through a test-only seam that no setting,
configuration field or command-line flag can produce.

The tests show that the socket follows the pinned address, that the declared
hostname is the TLS server name and `Host`, and that a wrong, untrusted,
expired or address-only certificate stops the read before the credential is
sent. They also cover refused redirects, status classes, body, header and
time bounds, forged destinations, and a Worker job failing without a
credential read. The refusal under a process-wide verification bypass runs
in a child process, so the test process itself never disables verification.

This is contract-tested evidence only. No real Plausible Community Edition
or Umami installation, public certificate authority, DNS, proxy or firewall
is involved. Account probing against a consenting instance remains open.

## Worker runtime contract

`npm run test:worker` bundles the actual scheduled handler and executes it inside
workerd with a real local D1 binding. The provider responses are synthetic; every
outbound request is constructed with the runtime's native `Request`. This catches
runtime differences that Node-only fetch stubs cannot, including unsupported
redirect modes. The test verifies publication, rejected redirects, failed cron
outcomes, preserved history, released leases and subsequent recovery.

This test makes no live provider requests and does not prove account access,
production CPU usage or successful future cron delivery. Those remain separate
installation checks.

The Worker test gate also verifies synthetic RS256 Access identities with native
workerd WebCrypto. Its fixtures are generated test keys, not live Access sessions.
A separate deployment acceptance must verify the real owner-only edge policy and
login flow; no test result implies an account grant exists.
