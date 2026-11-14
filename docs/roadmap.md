# Roadmap and deliberate limits

Lifecycle: proposal

Implemented source adapters and reporting behavior are listed in the README.
The following are **not** represented as shipped features:

- Multi-tenant hosting, billing, user accounts and public signup.
- A contributor CRM, individual attribution, visitor SDK or session replay.
- A dedicated MCP server; the read-only API/CLI already supports agent use.
- An arbitrary SQL warehouse, unbounded raw payload retention or plugins with
  arbitrary network/code execution.
- An automatic migration between cloud providers or credential consent flow.
- Automated marketing recommendations or a universal adoption score.
- High-cardinality resumable provider page queues. Current jobs fail closed at
  bounded limits and operators can collect narrower windows.
- Automatic publishing of an owner's private report.

Before recommending a production installation or stable package release, validate
real Cloudflare field availability and units,
Google authorization longevity, deployed D1 usage, backup recovery and several
successive scheduled collection cycles. Those checks are environment-specific,
not satisfied by unit tests alone. Add sources only when a concrete project
question needs them, preserving metric semantics and privacy boundaries.

The public source preview does not depend on completing a maintainer-specific
production deployment. That validation remains an explicit follow-up.

## Portable evidence-platform milestones (proposal)

- Validate Docker Compose on an independent host and run an encrypted restore
  drill before treating it as an operationally supported self-hosted release.
- Test Plausible/Umami against consented actual accounts, explicitly checking
  timezones, missing days, imports, permissions and rate limits. The fixed
  hosted endpoints in the first adapters are not a self-hosted-provider
  integration.
- Qualify the already-implemented, opt-in due-time scheduler against
  real provider quotas, long-running backoff and fairness. The regular
  Worker rotation remains available and unchanged.
- Introduce explicit project/site/package/deployment relationships and a
  primary-source declaration for comparisons; never add duplicate measurements
  from analytics systems tracking the same site.
- Consider PostgreSQL + multi-worker queue only after a real HA pilot.
  [ADR 0004](adr/0004-self-hosted-connector-egress.md) specifies the
  threat model and test gates for self-hosted analytics endpoints. Its
  first pinned Node/OCI transport is synthetic-tested; a pilot against a
  consenting real installation is still required. No arbitrary URL
  transport or external plugin execution is shipped.
- Pilot with non-maintainer OSS teams and measure whether an evidence-backed
  finding is useful beyond an existing provider dashboard.

See [product direction](product-strategy.md) and [ADR 0002](adr/0002-curated-connectors-and-provider-semantics.md).
