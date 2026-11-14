# Investigation leads and the project resource map

Lifecycle: current

A briefing answers "what changed". An investigation lead answers "what should
I check, and where". Each lead restates values already in the project report,
says what those values cannot show, and names up to three places to verify it.
Leads are computed by `investigateProject` in `src/investigations.ts` and are
returned in the `investigation` object of every briefing.

Leads never filter, correct or add counts. They state no cause, forecast,
score, confidence number or audience estimate, and they classify no request
as human or automated. An absent lead does not certify complete or authentic
data.

## Shape of a lead

| Field                         | Meaning                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`                          | Reason, resource and a hash of the series. Stable across runs, periods and values.                             |
| `reason`                      | One identifier from the catalogue below. Renaming one is a breaking change.                                    |
| `evidenceState`               | `unavailable`, `partial`, `limited` or `observed`: how much published evidence stands behind it.               |
| `resourceId`                  | The configured resource. Empty when the lead concerns a declared website rather than one resource.             |
| `summary`                     | One fixed-template sentence built from IDs, dates, metric labels and counts.                                   |
| `evidence`, `omittedEvidence` | Up to eight references: resource, metric, `seriesKey`, the dates described and the facts restated.             |
| `limitations`                 | Up to four statements of what the evidence does not establish.                                                 |
| `nextChecks`                  | Up to three checks from a closed catalogue, each with a surface, a resource and dates.                         |
| `subject`                     | The resource's declared kind, identity and enabled flag. Present only when a project resource map is supplied. |

`seriesKey` equals `MetricCard.key` in the full report when exactly one
matching series exists, so a lead can be traced to its daily points. A fact
that the report does not hold is `null`. It is never replaced by zero.

Provider-supplied text, such as a referrer name, appears only as a bounded
evidence fact with control characters removed. It never appears in a summary
or a next check.

## Reason catalogue

Leads are returned in this order. Evidence barriers come first because they
decide whether a later change can be read at all.

| Reason                                        | Raised when                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `coverage.series_unavailable`                 | A series has no published observation in the requested dates.                          |
| `coverage.dates_missing`                      | A daily series lacks some requested dates. Snapshots are not daily series.             |
| `quality.values_not_final`                    | A series carries provisional, sampled, top-N or provider-limited values.               |
| `website.preferred_source_unavailable`        | A declared preferred pageview source lacks complete observed daily data.               |
| `website.preference_changed_in_window`        | The declared preference changes inside the requested dates.                            |
| `website.no_preferred_source`                 | A declared website has no preference for the requested dates.                          |
| `website.sources_not_comparable`              | A declared source and the preferred source do not match in dates, calendar or quality. |
| `website.sources_differ`                      | Two comparable declared sources report different pageviews for the same dates.         |
| `concentration.activity_window`               | The report's `concentrated_activity` review signal is present.                         |
| `attribution.site_referrer_rows_concentrated` | The report's `concentrated_site_referrers` review signal is present.                   |
| `attribution.referrer_snapshot_concentrated`  | The report's `concentrated_referrers` review signal is present.                        |
| `attribution.referrer_missing`                | The report's `unattributed_referrer` review signal is present.                         |
| `interpretation.review_signal`                | The report carries a review signal this module does not yet describe.                  |
| `change.period`                               | A supported non-zero change against the preceding equal-length period.                 |
| `change.small_baseline`                       | The same, for a summed count whose baseline is below 10. No percentage is stated.      |
| `change.snapshot_net`                         | A supported non-zero net change between two dated snapshots.                           |
| `comparison.baseline_unavailable`             | A complete, observed dated series has a current value but no comparable baseline.      |
| `comparison.snapshot_baseline_unavailable`    | A snapshot has a current value but no supported net change.                            |

The thresholds behind the review signals are defined in
[adoption-quality review](adoption-quality.md). The website statuses come from
[website identity and authority](website-authority.md) and
[website-source comparison](source-comparison.md). This module restates those
decisions and does not recompute them.

A change is restated only when the comparison agrees with the series that
carries it. Both values must be finite, their difference must equal the
recorded change, the baseline must be dated and every value must be observed.
A summed daily count must also pass the strict daily count gate in
`src/evidence-compatibility.ts`. A sampled, partial or inconsistent series
therefore produces no change lead and no change line in the briefing.
Snapshots and ratios keep the report's own comparison rules.

## Next checks

A next check is a place to look, never a command, a link or advice. Its
`surface` is one of `pulse_health`, `pulse_plan`, `pulse_report`,
`provider_console` or `configuration`. Its `resourceId` and `window` tell you
which resource and dates to open there. The text comes from a fixed template.

A check appears only when there is something to read. A lead suggests the
recorded annotations only when at least one annotation for that resource falls
inside the dates described, and it reports the count as context, not as a
cause.

A snapshot that was not taken cannot be collected afterwards. A lead about
snapshots alone therefore never points to the collection plan, and it says so
in its limitations.

When the project resource map shows that collection for a resource is disabled,
its coverage and comparison leads state that first and ask you to confirm the
setting before any collection check.

## Bounds

`pulse brief` and the private API return at most 20 leads per project, the
same limit as the briefing's findings. A library caller can request up to 100.
`omittedFindings` counts the rest. Each lead holds at
most 8 evidence references, 4 limitations and 3 next checks, and lists at most
7 missing dates beside the full count. The Markdown briefing prints the leads
under **What to verify next**. A limitation shared by several leads is printed
once, with the first lead that carries it.

The dashboard shows five leads for a project and three per project in the
briefing view, with a count of all leads. **Show all leads** opens the rest in
place and moves keyboard focus to the first newly shown lead. Leads the report
did not list are requested once, for the same project and the same dates as
the report on screen, up to 100. Beyond 100 the dashboard states how many
remain; it lists none of them and drops none from the count. If that request
fails, the leads already shown stay, the panel says so and the control can be
pressed again. Each lead keeps its own limitations under **Source evidence and
limits**.

## Project resource map

`projectGraph(config, projectId)` in `src/project-graph.ts` is a read-only
projection of validated configuration. It adds no configuration field, reads
no database and writes nothing.

| Element      | Source in configuration                   | Contains                                                             |
| ------------ | ----------------------------------------- | -------------------------------------------------------------------- |
| Resource     | `resources[]` bound by the project        | Provider, kind, label, enabled flag, declared identity and bindings. |
| Website      | `projects[].websites[]`                   | ID, hostname, declared sources and dated pageview preferences.       |
| Relationship | Project bindings and website declarations | Type, endpoints, provenance and effective dates.                     |

A resource kind is `repository`, `package`, `website_analytics`,
`search_property` or `product_events`. Its identity is the repository name,
package name, hostname or search property that the operator wrote. The basis
is `config_pinned_id` when a GitHub repository ID is also pinned, and
`config_declared` otherwise. Neither value verifies ownership or control.

The four relationship types are `project_measures_resource`,
`resource_shared_with_project`, `resource_reports_website` and
`website_prefers_pageview_source`. A package and a repository with the same
name stay unrelated, because no relationship is inferred from a name. The map
has no deployment, ownership or publication relationship, because
configuration declares none.

The map omits connection IDs, credential environment names, and account,
site-tag, database, website and numeric repository identifiers.

When a caller passes the map to `projectBrief`, the briefing gains a
`resources` object and each lead gains a `subject`. A lead on a resource that
is explicitly shared with other projects also states that its values must not
be added across projects.

## Synthetic acceptance

This check uses the synthetic evidence demo. It needs no provider account,
credential or network access, and it proves nothing about a real site.

1. Seed the demo and print the Sense6 briefing:

   ```sh
   npm run demo -- --scenario evidence
   npm run pulse -- brief sense6 --days 28 --format markdown \
     --config .pulse/demo-evidence.config.json \
     --db .pulse/demo-evidence.db
   ```

2. Under **What to verify next**, confirm these two leads:
   - `website.sources_differ` states that `sense6-umami` reports fewer
     pageviews than the preferred source `sense6-rum` for the same dates.
   - `website.sources_not_comparable` states that `sense6-plausible` is not
     compared, and its checks point to each provider's reporting calendar.
3. Confirm that no lead adds two providers together, names a cause or
   estimates an audience.
4. Run the automated form of the same acceptance:

   ```sh
   node --import tsx --test tests/investigations.test.ts tests/project-graph.test.ts
   ```

Neither lead is visible in one provider's dashboard, because each needs two
sources side by side under a declared website identity.

## Pilot preparation

No pilot with a real user has been run. The product direction asks whether a
non-maintainer can find an actionable finding that a provider dashboard alone
did not reveal. Use this private procedure when a pilot user volunteers.

1. The pilot user collects their own data into their own private installation.
   Do not copy their configuration, reports or briefings into Git or an issue.
2. They request a briefing for a complete period of at least 28 days.
3. For each lead they record, in a private log: the reason ID, whether their
   provider dashboard already showed it, what the next check found and whether
   they acted on it.
4. They also record each lead that was wrong, unclear or not worth the check.
5. Count a lead as useful only when the pilot user says so. Report the number
   of leads raised, checked and judged useful, with the period and the sources.

A pilot result describes one installation. It is not evidence of adoption.

## Known limits

- The report CSV does not include leads. The briefing JSON and Markdown do.
- A failed refresh is reported as a collection note in the briefing, not as a
  lead, because the report carries it as text rather than as structured data.
- A refused website comparison carries its first stated reason as an evidence
  fact. The lead does not branch on that text.
- Leads cover one project. There is no portfolio-wide lead and no total across
  projects.
