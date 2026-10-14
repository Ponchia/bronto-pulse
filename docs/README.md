# Documentation router

Lifecycle: current

| Document                                             | Purpose                                           |
| ---------------------------------------------------- | ------------------------------------------------- |
| [Architecture](architecture.md)                      | Data flow, transaction model, portable boundaries |
| [Metric contracts](metrics.md)                       | Aggregation semantics, attribution, coverage      |
| [Providers](providers.md)                            | API permissions, configuration and limitations    |
| [Deployment](deployment.md)                          | Local, container and Cloudflare Workers/D1        |
| [API](api.md)                                        | Read-only endpoint and agent interface            |
| [Operations](operations.md)                          | Repair, backup, restore, retention, rollback      |
| [Validation](validation.md)                          | Evidence levels, tests and account checks         |
| [ADR 0001](adr/0001-private-source-aware-history.md) | Durable product boundary                          |
| [Roadmap](roadmap.md)                                | Explicitly unimplemented future work              |

Maintained documentation is checked by `npm run docs:check`. API capabilities
come from code and tests, not marketing claims. Private deployment evidence
belongs outside Git. Historical research is not a current operational contract.
