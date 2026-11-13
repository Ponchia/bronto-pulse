# Documentation router

Lifecycle: current

| Document                                                          | Purpose                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------- |
| [Public preview](public-preview.md)                               | Source publication, privacy boundaries and maturity           |
| [Quickstart](quickstart.md)                                       | Demo, private setup, offline planning and first reports       |
| [Configuration](configuration.md)                                 | Connections, resources, scopes and historical changes         |
| [Coverage](coverage.md)                                           | Offline inventory gaps, permissions and collection boundaries |
| [Reporting](reporting.md)                                         | Evidence briefings, quality rules and private exports         |
| [Adoption quality](adoption-quality.md)                           | Interpretation limits, review signals and external evidence   |
| [Releasing](releasing.md)                                         | Maintainer gates, clean consumers and CI trust                |
| [Architecture](architecture.md)                                   | Data flow, transaction model, portable boundaries             |
| [Metric contracts](metrics.md)                                    | Aggregation semantics, attribution, coverage                  |
| [Connectors](connectors.md)                                       | Curated source catalog and Plausible/Umami reference adapters |
| [Product direction](product-strategy.md)                          | Competitive niche and staged roadmap (proposal)               |
| [ADR 0002](adr/0002-curated-connectors-and-provider-semantics.md) | Fixed egress and source-native metrics                        |
| [Providers](providers.md)                                         | API permissions, configuration and limitations                |
| [AI visibility](visibility.md)                                    | Offline prompts and private evidence                          |
| [Portable self-hosting](self-hosted-compose.md)                   | Docker Compose, SQLite, TLS proxy, recovery and limitations   |
| [Scheduling](scheduling.md)                                       | Optional due-time selection, intervals and retry bounds       |
| [Deployment](deployment.md)                                       | Local, container and Cloudflare Workers/D1                    |
| [API](api.md)                                                     | Read-only endpoint and agent interface                        |
| [Operations](operations.md)                                       | Repair, backup, restore, retention, rollback                  |
| [Validation](validation.md)                                       | Evidence levels, tests and account checks                     |
| [ADR 0001](adr/0001-private-source-aware-history.md)              | Durable product boundary                                      |
| [Roadmap](roadmap.md)                                             | Explicitly unimplemented future work                          |

Archived implementation review: [operator workflow refinement](validation-operator-refinement-2026-10-14.md).

Maintained documentation is checked by `npm run docs:check`. API capabilities
come from code and tests, not marketing claims. Private deployment evidence
belongs outside Git. Historical research is not a current operational contract.

- [Source comparison](source-comparison.md): read-only investigation of overlapping website analytics.
