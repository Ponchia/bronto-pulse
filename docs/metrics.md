# Metric contracts

Lifecycle: current

The executable registry is `src/model.ts`. Every card carries its metric key,
unit, source, methodology, timezone, aggregation rule and data-quality notes.
Daily buckets retain their provider timezone. A portfolio has no universal
adoption score or sum of unique people.

| Type                   | Valid operation                                          | Invalid inference                |
| ---------------------- | -------------------------------------------------------- | -------------------------------- |
| Daily event counts     | Sum non-overlapping periods within the same source scope | Convert downloads into humans    |
| Unique viewers/cloners | Show each source day                                     | Sum days into monthly uniques    |
| Stars/forks            | Last available snapshot                                  | Treat a snapshot as a daily flow |
| Referral/path top ten  | Inspect exact rolling window                             | Sum overlapping 14-day snapshots |
| CTR                    | Sum clicks / sum impressions in identical scope          | Average daily percentages        |
| Search position        | Impression-weighted numerator / denominator              | Unweighted average of averages   |
| p75 performance        | Show per-source-period percentile                        | Average percentiles across days  |

## Coverage

Confirmed zero is a numeric observation with value zero. A missing bucket is
unavailable. Other quality flags are provisional, sampled, top-N and
provider-limited. An HTTP 200 response is not sufficient evidence of success:
GraphQL errors, changed response windows and unfinished pagination fail closed.

A card with partial coverage may show a sum over observed buckets, explicitly
labeled partial; it is not a complete period total. Comparisons require the
same source, dimensions, methodology, timezone, duration and complete coverage.
Relative growth is withheld for small baselines. Annotations provide context,
not causal explanations.

## Shared sites and canonical search URLs

Page-scoped Cloudflare reports use pageviews, not fabricated per-project visits.
Search totals are queried separately from canonical-page and query breakdowns.
Country/device/query cross-products are not automatically collected. Query text
is opt-in because even aggregate search terms can contain personal information.
URL query strings and fragments are stripped before durable storage. When this
collapses page variants, counts and weighted numerators/denominators are combined
according to their explicit metric rule, never by averaging percentages.

Referrer reports preserve the provider's top-N limit. Absence from a top-N list
is not a confirmed zero. Empty responses similarly do not imply that no one
visited a project. The history begins when a metric can be collected; stars,
clones and visits are never backfilled with invented values.
