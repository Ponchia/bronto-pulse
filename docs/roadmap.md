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

Before a public beta, validate real Cloudflare field availability and units,
Google authorization longevity, deployed D1 usage, backup recovery and several
successive scheduled collection cycles. Those checks are environment-specific,
not satisfied by unit tests alone. Add sources only when a concrete project
question needs them, preserving metric semantics and privacy boundaries.
