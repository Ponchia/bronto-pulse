# Worker configuration beyond the Free secret size limit

Lifecycle: current

Cloudflare Workers Free permits 64 environment variables per Worker, up to
5 KB per variable. Pulse retains the original private `PULSE_CONFIG` secret or
uses a bounded, atomic bulk of **2–8 parts, up to 4096 UTF-8 bytes each**.
This needs no KV, R2, additional hosting, model API or paid tier.

## Compatibility and activation

The existing `PULSE_CONFIG` remains authoritative until
`PULSE_CONFIG_MANIFEST` is present. Secret names `PULSE_CONFIG_PART_1` through
`PULSE_CONFIG_PART_8` can be staged alongside it without changing running
configuration. The manifest must contain **exactly** `version: 1`,
`parts: N` and a SHA-256 digest of the UTF-8 concatenation. A missing,
oversized, malformed or inconsistent part is rejected before registering
any data. Errors never echo configuration contents or tokens.

## Prepare one private atomic bulk

Validate the independently reviewed full configuration and build Pulse:

```sh
pulse validate --config /private/pulse.config.json --json
npm run build
node scripts/stage-worker-config.mjs \
  /private/pulse.config.json \
  /private/unique-new-staging-directory
```

Input must be a regular, non-symlink file with mode `0600`. Output must
be an absolute **new** directory (created mode `0700`) and the generated
`pulse-worker-config.secrets.json` is written mode `0600` without overwriting
an existing file. The script validates the typed config, splits at Unicode
boundaries and prints only its output path/part count, not private values.
Do not commit, log or share the bundle. Use legacy single-secret mode if
the configuration fits one 4096-byte chunk; over 32 KiB requires separate
review rather than an unbounded number of secrets.

## Deploy without intermediate inconsistent configurations

1. Merge and deploy a Worker revision that supports the manifest while
   retaining the original `PULSE_CONFIG`. Verify the old portfolio still works.
2. Create exactly **one staged Worker Version** containing all parts **and**
   the manifest:
   `wrangler versions secret bulk /private/unique-new-staging-directory/pulse-worker-config.secrets.json --name bronto-pulse`.
   This does not activate the version. Never use ordinary `wrangler secret bulk`
   for this, because that can deploy immediately.
3. Read back the staged version's secret names, D1, Access, runtime settings
   and cron via `wrangler versions view`. Compare with the **currently active**
   version; if another session changed it, stop and reconcile.
4. Run `wrangler versions deploy <staged-id>@100 --name bronto-pulse --dry-run`
   against the exact intended version. Activate only after review. Inspect
   authorized health, first collection runs, and their source dates.
5. Keep previous Worker version and private D1 backup for rollback. Metadata
   readback does not prove provider access or successful collection.

Leave legacy `PULSE_CONFIG` in place for rollback; it is ignored while
manifest mode is active. Each change to a chunk requires a **new complete
bulk and digest**. Never activate an individually updated part version.

## Operational and privacy boundaries

The only extra runtime work is bounded string concatenation and one WebCrypto
SHA-256 verification **per new configuration**, not per cached request.
The same provider budgets, account scope, D1 history, source provenance,
authorization and failure rules apply. An inconsistent multi-part version
fails closed; it does not substitute stale data. Staging no new source
proves collection, search indexing or growth.
