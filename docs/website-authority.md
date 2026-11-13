# Declared website identity and pageview source authority

Lifecycle: current

Pulse preserves provider-native web analytics metrics. Cloudflare, Plausible and
Umami may all observe the same website, but their reported pageviews and
daily audience measures are **not additive** and may legitimately disagree.

An optional website policy now records the **operator's assertion** that
several analytics resources observe a single hostname, and which one
should be considered the preferred source of pageviews for a given date.
This metadata is not website-ownership verification, an authentication
grant, an instruction to install an analytics beacon, a bot classifier or a
permission to deduplicate visitors.

## Opt-in project configuration

Within a project's resource bindings, declare an optional websites array.
Each website has a stable ID, a canonical hostname, a set of already-bound
website analytics resource IDs and an optional effective-dated list of
preferred sources.

```json
{
  "projects": [
    {
      "id": "my_project",
      "label": "My project",
      "resources": [
        { "resource": "cf_site" },
        { "resource": "pl_site" },
        { "resource": "um_site" }
      ],
      "websites": [
        {
          "id": "primary_site",
          "hostname": "example.org",
          "sources": ["cf_site", "pl_site", "um_site"],
          "pageviewsAuthority": [
            { "resource": "cf_site", "effectiveFrom": "2026-11-13" },
            { "resource": "pl_site", "effectiveFrom": "2026-12-01" }
          ]
        }
      ]
    }
  ]
}
```

The rest of the installation config continues to declare those resources and
their read-only connections in the normal way. This is an illustrative
project fragment, **not** an entire config file or a deployment instruction.

- IDs and exact hostnames must be unique within the project. A resource may
  describe only one website there; duplicate or unknown resource IDs fail
  configuration validation.
- All referenced resources must already be bound to this project and must be
  one of Cloudflare RUM, Plausible or Umami. The resource cannot be scoped to a
  path. This is a whole-site source policy.
- Cloudflare requires a resource with an explicitly pinned hostname, a
  whole-site totals group and an unscoped project binding. Its existing
  path-attribution groups cannot become whole-site authoritative totals.
- Plausible's site domain must match the declared hostname exactly. Umami
  website IDs are opaque; the operator's mapping is an explicit assertion,
  not independent verification of where its beacon is installed.
- Source authority entries must be sorted by strictly increasing dates,
  reference a declared website resource, and represent actual changes.
  An omitted policy means **no preferred source**, not a missing zero.

## Interpreting a report

Private project JSON, Markdown and capped briefings include a website
policy section only when the project declares one. The dashboard shows the
preferred provider **beside** the alternative sources.

- **Ready:** one preferred source is active for the whole requested period
  and its daily values are complete, observed and numerically consistent.
  The displayed number is that provider's pageviews, not an independently
  verified visitor count.
- **Not selected:** no preference is effective for the requested dates.
  Pulse does not pick the provider with the largest count.
- **Changed during period:** a policy switch falls inside the requested
  window. Pulse refuses to splice two providers into a single total. Narrow
  the report to periods on either side of the switch.
- **Unavailable:** the declared preferred resource has missing dates,
  sampling, conflicting series, or no suitable data. Pulse does not
  silently substitute another provider or promote a partial subtotal.

Alternative provider values retain their own coverage and timezone. To
calculate a descriptive difference between them, use the explicit
source-comparison workflow, which additionally checks the date calendars,
dimension scopes and data quality. Even an apparently matching time series
does not establish that two analytics providers count equivalent events.

## Descriptive differences for declared sources

When the owner has declared multiple providers under the same website,
Pulse can evaluate their existing pageview measurements _against the chosen
preferred provider_. This uses the same strict compatibility gate as the
separate manual source-comparison endpoint. The owner-declared website policy
provides the explicit same-site assertion for these reports; merely appearing
under the same project is still insufficient.

For every alternative source, the private website-policy section reports:

- **Side by side:** both sources have exactly one complete, observed,
  non-sampled daily pageview series for the same requested dates with
  matching calendar timezone, scope and dimensions. Display _alternative
  minus preferred_ as an absolute difference. The percentage is withheld
  when the preferred baseline is below ten pageviews.
- **Incompatible:** calendars, scope, coverage, quality, or daily evidence
  prevent a safe descriptive calculation. Show a reason, not a numeric
  difference. A partial or sampled source is never silently adjusted.
- **Unavailable:** the chosen alternative has no unambiguous pageview
  series. Keep the original source in the alternatives list, without a
  fabricated zero.

No comparisons are calculated if no preferred source is effective, the
policy changes inside the reporting window, or the preferred source itself
fails its evidence checks. In all cases the underlying provider cards remain
visible and unmodified.

**A difference is not a corrected pageview count, audience estimate,
bot proportion, missing traffic, or evidence that the preferred provider
is correct.** Different instrumentation may count different events.
No anomaly threshold, automated bot classification, or person-level
reconstruction is introduced. The private UI shows the descriptive
difference and exact compatibility reasons without contacting any
provider or adding another collector job.

## Historical safety

A new policy cannot retroactively designate a source for already published
history. Start its first effective date on or after the configuration change.
Once a site is declared and observations exist, keep its stable ID, hostname,
and previously referenced source membership. Add new sources without
removing earlier ones, and add future authority transitions with new dates.

Changing an already-effective source choice, deleting a previously declared
website, or moving an existing source into another website can change the
interpretation of past reports, so those mutations are refused by the normal
historical configuration guard.

This feature adds no D1 tables, no provider API calls, no tracking code and
no migration of stored events. Old projects without websites retain their
existing API and reporting shape. The declared preferences are part of the
private, versioned configuration already included in exports and backups.

## Next layer

This initial policy is intentionally limited to **pageviews**. A larger
semantic model could extend explicit sources of authority to package
distribution, search discovery or product activity after their comparison
contracts are defined. Do not label daily provider uniques or sessions as
period-wide unique people.

A supported cross-source system must keep authoritative source preference,
raw provider observations, source comparison, and user inference separate.
