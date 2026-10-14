# Security and privacy

Treat provider credentials, private reports, page/query dimensions and database
exports as sensitive. Do not file public issues with tokens, cookies or raw
provider responses. Report vulnerabilities privately to the maintainer through
the repository's private reporting mechanism when enabled, without disclosing
production secrets.

## Boundaries

The browser gets no provider credentials and makes no calls to provider APIs.
Its reporting token produces an HTTP-only HMAC-signed session. The API is
read-only, denies cross-origin login, has no permissive CORS policy, applies a
restrictive CSP and does not accept SQL or arbitrary fetch URLs. The local
server binds and accepts Host headers only on loopback. A Worker must have a
strong API token; otherwise it fails closed. Access identity headers are not
trusted without verification; place Cloudflare Access in front as an additional
layer rather than replacing built-in auth with a header check.

Collectors only reach approved HTTPS API origins, reject redirects, cap bytes
and rows, validate finite values, and keep upstream error bodies out of logs.
Query text collection is explicit opt-in. URL queries and fragments are removed.
No stars/contributor profile database is collected. This does not make every
possible input anonymous or establish a blanket GDPR exemption.

A new project scope, provider permission or retention policy must be reviewed
as a data-boundary change. Preserve encrypted backups and independent recovery
credentials. Never expose a live demo containing private owner data. The
included demo is synthetic and uses a separate database.

## Residual risks

Operator hosts and cloud account administrators can read the database. A
compromised reporting token can read the private reports/export. A compromised
collector environment can access its provider credentials. Read-only API
rate limiting should be supplied by a private proxy/Cloudflare for any exposed
deployment; the standalone loopback server is not an Internet-facing perimeter.
Review key rotation, backup access, optional query terms and storage retention
before wider deployment.
