# Private multi-source pilot acceptance

Lifecycle: current

This runbook qualifies an installation and a useful project assessment. It is
not evidence that a pilot has happened. Keep the resulting record private; do
not submit credentials, analytics exports, search queries or owner screenshots
in a public issue or CI artifact.

## Choose the claim before running the test

| Gate                    | Required evidence                                                                        | What it does not prove                                             |
| ----------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Source contracts        | Exact revision, ordinary tests and native runtime checks                                 | Real provider permissions or semantics                             |
| Account access          | Consenting operator, named source and bounded successful probe                           | Complete history or recurring reliability                          |
| Comparable observations | Actual same-site source mapping, matching dates and calendars, complete observed buckets | Equivalent measurement methods or true audience                    |
| Portable recovery       | Independent target host, verified private archive, matching report evidence              | HA, multiple collectors or a production cutover                    |
| Operator value          | A specific finding, supporting evidence and the owner's next verification step           | Verified adoption, causal conversion or general product-market fit |

A synthetic demo can qualify the first gate. It cannot qualify the other gates.
An incompatible comparison is a successful safety check, but not a demonstrated
multi-provider discrepancy. A second temporary directory on the same machine is
not a second-host restore or an independently installed portfolio.

## Prerequisites and stop conditions

Use a reviewed source revision or released package that actually includes the
features being qualified. Record the commit and runtime version, rather than
assuming the version string identifies unshipped source work.

The operator must already control the selected analytics accounts and authorize
the exact resource, reporting scope and collection window. API access must exist
on that account's plan. No step here creates an account, changes a subscription,
adds a tracker, changes a provider site's timezone or enables a live schedule.
Absent access is a blocked gate, not a reason to manufacture credentials or use
another resource's data.

For self-hosted sources, first verify that the selected revision implements the
required transport and runtime. A design ADR or a generic base URL is insufficient.
Validate its exact HTTPS hostname, destination policy, provider instance identity
and verified TLS path before supplying a key. Never disable certificate checking
or substitute an unrestricted fetch transport to make a probe pass. See
[connectors](connectors.md) and the supported runtime's deployment documentation.

Use a separate private pilot configuration and database. Never mix demo rows into
live history or enable two collectors for an existing installation. Restrict file
permissions and arrange encrypted off-host custody before collecting sensitive
query or page dimensions.

## Bounded first collection

The following commands are templates for an explicitly authorized operator.
Replace `analytics_plausible`, `analytics_umami` and the project ID with reviewed
configuration identifiers. Use a short, completed calendar window actually served
by both providers, not today's partial buckets. Keep secrets in an access-restricted
environment file, never in arguments, shell history, public logs or tracked config.

```sh
umask 077
CLI=/srv/pulse/dist/cli.js
CONFIG=/private/pilot/pulse.config.json
DB=/private/pilot/pulse.db
ENV=/private/pilot/provider.env
FROM=2026-11-10
TO=2026-11-11

node "$CLI" validate --config "$CONFIG"
node "$CLI" plan --config "$CONFIG" --resource analytics_plausible \
  --group traffic --from "$FROM" --to "$TO" --max-jobs 1 --json
node "$CLI" plan --config "$CONFIG" --resource analytics_umami \
  --group traffic --from "$FROM" --to "$TO" --max-jobs 1 --json
```

Those fixed dates are illustrative. Offline validation and planning neither open
the database nor contact providers. Review their selections before proceeding.
Then probe only the authorized resource, one dataset at a time:

```sh
node --env-file="$ENV" "$CLI" probe --config "$CONFIG" \
  --resource analytics_plausible --group traffic \
  --from "$FROM" --to "$TO" --max-jobs 1 --json
```

A probe contacts the provider but does not publish observations. Repeat for the
other selected source only after checking the first result and provider quotas.
On permission, schema, network or rate-limit failure, retain the safe category and
stop; do not retry in a loop or broaden the credential's permissions automatically.
A successful empty result is still not evidence of zero pageviews.

After successful probes, collect the same bounded windows explicitly:

