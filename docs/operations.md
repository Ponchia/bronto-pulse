# Operations and recovery

Lifecycle: current

## Symptom: stale or absent metrics

### Preconditions

Use the private installation and selected provider account. Keep credentials
out of source control and logs. Inspect `pulse doctor --json` before guessing
that a zero in a provider UI means a zero in a source dataset.

### Steps

1. Read the failed group's safe error code and last successful refresh.
2. Run `pulse probe --resource RESOURCE --group GROUP --json` to verify identity, permissions
   and a bounded request. Cloudflare siteTag is not the public beacon token.
3. Repair credentials through the provider's normal access flow. Do not broaden
   permissions to arbitrary repositories or scrape a signed-in browser.
4. For a row-budget error, collect smaller `--from`/`--to` windows. Publication
   only switches pointers after the complete bounded response has validated.
5. Retry the affected group. `sync` returns exit code 2 when any selected job
   fails; healthy groups can still succeed independently.

### Verify

Compare provider values for the exact same period, timezone and scope. Inspect
run coverage and provisional flags. Run a second overlapping refresh and verify
that counts do not double. Confirm zero buckets remain distinct from absent
buckets. A failed refresh must retain the earlier successful report.

For a recurring Free-profile GSC `ROW_LIMIT` on the optional `queries`
group, inspect exact source-local dates and normalized row counts before
changing the collector. When a shorter window really fits, a
`lookbackDaysByGroup.queries` override narrows **only** that group's regular
refreshes, and `pulse plan` previews the selection. It does not increase
Worker limits or promise complete query population. Explicit bounded backfill
remains necessary for omitted older dates and later provider revisions; do not
silently treat an uncollected date as zero.

### Rollback

Stop the collector. Restore a private export into an **empty** database and
verify reports before switching the server to it. Do not merge two different
histories implicitly or delete the original database until recovery is proven.

### Escalation

An unsupported dataset or field remains unavailable until its official contract
and actual account capability are verified. Do not manufacture a fallback count.
A lost Google refresh grant requires normal operator consent, not code retries.

## Backup and retention

`pulse export --out /private/location/export.json` refuses active collectors.
Exports contain current observations, coverage pointers, recent run metadata,
annotations and configuration with environment-variable references. They do
not contain secret values. Treat them as private because page/query dimensions
may still be sensitive. Files are created mode 0600 and never overwrite an
existing export by default. Encrypt backups and test a restore off-box.

Import reads at most 100 MiB of private JSON before opening its destination,
allocating in bounded chunks rather than reserving the full allowance for a small
file. Invalid UTF-8 is refused rather than silently replaced. Inputs must be
regular files; on POSIX, named pipes are opened without blocking and refused
before reading, even when no writer is connected.
Malformed JSON, unreadable files and oversized inputs fail without echoing their
contents or creating the destination directory. The archive itself supplies its
configuration: do not pass an ignored `--config` override to `import`.

`pulse import --db restored.db --input export.json` validates the format,
references and metric rules and imports transactionally into an empty database.
`pulse compact` removes old unreachable staging/replaced observations, not
active history. There is no automatic deletion of collected analytics; the
operator must adopt a suitable retention policy, especially for optional
query text and detailed dimensions.

A complete disk/database backup is also appropriate for large installations.
Keep repository credentials and backup decryption credentials recoverable
independently of the collector host. A backup file that has never been restored
is not evidence of recoverability.

An opt-in [D1-to-SQLite recovery proof](d1-to-sqlite-recovery.md)
validates a trusted D1 SQL archive, restores it transactionally, and compares
the portable export/import reports in temporary private databases.
It never changes production and is not an automatic cutover.

## Full SQLite backups on a single host

