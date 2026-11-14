# Reports, briefings and private exports

Lifecycle: current

## Read the value with its contract

Each metric card identifies its resource, unit, source timezone, methodology,
project scope, observed dates, quality flags and latest collection timestamp.
`value: null` means that a period aggregate is unavailable or inappropriate;
it is not zero. `latestValue` can still represent a single observed bucket.

Complete date coverage and high-quality data are different things. A sampled
series can contain every date and still not represent an exact population.
Provisional, sampled, top-N or provider-limited values remain visible, but the
briefing withholds unqualified growth comparisons for them.

For ordinary counts, comparisons require complete observations in both full,
equal-length windows, identical metric dimensions and methodology, and no
mapping boundary that shortens either interval. Small baselines use absolute
change only. Unique counts and daily percentiles never receive period sums.

Snapshot metrics such as stars use **net change between two dated snapshots**,
not gross new stargazers. Both snapshots must be close enough to their requested
period end under `staleAfterHours`. The report records the actual baseline date;
missing snapshot days are not falsely marked as daily coverage.

## Briefings

`pulse brief PROJECT` produces a deterministic evidence summary. Omitting the
project produces independent briefings for the portfolio, not a portfolio-wide
adoption score. The same result is available from the private API and dashboard.

Coverage problems are presented first, followed by quality limitations and
supported changes. Findings carry metric IDs, methodology, timezone and exact
comparison dates in JSON. No language-model call or external service is used.
Release annotations are context only, never proof that a release caused a change.
A default limit of 20 findings is explicit; omitted findings remain accessible
through the full project report.

Each briefing also carries an `investigation` object: leads to verify, derived
from the same report. A lead has a stable reason ID, references to the
resource, metric and dates it restates, its limitations and up to three next
checks from a closed catalogue. Leads state no cause, score or audience
estimate, and unavailable evidence is never reported as zero. The Markdown
briefing prints them under **What to verify next**. See
[investigation leads](investigation-leads.md) for the reason catalogue, the
bounds and the read-only project resource map.

A change is restated, as a finding or as a lead, only when the comparison
agrees with the series that carries it. A summed daily count must be complete,
observed and equal to the sum of its daily values.

## Export formats

```sh
pulse report PROJECT --format json --out /private/report.json
pulse report PROJECT --format csv --out /private/report.csv
pulse brief PROJECT --format markdown --out /private/brief.md
```

`--json` is a convenience alias; it cannot be combined with a conflicting format.
CSV is a long-form metric-card table, not a flattened visitor dataset. It retains
null values, observed/expected date counts, source scope and comparison reasons.
Text cells that could be interpreted as spreadsheet formulas are prefixed as
text; embedded delimiters and newlines are quoted. Numeric changes remain numeric,
including negative values. This is not permission to publish private report data.

CSV also preserves the exact series key, provider, JSON dimensions, last collection
instant, actual comparison baseline dates and the fractional relative change.
Each metric row carries `data_kind` (`synthetic` or `collected`), generation time
and JSON report warnings so a downloaded demo cannot lose its synthetic label.
These provenance columns are appended after the existing columns; existing
column positions remain unchanged. Read column names rather than assuming a fixed
column count. CSV still contains metric cards, not every breakdown, annotation or
investigation; use JSON for the complete report.

## Exact input selection

The CLI refuses options that have no effect for the selected command, repeated
options and extra positional arguments before opening its database. For example,
`report PROJECT --provider npm` and `export --resource ID` are errors, rather than
reports or backups that silently include more than requested. Numeric options use
positive decimal integers. `--days` selects 1–366 completed dates and may combine
with `--to`; use explicit `--from`/`--to` instead of combining `--days` with `--from`.
Malformed, missing or over-budget import JSON is rejected before a new destination
is created. Semantic archive validation and atomic empty-database import remain
separate storage checks.

Reports and briefs are **not database backups**. `pulse export` includes the
recovery catalog and published history; restore it with `pulse import` into an
empty database. See [operations](operations.md) for an independent restore drill.

## Browser behavior

The dashboard retains selected dates, project and view in its URL. A reload
reopens that view without storing tokens in browser storage. Browser Back and
Forward move between projects and views; refreshing or changing the dates updates
the current entry. Additional investigation leads open in place with their source
limits, keyboard focus and an explicit display cap. A failed refresh
removes the old data from the export action; the UI never offers an old report as
though the failed new request had succeeded. Collection plans in the browser are
read-only previews. Actual collection remains an explicit CLI or scheduler action.

## Opt-in website source comparison

Projects with two web analytics pageview resources can use the dashboard's
read-only **Compare website sources** control. It requires operator
same-site confirmation and rejects mismatched dates, timezones, scopes,
sampled/partial observations and ambiguous series before showing a
descriptive difference. No pair can become a combined visitor count.
See [Website-source comparison](source-comparison.md) for the API contract
and limits.

## Portfolio read snapshots

Portfolios requiring at most 40 distinct SQL reads use a single transactional
read batch. The request-local snapshot preserves the existing per-source row
limits, coverage and inspection rules; it does not cache reports across users
or requests. Snapshot writes and reads outside the prepared scope are refused.
Larger portable installations keep the existing per-source read path rather than
silently omitting sources. This reduces network round trips, not a guarantee of
Workers Free CPU qualification; deployment CPU must still be observed.

## Adoption quality

Reports expose an additive `evidence` object and an `evidenceClass` on each metric
card. Briefings keep the same evidence object even when their findings are capped.
CSV includes `evidence_class`, `independent_adoption` and `metric_caveat`. The
dashboard and Markdown reports show the interpretation boundary before counts.

Distribution, discovery, activity, interest, maintenance and performance have
different meanings. `humanAudience`, `independentAdoption` and `automatedShare`
remain `not_measured`: neither high download counts nor a named referrer resolve
those unknowns. No heuristic subtracts observations or relabels them as humans.
See [adoption-quality review](adoption-quality.md) for the exact signal thresholds,
external-evidence checks and the monthly scorecard procedure.
