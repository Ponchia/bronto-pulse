# Initial implementation validation — 14 October 2026

Lifecycle: archive

Historical pre-publication validation record. For current source availability,
CI and deployment boundaries, see [maintainer releases](releasing.md).

This records a specific local verification, not a production availability claim.

## Completed checks

- `npm run check`: formatting, strict TypeScript, 71 contract/regression tests,
  documentation integrity and compilation passed.
- `npm run test:d1`: actual local D1 binding, fenced publication, replacement,
  transactional export and an independent import produced identical reports.
- `npm run worker:check`: Worker and private assets bundled successfully without
  deploying or activating a paid service.
- `npm run test:browser`: five browser checks passed, covering authenticated
  navigation, project reports, collection health, metric definitions, browser
  storage and layouts at 320, 390 and 1440 CSS pixels.
- `repo-instruction-audit --repo .`: the repository house contract passed.
- Production dependency audit: no reported vulnerabilities at validation time.

## Actual account evidence

The ignored `.pulse/` pilot contains GitHub data for Bronto UI, Bronto
Annotations, Sense6 and the personal-site repository. All 24 GitHub collection
groups succeeded during the initial authenticated collection. The npm collector
also fetched 14 daily download observations for the configured Bronto UI package.

The live database was exported, restored into a separate SQLite database, and
all four project reports compared equal. Private databases, reports, tokens and
payloads are excluded from Git and package publishing.

Cloudflare RUM, Search Console and Sense6 D1 adapters are implemented and tested
against contract fixtures, but this record does not claim successful authorized
collection from those accounts. They require appropriate credentials and verified
resource IDs. No production Worker, external route or collection timer was
activated. GitHub-hosted CI evidence is separate from these local results.

## Follow-up hardening

The complete contract suite was expanded to 73 passing tests. Retired resources
now retain their historical report cards and appear explicitly as disabled in
collection health. Changing from property totals to page-scoped measurements is
also treated as a historical mapping change, even when the path prefix is `/`.

The first GitHub-hosted workflow was refused before any job steps ran because
of the account's billing/spending gate. This is not evidence of a failing test
and is not a passing CI result. Billing was not changed. The workflow supports
an explicitly authorized trusted runner via `PULSE_RUNNER`; deployment and
runner registration remain operator actions.
