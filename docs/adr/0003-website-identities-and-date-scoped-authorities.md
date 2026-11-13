# ADR 0003: Website identity and date-scoped source authorities

Lifecycle: proposal

Status: Accepted for an optional, first-party pageview policy when implemented
and qualified. Future generic semantic models require a separate decision.

## Context

One software project may have multiple website analytics providers. Every
provider returns separate measurements, and project membership alone cannot
prove that their resource IDs observe the same hostname. A reporting layer
which automatically adds, selects or deduplicates those values would silently
create incorrect audience metrics.

The existing source-comparison API already requires an explicit same-site
operator assertion. That assertion must also be representable in reusable,
historically safe project configuration.

## Decision

- Store website identities in the existing validated, versioned private
  configuration. Each identity declares one exact hostname and its
  operator-approved whole-site analytics resources.
- Keep a bounded, sorted list of pageview source choices with effective dates.
  At most one can be active for an individual day. A report crossing a change
  refuses to calculate a combined total.
- Never substitute another source for an unavailable preferred source.
  Only an exact, complete, observed daily pageview series can become the
  preferred displayed period count.
- Surface all configured alternative sources independently and record the
  operator-declared nature of the identity. A preferred value remains
  provider-defined pageviews, never unique verified humans.
- Enforce no backdating or rewriting of prior source authority while
  historical data exists, using the existing store registration guard.
- Keep previous project configuration and report responses compatible if
  no explicit website policies are supplied.

- Once the owner explicitly binds separate analytics resources to one
  website, Pulse may use its existing strict pageview comparison contract
  to expose a descriptive alternative-minus-preferred difference. Only
  matching, complete, observed, non-sampled calendars and identical scopes
  qualify; otherwise the comparison is unavailable with a reason. The
  owner-declared identity is an assertion, not independent verification.
  Never infer corrected traffic or an automation percentage from a
  disagreement.

## Consequences

Cloudflare whole-site authority needs its resource hostname pinned. Page/path
attribution cannot impersonate whole-site totals. Plausible domain identifiers
must match the declared site. Umami IDs are opaque, so external verification
and possible mismatches remain operator responsibilities.

This feature does not create a metric-normalization formula, a tracker, a
new provider permission, a storage migration or a trusted host-discovery
mechanism. Each extension beyond pageviews must justify its own semantics,
historical change policy and security boundary.
