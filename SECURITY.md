# Security and privacy

Treat provider credentials, private reports, page/query dimensions and database
exports as sensitive. Do not file public issues with tokens, cookies or raw
provider responses. Use [GitHub private vulnerability reporting](https://github.com/Ponchia/bronto-pulse/security/advisories/new)
for vulnerabilities. Include a minimal synthetic reproduction, affected commit
and expected security boundary. Do not send production credentials, even privately.
Ordinary support requests belong in the issue templates.

## Supported source

During the public preview, security fixes target the latest `main` commit.
There is no supported npm release or long-term-support branch yet. Public source
availability is not a warranty of production readiness; deployments require their
own access, retention and recovery review.

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

## Reports and downloads

CSV text is quoted and neutralized when its prefix could be interpreted as a
spreadsheet formula; numeric columns remain numeric. Markdown briefings escape
untrusted text. These encodings reduce output hazards but do not anonymize data
or authorize publication. Download endpoints require normal authentication and
send `Cache-Control: no-store`. Login request streams are bounded before full
allocation. The browser cannot execute a collection plan or submit provider SQL.

## Local startup credentials

When no reporting token is configured, the loopback CLI generates a temporary
local token and prints it once for interactive sign-in. Treat that terminal
output as sensitive: for supervised or log-captured servers, supply
`PULSE_API_TOKEN` instead. Configured tokens are never printed. An explicitly
configured but invalid token fails closed rather than falling back to generation.

## Development HTTP client patch

The exact Miniflare 5.20261019.1-beta development dependency pins Undici
7.29.1. A version-scoped override selects 7.30.1, fixing GHSA-4qv8-2p9j-2685,
GHSA-f72v-6w45-q472 and GHSA-xjj6-f33q-929c. This override does not affect the
deployed Worker dependency graph.

Remove the override after upgrading to an upstream Miniflare release that
includes the fixed HTTP client. Review the resolved lock and run the browser,
D1 and Worker dry-run checks before changing or removing it.
