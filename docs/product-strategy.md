# Bronto Pulse product direction: evidence for independent software projects

Lifecycle: proposal

## The user problem

Maintainers of public libraries, independent developers and small engineering
teams have their signals spread between a Git forge, package registries, search,
website analytics and product instrumentation. A thousand downloads could mean
independent usage, an automated build, or repeated maintainer testing. A metric
dashboard may show each count accurately yet suggest a conclusion the evidence
cannot establish.

**The first customer is a technically capable owner of 1–20 software projects
who wants an honest private answer to what is being discovered, distributed,
used or maintained, without deploying another tracking pixel or buying a
developer-contact database.** The next audience is a small OSS program/team
that needs repeatable, auditable portfolio assessments.

Jobs to be done:

1. Identify which projects show _independent_ signs of interest, and explain
   what cannot be inferred from GitHub/npm counters.
2. Locate changes worth investigating, with exact source windows, sampling,
   confidence and incomplete coverage visible before a growth claim.
3. Compare website discovery, code distribution and product activity **without
   pretending to reconstruct a visitor journey**.
4. Retain that evidence privately, move the installation between machines,
   and provide stable read-only reports to operators and AI agents.

## Competitive boundaries

| Neighbor                             | Their strength                                                           | Pulse must do differently                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Umami, Plausible, Matomo, PostHog    | First-party website/product events, sessions, behavior, goals            | Connect their _existing_ aggregate outputs; no Pulse visitor SDK or session replay                                                               |
| Apache DevLake, GrimoireLab / CHAOSS | Engineering contribution, community health and delivery metrics          | Start with project discovery/distribution/adoption evidence; later import accepted engineering semantics rather than duplicating their pipelines |
| Scarf, Reo.dev                       | Package distribution, developer/company intent and commercial enrichment | Be open, low-cost and privacy-preserving; avoid identifying, enriching or selling individual developer accounts                                  |
| Airbyte and similar ETL platforms    | Large catalogue of extraction and loading connectors                     | Keep a small curated connector core with domain-specific metric definitions, and use external ETL for a governed long tail                       |
| Grafana, generic BI                  | Rich dashboards and time-series visualization                            | Maintain explainable source lineage, calendar/coverage rules, scoped comparisons and a deterministic investigation brief                         |

References: [DevLake](https://devlake.apache.org/),
[GrimoireLab](https://chaoss.github.io/grimoirelab/),
[CHAOSS metrics](https://chaoss.community/),
[Scarf](https://about.scarf.sh/),
[Reo](https://www.reo.dev/),
[Airbyte](https://airbyte.com/),
[Umami](https://umami.is/),
[Plausible](https://plausible.io/),
[PostHog](https://posthog.com/).

**Positioning:** "The private evidence layer for the software you build and
maintain." Scope it to **evidence-backed project intelligence**, not an
unbounded business intelligence suite, a universal usage score or an
individual tracking product.

## First useful portfolio story

A site measured by Plausible and Cloudflare, a library distributed via npm
and GitHub, and its Search Console property coexist in the same Pulse
installation. Pulse shows provider-native counts side by side and can answer:

- Which source has an observed, sufficiently complete change?
- Do two providers observing the same site disagree, and do they use comparable
  windows, timezones, dimensions and methods?
- Is package distribution rising while independent consumption remains unproven?
- Which source or permission would most improve the next assessment?

The default remains **no automatic cross-provider sum**, no inferred people,
no bot correction, no automatic disclosure of private reports.

## Architectural path and maturity

### Stage A — Portable source-aware foundation

A single-host Node/SQLite installation, explicit token authentication and an
opt-in external TLS proxy, alongside optional Worker/D1. Source-aware
observations, atomic publish, privacy constraints, versioned export and
restore already exist. Qualify the Compose build on a Docker-capable host
before calling the installation production-ready.

### Stage B — Curated connectors and semantics

Introduce an internal static connector manifest (discovery, auth mode, groups,
metrics, timezone and history). Add Plausible Stats v2 and Umami Cloud v3
as **account-unverified reference adapters**, with strict fixed-origin
outbound requests, import exclusion and non-additive daily audience metrics.
Keep API and configuration backward-compatible. Real credentials, site
permissions, rate limits and provider changes require separate account probes.
Do not dynamically load third-party code into a credential-bearing Worker.

A future connector SDK may expose `discover`, `probe`, `plan`, `collect`,
and versioned capabilities through an externally isolated process. First
validate what current adapters need rather than commit to a plugin protocol
before those examples work on real installations.

### Stage C — Evidence reconciliation

Introduce explicit `Project -> Website -> Package -> Repository -> Deployment`
relations. A project may declare a primary source per metric _and_ keep
alternative sources as independently observable comparators. Only compare
matching calendar, coverage, unit, aggregation and scope. Imported historical
sources require origin markers to prevent duplicate rollups. Add deterministic
"what changed / what is supported / what remains unknown" reports, not
LLM-generated causal assertions.

### Stage D — Scale and breadth

Replace round-robin scheduling with per-resource due dates, source-specific
quotas, backoff and failure visibility, retaining low-cost worker limits.
Keep a local SQLite profile for small installations. Add a PostgreSQL-backed,
multi-worker mode **only when a deployment/test case requires HA**. Kubernetes
and generic source URLs should not be accepted as complete merely because
a Compose profile exists. Custom outbound provider origins require a separate
SSRF, DNS rebinding, redirects, network egress and token-scope threat model.

Next integrations should be selected by real pilot needs: Bing Search,
CrUX performance, PyPI/crates, other Git forges, then Sentry/observability
or commercial sources. Avoid a directory of adapters that no one validates.

## Falsifiable milestones

A meaningful first external release has:

- Two independently installed private (non-Cloudflare) portfolios successfully
  restoring their data on a second host, with explicit supported limitations.
- Plausible and Umami collectors validated against consenting real accounts,
  including empty/sampled/limited responses, timezone and rate limit behavior.
- One reproducible report comparing two analytics providers on the same site
  without double-counting their observations.
- Three non-maintainer pilot users who can identify an actionable finding from
  Pulse that their provider dashboards alone did not reveal.
- Install, upgrade, recovery and security docs maintained alongside CI,
  rather than a speculative plugin catalogue.

These are **targets**, not achievements or usage claims.

## Decisions deliberately deferred

No user-tracking SDK, fingerprinting, contact or company enrichment, public
multi-tenant service, billing system, unrestricted SQL, automatic account
creation, automatic LLM decisions, event-level surveillance or auto-enabled
sources. No provider credentials in public source, error logs or CI.