```sh
node --env-file="$ENV" "$CLI" sync --config "$CONFIG" --db "$DB" \
  --resource analytics_plausible --group traffic \
  --from "$FROM" --to "$TO" --max-jobs 1 --json
node --env-file="$ENV" "$CLI" sync --config "$CONFIG" --db "$DB" \
  --resource analytics_umami --group traffic \
  --from "$FROM" --to "$TO" --max-jobs 1 --json
node "$CLI" report pilot_project --config "$CONFIG" --db "$DB" \
  --from "$FROM" --to "$TO" --format json --out /private/pilot/report.json
node "$CLI" brief pilot_project --config "$CONFIG" --db "$DB" \
  --from "$FROM" --to "$TO" --format markdown --out /private/pilot/brief.md
```

These are one-shot commands, not recurring collection activation. Exports refuse
existing output files; retain each reviewed attempt under a new private filename
instead of overwriting evidence.

## Verify a meaningful comparison

Confirm that both provider properties measure the same actual website, whole-site
scope and intended event type. A shared project label or opaque site identifier is
not proof of this relationship. Inspect the provider-native totals for the exact
same dates independently; retain only the minimal private evidence needed.

Use the authenticated [source comparison](source-comparison.md) workflow. Check
that the report retains separate source values, measurement methodology, timezone,
coverage and quality, then explains why a difference is supported or withheld.
Do not sum the sources, turn daily uniques into period-wide people, or infer bots
from a discrepancy. A very small baseline must not produce a persuasive growth
percentage.

Umami's initial adapter uses UTC day buckets; Plausible uses its declared site
calendar. Different calendars must remain incompatible. Do not relabel a site as
UTC, rewrite stored dates, or change account settings merely to pass this gate.
Select a genuinely comparable existing source pair or record the limitation.

A preferred-source policy is optional. Its effective date must describe a real
choice and preserve existing historical mappings. Use manual same-site comparison
for an earlier pilot window rather than retroactively assigning authority to it.
A change of preferred source inside a report window must remain explicit.

Inspect the brief's proposed investigation and verify every contributing metric
against its report. Write down one concrete next action and which evidence would
confirm or reject it. A count increase alone does not demonstrate independent
adoption. Record when Pulse adds no useful insight; that is a product finding,
not a test result to suppress.

## Recovery and repeatability

Stop or wait for the pilot collector before `pulse export`. Use
[portable export/import](operations.md) or the
[D1 recovery drill](d1-to-sqlite-recovery.md), retain checksums and compare the
same fixed project/date window after importing into an empty database. The
comparison must cover source values, dimensions, methodology, coverage, warnings,
annotations and investigation evidence, not just total row counts. Generated-at
timestamps may differ; measurement semantics may not.

For the second-host gate, transfer the encrypted archive and configuration to an
independent supported host and provide secrets through the operator's existing
secret-management process. Do not copy an open SQLite database or put it on a
shared network filesystem. Start the dashboard without activating its collector;
verify authenticated access, Host/Origin checks, persistence after restart and
matching report evidence first. A cutover requires its own decision and rollback.

After separate approval of recurring collection, observe multiple actual refresh
cycles at the configured cadence. Record success, failure visibility, quota
cooldown and retained history; distinguish an upstream empty/limited response from
transport success. Synthetic clock advancement or several immediate manual runs
do not establish unattended reliability. Do not inject failures into production
accounts merely to exercise a test case.

## Minimal private acceptance record

Record the exact source revision, runtime and database profile, owner consent scope,
provider versions/instances, opaque resource IDs, date windows and timezones. For
each gate use `passed`, `failed`, `blocked` or `not_run`, with an observation time
and an evidence location. Also record the useful finding, rejected interpretations,
remaining unknowns, restore destination and whether any live schedule was enabled.

Keep external-user and independent-installation counts literal. A maintainer's
additional test account does not become a non-maintainer pilot. Broad production
readiness remains a separate decision from a single successful assessment.

See [validation levels](validation.md), [website authority](website-authority.md)
and [product direction](product-strategy.md) for the corresponding contracts.