The container includes a full-database backup helper. It opens the existing
SQLite database read-only, pins one WAL snapshot, and uses Node's native
[SQLite online backup API](https://nodejs.org/download/release/v24.22.2/docs/api/sqlite.html).
It never runs migrations, registers a catalog, reads provider credentials or
contacts a provider:

```sh
node deploy/backup-sqlite.mjs \
  --db /private/pulse/pulse.db \
  --out-dir /private/pulse/backups \
  --retain 14
```

Use canonical, operator-owned paths on a local filesystem. The source must
already exist. Source files and output directories must have no group or other
permissions; symbolic links are refused. The helper creates its directory mode
0700 and files mode 0600. It verifies integrity, foreign keys, the registered
catalog and every table's ordered contents against the same source snapshot
before atomically publishing a new archive and checksum manifest. Concurrent
WAL writers may continue; copying the live `.db` file with `cp` is not equivalent.
All retained runs, superseded observations, configuration versions, inspections,
review records and operational metadata are included.

`--retain` accepts 2–31 verified archives (default 14). `--max-bytes` accepts
1 MiB–1 GiB (default 128 MiB) and counts committed WAL pages as part of the
snapshot. At the defaults, 14 full-size retained archives occupy at most
1.75 GiB, plus the new snapshot, the live database and its WAL. Account for that
space before scheduling backups; a PVC's requested capacity alone may not impose
a filesystem quota. The operation has a 180-second deadline. In Kubernetes use
one backup job at a time and an outer deadline longer than this helper's budget.

Retention considers only matching `pulse-sqlite-*.db` files with valid private
manifests and matching checksums. Unrelated, incomplete, tampered, linked or
unreadable files and the source database remain untouched. A failed new backup
never prunes prior ones. A private lock prevents overlapping invocations; if the
entire process or host is killed, inspect and remove that operation's stale lock
only after confirming it no longer runs. Unexpected partial files also require
operator review and are not automatically pruned.

Success prints metadata and checksums, never source values. Failures print
`ok:false` and a fixed category such as `operator-setup`, `already-running`,
`backup-size`, `backup-timeout` or `backup-verification`. The manifest always says
`offBoxVerified:false`. Schedule an encrypted transfer to an independent host
and verify a restored copy there; a snapshot on the live PVC and a successful
CronJob are not evidence of off-host recovery.

To restore, stop the collector and dashboard, verify the archive checksum, and
copy the full archive to a **new** private database path. Run integrity/foreign-key
checks and compare representative reports, review hashes and configuration before
switching both services to that path. Preserve the previous database and never
replace a live file or merge two collectors' histories implicitly.

## Historical configuration changes

A collected resource cannot be deleted from the catalog: keep it with
`enabled: false` so backups preserve its historical observations. Existing
project/source mappings may change prospectively by closing the previous
binding with `effectiveTo` and adding the new scope with `effectiveFrom`.
Retroactive scope edits are rejected after the first collection. New sources
and projects can still attach existing historical data. A Cloudflare collector
hostname changes the provider query scope and therefore requires a new resource.

## Consistent portable backups

SQLite and D1 exports read the configuration and published data within one
transactional snapshot. Active collectors are reported as a conflict. Abandoned
unpublished runs are omitted so they cannot make an otherwise healthy backup
unrestorable. Import validates resource identities, annotations and observation
contracts before atomically restoring an empty database.

## Dry runs and bounded catch-up

`pulse plan` and `pulse sync --dry-run` do not open a database, read credentials
or contact a provider. `pulse backfill --from DATE --to DATE` executes its plan
serially with a bounded number of independently published chunks. Plans report
unrecoverable dates, current-only snapshots and omitted jobs. Backfill refuses
an over-budget plan before issuing any provider requests. It is not a resumable
high-cardinality task queue; narrow failed jobs and rerun them explicitly.

`pulse backfill` writes to the local database. A Worker installation instead
declares `history` on a resource and a history trigger; each invocation collects
one older chunk into D1. Progress is the earliest published day per dataset
(`partitions`), so nothing else needs resetting. The Worker log reports
`pendingDatasets`, which falls to 0 when every declared history is complete.

`pulse probe` now tests each configured group, not merely the first group.
Capability-discovery failure does not pretend a supported data query failed:
both results remain visible. Capped probes report `omittedJobs` and return exit
code 2 until all requested groups have been tested. Probe never writes history.

The scheduler rotation cursor is scoped to the source/resource/group selection.
A manual filtered sync does not move the cursor for an unrelated portfolio run.
Even failure to insert a run record releases its owned lease; a storage error
cannot leave a ten-minute artificial block on that dataset.

### Exit codes

- `0`: requested operation completed; a plan is not an executed collection.
- `1`: invalid input, unsafe output overwrite, storage error or another fatal failure.
- `2`: one or more selected collection/probe jobs failed, a probe omitted selected
  work, or health needs operator attention. Successful independent chunks remain.

Both ordinary backups and report output are private. Report destinations use
exclusive creation and never overwrite an older file implicitly. The local
`.pulse` directory and files must remain outside source control and publication.

## Scheduled failures and runtime diagnostics

A scheduled handler rejects when any selected collection job fails, after other
independent jobs finish. It logs only aggregate counts and controlled error text;
per-job details remain in the private run history. The scheduler lease is released
on both success and failure. A zero-failure invocation alone does not prove that
all resources are current: inspect the authenticated `/api/v1/health` response or
`pulse doctor --json` for missing credentials, failed groups and stale coverage.

`REDIRECT` means a provider returned a 3xx response that Pulse refused to follow.
Verify the official endpoint; never disable the origin allowlist or forward tokens
to a redirect target. `NETWORK` is a connection or response-stream failure, not
proof that the provider is down. Compare the same request in the actual Worker
runtime and the local CLI before assigning a cause.

`/health` is unauthenticated liveness only and must not be used as a collection
success monitor. Cron failure reporting is not a notification delivery service;
configure an owner-approved alert consumer separately.

### Transport diagnostics

`NETWORK` errors retain only a bounded sequence of fixed diagnostic categories
for the three connection attempts (`timeout`, `aborted`, `connection-lost`,
`type-error`, `range-error`, `other`, or `non-error`). The stored message never
includes a provider URL, response body, exception text, headers, account identifiers
or tokens. A `type-error` describes a runtime rejection, not proof of a specific
request-construction defect; compare with a real Worker execution before changing
network settings. Existing older `NETWORK` records predate this diagnosis and have
no inferred category. Diagnostics alone do not certify a provider's availability.

### Workerd native fetch receiver

A native `fetch` function reference may fail in Cloudflare Workers if saved as an
object member and later called as `object.fetcher()`. Workerd reports `TypeError:
Illegal invocation: function called with incorrect this reference`. Node's fetch
may accept the same mistaken call, masking this failure in Node-only tests.
Pulse's default client now wraps the native function in a direct `fetch(input,
init)` call; injected test fetchers and the fixed origin allowlist are unchanged.
The worker contract tests a receiver-sensitive fetch inside workerd. A failure
recorded by an earlier release is retained as historical evidence rather than
rewritten or interpreted as an upstream npm outage.

### CPU headroom on the Free plan

The Free profile is a bounded workload, not a promise about measured CPU time.
Monitor actual invocation CPU separately from wall time and deployment startup.
UTC dates use the ISO calendar directly rather than constructing an ICU formatter
on every call; non-UTC datasets retain IANA timezone behavior. Existing collected
dates and comparison rules are unchanged. Sustained CPU-limit errors must be
addressed by reducing work or optimizing code, never by silently upgrading billing.

### GitHub denied requests versus shared-IP quotas

GitHub can return HTTP 403 when an anonymous source IP has exhausted its quota.
Pulse classifies GitHub's explicit `x-ratelimit-remaining: 0` or positive
`retry-after` evidence as `RATE_LIMIT` and does not retry immediately within that
job. A 403 without quota evidence remains `PERMISSION`; a 404 does not prove a
repository was deleted, because private repositories also need an authorized
grant. Never change a repository's visibility or copy an operator's broad CLI
token to repair collection. Use a dedicated selected-repository read-only grant.

Reference: [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## Explicit operator D1 backup job

`scripts/operator-backup.py` is an opt-in Unix operator helper, not a public API
or an enabled repository workflow. Supply absolute paths to the installed
Wrangler executable and the ignored deployment configuration, the selected D1
database name, and a private output directory. It uses the operator's existing
Wrangler authentication; it never reads browser credentials.

```sh
python3 scripts/operator-backup.py \
  --wrangler /absolute/node_modules/.bin/wrangler \
  --config /private/wrangler.private.jsonc \
  --database private-pulse \
  --out /private/backups --retain 14
