# Architecture

Lifecycle: current

Pulse collects provider aggregates into a typed observation model. All runtime
adapters call the same collectors and reporter. The local CLI uses Node's
SQLite driver. Workers use D1 through a narrow asynchronous SQL interface.
There is no additional browser instrumentation, contributor CRM or LLM in the
aggregation path.

## Resource, connection, project

A connection names server-side environment variables, never secret values. A
resource is a measurable provider object. A project references resources with
optional hostname/path scopes and effective dates. Shared scope overlaps require
explicit opt-in and are marked non-additive at portfolio level. Path prefixes
match segments, so `/ui/` never matches `/ui-secret/`.

Provider identities are pinned when returned by GitHub. A changed resource
identity cannot silently overwrite an existing catalog. Pin a verified numeric
repository ID when renaming a repository. Keep historical mappings and close
old mapping intervals rather than deleting their history.

## Publish model

A job owns a lease for `resource:group`. Fetches are bounded and parsed before
publication. Immutable rows are staged under a run ID, invisible to reporting.
A short SQL transaction checks the lease owner and expiry, marks the run
successful and switches the affected daily partition pointers. It includes any
release annotations. If the lease was stolen or expired, no pointers move.

An exception or truncated page sequence marks the run failed. Existing pointers
remain unchanged. Corrections may decrease values. A complete revised dataset
can remove rows that disappeared from the provider; it does not leave stale
high counts behind. Old unreachable staged rows can be compacted after seven
days, while active source history remains available.

A successful fetch with no rows marks the window as attempted but does not
manufacture zero observations. Coverage and run history are independently
queryable. Collection completeness is not the same as provider data completeness.

## Scheduling

Local `sync` is one-shot. External schedulers can call it with a bounded job
count and a persistent rotating cursor. The Worker supports an explicitly configured trigger,
a scheduler lease and eight jobs per invocation by default, so small resources do not need
an always-running service. Large installations should lower detail/cardinality,
use smaller date windows or a queue-oriented scheduler rather than assume all
providers fit into one invocation.

The default historical range is 14 days. GitHub clips to the provider's available
window; npm uses bounded chunks. Search Console and Cloudflare fail explicitly
when row limits are reached. A narrow retry then fills that dataset without
erasing earlier history. Continuous ingestion does not bypass upstream API
permissions, rate limits or publication delays.

## Private read path

The UI consumes the same project report object as the CLI and API. The API is
read-only and does not accept SQL, credentials, collector requests or a URL to
fetch. Browser sessions are HMAC-signed, HTTP-only, same-site and short-lived.
The local server rejects non-loopback hosts. No provider response bodies are
written to operational errors or client responses.

## Portability

The driver batch contract is transactional in both SQLite and D1. JSON1 inserts
bound parameters in batches and keeps SQL identifiers internal constants.
Portable exports use a versioned JSON format. Import requires an empty database
and validates resource/run/observation references before one atomic write.
For large installations use encrypted database backups as well as bounded
exports. There is intentionally no silent merge of competing histories.
