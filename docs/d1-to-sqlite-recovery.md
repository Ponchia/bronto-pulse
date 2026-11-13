# Recover a Cloudflare D1 installation into portable SQLite

Lifecycle: current

Pulse already uses the same transactional observation model through the
SQLite and D1 drivers. Cloudflare Workers and D1 are **not** required to
read recovered history on a self-hosted Node installation.

## Boundaries

This is an **offline recovery drill**, not an automatic service migration.
Neither running the check nor generating a portable archive changes the
production Worker, provider grants, collection schedules or Cloudflare
resources. Do not switch collectors before independently validating the
new installation and its backup/restore.

Use a **trusted, verified** Cloudflare D1 SQL export from your own
installation, ideally created by the operator backup tool with a
corresponding `.sql.gz.json` checksum manifest. The SQL export contains
private analytics, page/query dimensions, historic project mappings and
potentially sensitive source details. Keep it encrypted and access-restricted
outside source control. A foreign SQL file can execute arbitrary SQL and
must never be accepted as an untrusted upload.

## Repeatable proof

From a trusted Pulse checkout with Node 24+, SQLite CLI and gzip:

```sh
npm ci
npm run build
npm run test:d1:recovery -- /private/pulse-d1-YYYYMMDD.sql.gz
```

The opt-in recovery script reads the archive, verifies its SHA-256 against
an adjacent manifest when present, validates gzip, restores its SQL into a
temporary SQLite database, checks SQLite integrity and foreign keys, then
runs **real Pulse CLI** reporting/export/import against that recovery.
It creates a second empty SQLite database from the portable archive and
compares the same project/date window's cards, breakdowns, annotations,
evidence flags, warnings and URL inspections. Neither file persists after
the check. It prints no source values, query text, tokens or private reports.

The test takes the first configured project and a 28-day period ending at
the latest published date. It refuses archives without a valid project or
published dates. If the archive has more than Pulse's portable export
limit of 100,000 published observations or inspections, export may be
refused. In that case a complete, separately verified SQLite database
backup is the more appropriate recovery vehicle; do not silently truncate.

### Why the SQL restore is wrapped in a transaction

The D1 SQL exports currently observed contain tens of thousands of
individual `INSERT` statements with **no surrounding transaction**.
Using SQLite CLI naïvely can issue a filesystem commit per statement and
make restoration excessively slow. The proof preflights the export for
existing transaction commands and then restores the trusted SQL inside
one `BEGIN IMMEDIATE ... COMMIT` transaction. Unexpected transaction
syntax is a fail-closed format change, not something to work around by
ignoring errors. It checks `PRAGMA integrity_check` and
`pragma_foreign_key_check` before reading reports.

Raw SQL contains older superseded observations and runs, whereas
`pulse export` intentionally produces the current portable published
history and bounded recent run metadata. **Raw row counts can decrease**
after export/import without losing the active published partitions.
Report equality and referential integrity are the correct acceptance
checks. Preserve the original SQL/SQLite backup if you need a full
forensic record of superseded collection runs.

## Actual cutover (separately authorized)

1. Freeze the original collector after a final complete collection and
   take a fresh, independently restorable D1 export and checksum.
2. Restore into a new, empty SQLite database on the target host, never
   into a database that already contains collected observations.
3. Protect the SQLite volume and configuration with restrictive ownership,
   encrypt off-host backups, and copy provider credentials through your
   existing secret-management process. The portable archive contains
   environment-variable **references**, not the original secret values.
4. Compare representative project reports for complete matching calendar
   periods, including source quality and import limitations.
5. Run the target dashboard behind an HTTPS reverse proxy and verify owner
   authentication, Host/Origin rejection, persistent storage, restart and
   independent restore before enabling its optional collector.
6. Ensure only **one** collector installation is writing new history per
   provider resource during the cutover. Disable the old schedule only after
   the target is accepted, and retain its rollback state until new backups
   have been independently recovered.

Do not copy an actively changing D1 SQLite file over a remote filesystem,
run multi-replica SQLite on Kubernetes, or treat a healthy `/health`
response as proof that source collection or restores are complete.

See [portable self-hosting](self-hosted-compose.md),
[operations](operations.md) and [reporting contracts](reporting.md).
