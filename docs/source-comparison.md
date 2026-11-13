# Website-source comparison without double counting

Lifecycle: current

## Why this exists

One website can be monitored by Cloudflare Web Analytics, Umami, Plausible
and other systems simultaneously. Their independently measured pageview
counts may disagree because of script execution, blocked requests,
sampling, calendar and methodology differences. **No single source can
establish how many human visitors were present merely from that
disagreement.**

Pulse keeps raw provider-specific cards. It does not merge visitor
identities, add cross-provider pageview totals, choose a hidden winner, or
subtract suspected bots. A read-only comparison is an investigation aid.

## Operator workflow

1. Open an authenticated project containing two Cloudflare, Plausible or
   Umami pageview resources. Select the exact report date range.
2. In **Compare website sources**, choose primary and secondary resources.
   Verify personally that they monitor the same site and intended pageview
   scope, then tick the acknowledgement.
3. Pulse checks source calendar, dimensions, path/hostname scope and
   observed daily coverage. Missing values cannot be silently zero-filled.
4. Only when both sources have one unambiguous, complete series of
   nonnegative, observed daily counts over identical dates in the same
   timezone will Pulse show secondary minus primary. The percentage is
   withheld when the primary baseline is below ten.

The comparison does **not** assert equivalence of the different providers'
tracking definitions. It is a side-by-side discrepancy, not a calibration
factor or a universal pageview count. Manual same-site confirmation
is ephemeral: it is not stored as a project property or treated as
independently verified identity.

## Read-only API

A signed-in owner can obtain the same result using:

    GET /api/v1/projects/<project>/source-comparison?from=2026-10-12&to=2026-10-13&primary=analytics_cf&secondary=analytics_um

Without "same_site=confirmed", the API returns
"status: needs_confirmation" and leaves "difference: null".
After the operator explicitly establishes same-site scope, append:

    &same_site=confirmed

Responses are private and use Cache-Control: no-store. The result has
schemaVersion 1, status, two source descriptors, a difference
or null, reasons, and an interpretation limit. When the two
datasets are sampled, missing, partial, differently scoped, differently
timezoned or not daily, the result is incompatible or unavailable
with a reason. No provider API call, database write, new credential,
refresh job or cross-source session collection is triggered.

Same-site confirmation is not authorization: the standard signed session
or API bearer token is still mandatory. The API validates both resource IDs
and rejects the same ID being compared with itself.

## Boundaries and next improvements

This initial surface compares only _pageview counts_. Source identities
are operator-confirmed, not persisted in a site registry. Project-level
canonical source selection, quality dashboards, backfill/alert policies and
cross-metric explanations are later features. Do not infer organic
conversion or product funnels from these descriptive discrepancies.

For the metric and collector contract, see [metrics](metrics.md),
[provider adapters](connectors.md) and [reports](reporting.md).
