# Adoption-quality review

Lifecycle: current

## What Pulse can establish

A package download, repository clone or release-asset request is distribution.
A pageview or search impression is discovery. Anonymous product event totals
are activity. Stars and forks are interest snapshots, not endorsements from a
verified independent audience. Open issues include pull requests and describe
maintenance; field performance measurements describe performance.

The report's `evidence` object deliberately leaves independent adoption, human
audience and automated share unmeasured. A lack of evidence is not zero users.
These provider aggregates cannot reliably divide requests into humans, CI,
maintainer testing and crawlers. A referrer is not an authenticated identity.
Do not maintain a domain blacklist as a substitute for that missing evidence.

Raw counts, observation quality, snapshots, historical bindings and comparison
rules are unchanged. No cross-source total, corrected count or person-level
conversion funnel is created. In particular, release checksums and signatures
remain separate named assets rather than being presented as package installs.

## Deterministic review signals

`concentrated_activity` requires a complete requested window of at least 28 days,
only observed daily points, at least 100 counted events and one consecutive
seven-day block containing at least half of that period's count. It operates on
one metric card, preserving its dimensions, source scope, timezone and methodology.
Missing dates, partial mappings, provisional/sampled rows, ratios, snapshots and
non-additive metrics cannot establish this signal. Its exact period and thresholds
are included in `evidence`. This flags concentration, not its cause, artificiality
or statistical significance; it does not claim that the comparison is false.

`concentrated_referrers` requires at least ten views in the newest returned GitHub
top-referrer snapshot and at least 80% of that returned list attributed to one
referrer. Older overlapping snapshots are not added. The denominator is the
returned top list, never all repository traffic. Duplicated referrer dimensions
or non-top-N rows do not establish this signal. Domain names are evidence fields,
not classifications. A single automated-looking source still needs corroboration.

`unattributed_referrer` marks positive website pageviews with an empty referrer.
Unknown attribution is not proof of a direct visit or of a human visitor.

These thresholds are explicit review heuristics, not a calibrated classifier.
Small counts and absent flags do not certify authentic adoption. Review signals
are inspectable in JSON and in the human-readable briefing; findings limits cannot
remove the top-level unmeasured-adoption boundary.

## Check independent usage separately

Keep a private, dated evidence log with the search scope, exact query, result
limit, source URL and inspected revision. For a dependency match, inspect the
actual manifest and import or integration: documentation examples, lockfile-only
references, forks and mirrors are weaker evidence than an independently maintained
consumer. Label maintainer-owned or affiliated consumers explicitly. A verified
consumer still does not establish its number of users or production usage.

Use read-only public repository search and public package metadata. Record
truncation, unavailable indexing, access failures and ambiguous affiliation.
A completed search with no result means **no evidence found in that search**,
not that private or unindexed consumers do not exist. Do not contact developers,
create marketing issues, or add telemetry as part of this review.

## Monthly scorecard

Use complete, equal-duration source windows, preserving each provider's timezone
and publication lag. Record snapshot capture time and last successful collection
separately from the observed dates. The first 30 observed days are a baseline;
30-day growth needs a second comparable 30-day window. Do not call seven days of
RUM history a monthly total or project provisional npm buckets into a trend.

Keep four separate sections: package distribution; repository interest and
verified independent-consumer evidence; website discovery; product activity.
Carry coverage, source limitations and review signals beside the figures. Show
rolling GitHub referrers once, by exact source period. Break out release packages,
checksums and signatures by asset rather than adding them as adopters. Attribute
neither a spike to a launch nor a decline to UX without additional evidence.

Reports and the review log are private. Scheduling and installing changed
collection configuration are explicit operator actions, not effects of this
reporting module. History-safe rollback retains new resources and bindings with
collection disabled rather than deleting their catalog entries.

## Provider references

- [GitHub traffic definitions](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository)
- [npm download-count API](https://github.com/npm/registry/blob/main/docs/download-counts.md)
- [Search Console aggregation and omissions](https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data)
