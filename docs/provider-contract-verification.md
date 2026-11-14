# Analytics provider contract verification

Lifecycle: current

Pulse's Plausible and Umami adapters are reviewed against provider documentation
and pinned source, as well as synthetic fixtures. This is stronger than an
invented payload shape, but is not proof of access to an owner's account, a
successful external pilot, or unattended operational reliability.

## Umami daily granularity

The reviewed upstream version is Umami **v3.5.0**, commit
`d3c62a805beda8643cb468924dda38617fb4c286`. Its request normalization checks the
requested time unit against allowed units. For sufficiently long ranges it can
replace `day` with a larger unit. A month-start label can look like a valid daily
date even when its count represents the whole month.

Pulse therefore limits each Umami request to **31 UTC calendar days**.
Larger collection windows are split into contiguous non-overlapping requests.
This is a conservative bound inside the reviewed daily-unit behavior, not a claim
that the provider's exact daily limit is 31 days. Every response is checked
against its own slice; a date from another slice is rejected even when it lies
inside the outer collection window.

The slices retain the same request, byte and normalized-row budgets. No cursor,
quota bypass or new background request is introduced. All slices belong to the
same collection run. Failure of any slice aborts publication of the entire run,
leaving the previous successful history intact. Large windows may need narrower
explicit collection plans when their request budget is too small.

Empty days stay absent. Pulse does not turn a successful empty response into zero
pageviews. The normal lookback is shorter than 31 days, so its request count is
unchanged.

## Umami's sessions field

The pageviews endpoint returns `pageviews` and `sessions`. In the reviewed
upstream SQL, the latter counts distinct session identifiers. Umami describes
these identifiers as its visitor measure; a session may contain multiple visits.
It is not the provider's visit count and does not identify verified people.

For archive and consumer compatibility, Pulse retains the historical metric key
`umami.sessions_daily`, its `sessions` unit, and non-additive aggregation. Its
caveat and collection notes explain the underlying visitor/session identifier
semantics. No stored measurement is renamed, rescaled or rewritten.

## Plausible's executed-query echo

Stats API v2 returns the query actually executed after provider normalization.
When an echo is present, Pulse validates the site, ordered metric names, daily
dimension, whole-site scope, import exclusion, result-page offset/limit and date range.
A contradiction fails the run before any observations are published. In
particular, reordering `visitors` and `pageviews` must not silently swap values.

A timestamp range must describe whole days in the configured reporting timezone.
Both UTC-normalized and local-offset ISO timestamps are accepted when they name
the same boundaries. Calendar-boundary checks account for daylight-saving
changes rather than assuming every local day lasts 24 hours. A nonzero fractional
start is rejected even below JavaScript timestamp precision; the executed result
limit, when supplied, must match the requested truncation sentinel. Date-only echoes
remain accepted; they do not independently verify the declared timezone.

The metadata `imports_included` must be false when supplied. A supplied
`total_rows` must be a nonnegative integer consistent with the returned results;
remaining rows produce an explicit row-limit failure rather than partial history.

Responses without a query echo remain compatible with earlier fixtures and
provider variants. That absence is not independent site or timezone verification.
The adapter does not request broader permissions, read site settings or retain
raw query/filter text to obtain that verification.

## Reproducible checks

`tests/provider-query-contracts.test.ts` exercises contradictory query echoes,
calendar boundaries including a DST transition, truncated metadata, daily query
slices and budget failures with synthetic data. Existing connector and native
runtime checks still apply. These tests contact no live provider accounts.

The first consenting account check must still compare exact provider-native
counts for matching dates and timezone, including an empty day. Follow the
[private pilot acceptance](pilot-acceptance.md) gates and record the actual
upstream version separately from the Pulse revision.

## Primary references

Verified on 14 November 2026:

- [Plausible Stats API v2](https://plausible.io/docs/stats-api): response query,
  metric order, date ranges, time dimensions and metadata.
- [Umami v3.5.0 request normalization](https://github.com/umami-software/umami/blob/d3c62a805beda8643cb468924dda38617fb4c286/src/lib/request.ts).
- [Umami v3.5.0 allowed units and minimum unit](https://github.com/umami-software/umami/blob/d3c62a805beda8643cb468924dda38617fb4c286/src/lib/date.ts).
- [Umami v3.5.0 session statistics](https://github.com/umami-software/umami/blob/d3c62a805beda8643cb468924dda38617fb4c286/src/queries/sql/sessions/getSessionStats.ts).
- [Umami metric definitions](https://docs.umami.is/docs/metric-definitions) and
  [sessions](https://docs.umami.is/docs/sessions).
