# Operations and recovery

Lifecycle: current

## Symptom: stale or absent metrics

### Preconditions

Use the private installation and selected provider account. Keep credentials
out of source control and logs. Inspect `pulse doctor --json` before guessing
that a zero in a provider UI means a zero in a source dataset.

### Steps

1. Read the failed group's safe error code and last successful refresh.
2. Run `pulse probe --resource RESOURCE --json` to verify identity, permissions
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