```

Each export is limited to 64 MiB and restored in memory with integrity and
foreign-key checks before publication. Database attachments are forbidden. The
compressed bytes are restored again, archives and manifests use mode 0600, and
the directory uses mode 0700. Only matching verified archive/manifest pairs are
eligible for count-based retention; failed exports never prune prior backups.
A lock prevents overlapping jobs. Python 3 and a Unix host are required.

A failed run prints `ok:false` with one fixed `category`: `authentication`,
`rate-limited`, `network`, `cloudflare-unavailable`, `export-failed`,
`export-timeout`, `export-size`, `restore-verification`, `already-running` or
`operator-setup`. Wrangler's own diagnostics can name the account and database,
so they are classified and discarded, never printed. `authentication` usually
means the operator's Wrangler login needs a refresh (`wrangler login`).

`--freshness --out /private/backups` judges collection health offline, from the
newest verified archive, with no Wrangler call or credential. Collection ages are
measured from the archive's capture. It prints one JSON line and exits 1 unless
`category` is `healthy`. The other categories are:

- `backup-missing`: no verified archive exists.
- `backup-unreadable`: the newest archive cannot be read.
- `backup-stale`: the newest verified archive is more than 30 hours old.
- `collector-stalled`: the newest run started more than 2 hours before capture.
- `groups-stale`: an enabled group's last success, or its first attempt if it
  never succeeded, is more than 48 hours old (the default `staleAfterHours`).
  `staleGroups` names each one as `resource/group`.

Schedule it after the export so a silent cron, a provider that fails every time
or a stopped backup reaches the operator.

Schedule this helper explicitly before the existing encrypted off-box backup.
Its manifest always says `offBoxVerified:false`: copying to a local directory or
matching a backup include rule does not prove remote custody. Verify the remote
snapshot includes the new archive and restore it independently. D1 Time Travel
is complementary provider recovery, not an independent backup destination.

## Bounded quota retries and report reads

The Free execution profile defers HTTP 429 responses to the next scheduled
collection instead of retrying them immediately. One denied provider request is
recorded as `RATE_LIMIT`, its response body is canceled, and previous published
history remains unchanged. This does not raise quotas or replace a missing
provider grant. The portable CLI retains its existing bounded retry policy.

The normalized observation limit is checked before staging or publication.
An upstream row can produce several metrics, so the provider row limit alone is
not sufficient. Free collection accepts up to 250 normalized observations and
rejects larger results without publishing a partial dataset.

Reports read one latest outcome per resource/group, including groups whose last
run predates hundreds of runs in other groups. An active group therefore cannot
hide an older failed group's warning. Reporting reads omit duplicated storage
keys that are not part of the returned observation model. The original archive,
run-history API, transaction snapshot, source windows and metric arithmetic are
unchanged. These smaller reads reduce transferred data; they are not proof of
sub-10-ms production CPU time. Measure the actual deployed invocation separately.

## Hosted review records and selected inspections

Apply additive `migrations/0003_review_records.sql` through the normal deployment
migration path before deploying a Worker that requires the review table.
The local CLI migrates its local database; `--remote-d1` never migrates or
registers a replacement catalog. It reads the existing D1 configuration.

For explicitly authorized owner operations, supply `CLOUDFLARE_ACCOUNT_ID`,
`PULSE_D1_DATABASE_ID` and `CLOUDFLARE_API_TOKEN` through the private environment.
Use a token scoped to the required account and D1 access. Keep provider
credentials private as for local collection. `--remote-d1` cannot combine with
`--config` or `--db`, and is not a public SQL or browser API.

Supported owner workflows include `review-record`, `review-history`, `inspect`,
`annotate` and reporting commands. Remote `sync` requires one selected resource,
group and explicit source day (`--from` equals `--to`), with one job and the
Free execution profile's request/byte/observation limits.

The native Worker uses Cloudflare's documented [D1 binding batch
transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
The operator adapter uses the administrative [REST query batch
endpoint](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/),
whose reference does not state the same rollback guarantee. Live rollback
qualification is separate from the simulated transport tests. After an interrupted
or rejected multi-statement owner request, inspect stored state before deciding
whether to retry; the adapter does not retry it automatically.

A review's caller-supplied id is its retry identity. Retrying identical input
returns the original snapshot; a changed conclusion needs a new id and may link
the original with `followUpOf`. An interrupted D1 write is not automatically
retried. Read by that id before deciding the next action.

Portable archives include review records and verify the frozen evidence on
import. Older archives without reviews remain valid. The journal export is
bounded to 1,000 records and 16 MiB; larger journals require the encrypted
database backup path. An exceeded limit fails explicitly without discarding
history. Collection compaction does not delete review snapshots.
