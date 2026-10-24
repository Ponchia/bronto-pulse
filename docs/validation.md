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

Real account tokens and retrieved private metrics must live outside tracked
files. A credential failure is a reported outcome, not a reason to claim that
an integration works. Initial deployment evidence and remaining activation
requirements should be reported separately from code completion.

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
