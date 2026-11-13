# Self-hosted analytics source connectors: planned support

Lifecycle: proposal

Pulse can already run itself on Node/SQLite or an OCI container. That
does **not** mean the current provider adapters connect to arbitrary
self-hosted Plausible or Umami instances. The initial adapters are hosted
API integrations. The proposed security contract is in
[ADR 0004](adr/0004-self-hosted-connector-egress.md).

## Provider matrix

| Variant                     | Read endpoint                                         | Authentication                                                    | Status in Pulse                            |
| --------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| Plausible hosted            | POST /api/v2/query on plausible.io                    | Team-scoped Stats API key; hosted plan restrictions               | Initial hosted adapter, account-unverified |
| Plausible Community Edition | POST /api/v2/query on operator instance               | Instance-specific API key; verify release version and permissions | Planned                                    |
| Umami Cloud                 | GET /v1/websites/{id}/pageviews on api.umami.is       | Cloud API key                                                     | Initial hosted adapter, account-unverified |
| Umami self-hosted           | GET /api/websites/{id}/pageviews on operator instance | Self-hosted API key recommended                                   | Planned                                    |

Umami's API documentation distinguishes the /api prefix of self-hosted
instances from the /v1 path of Umami Cloud. A simple hostname replacement
would therefore be functionally incorrect even without SSRF risks.

Plausible Stats is a read-only query API even though it uses HTTP POST.
Its Events API is for writing events, and administrative access is separate.
Do not request new write permissions in an analytics collector.

## Proposed operator workflow

1. Independently deploy and verify Pulse plus the analytics provider. Record
   the instance version, website identity and scope.
2. Create a provider-instance-specific API key with the narrowest possible
   permissions and store it in a private operator environment. Never include
   keys in a public project config, URL, browser call or log.
3. Admit an exact HTTPS destination. A future Node transport must pin the
   validated address at connection time and preserve TLS certificate checks.
   Private-network access requires an explicit deployment-level permit.
4. Probe a single bounded read-only dataset and verify the provider's actual
   timezone, retention, imports, permissions and rate limit behavior.
5. Activate collection after probe success, with per-source quota and stable
   instance identity; historical mapping switches use effective dates.
6. Present new metrics alongside existing ones without summing provider
   pageviews or inferring people from daily sessions/visitors.

The list above is a **future operator procedure**, not working CLI syntax.
Do not rewrite Cloud-hosted URLs in config, and do not introduce an open
HTTP proxy or reverse proxy receiving Pulse's hosted source token.

## What makes this worth doing

Many small OSS teams already operate website analytics on a VPS or
Kubernetes. Requiring a new SaaS contract just to use the Pulse evidence
layer would undermine the product's niche.

The correct solution is securely bounded interoperability: source-native
counts, transparent metrics, independent credential custody and portable
history. The first supported self-hosted connector will need real provider
account evidence and the TLS, egress, error and migration tests described
in [ADR 0004](adr/0004-self-hosted-connector-egress.md).

Sources:
[Umami API overview](https://docs.umami.is/docs/api),
[Umami authentication](https://docs.umami.is/docs/api/authentication),
[Plausible data access](https://plausible.io/docs/data-access),
[OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).
