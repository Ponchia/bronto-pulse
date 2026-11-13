# Evidence-first synthetic portfolio demo

Lifecycle: current

This optional scenario demonstrates why Pulse is a source-aware evidence system
rather than another website visitor tracker. It requires **no provider
accounts, API keys, SaaS plan, Cloudflare Worker or network access**.

Run from a source checkout with Node 24.15+:

```sh
npm ci
npm run demo -- --scenario evidence --serve
```

The CLI creates an ignored local SQLite database at
\`.pulse/demo-evidence.db\` and a private configuration at
\`.pulse/demo-evidence.config.json\`. It binds the dashboard to
\`127.0.0.1:4177\` by default, printing an ephemeral reporting token.
Open the printed local URL and use that token to sign in. The dashboard
is marked **SYNTHETIC DEMO** and must not be mistaken for production
measurements. It does not send or receive real visitor information.

This is independent of the original \`npm run demo -- --serve\` scenario.
The standard demonstration still has the same four projects and resources
and uses \`.pulse/demo.db\`. You can reset either **synthetic** installation
without affecting the other. Never mix either demo with a live Pulse
database.

## What to examine

Select the **Sense6** project and a 28-day period. You will see:

- Anonymous synthetic test-start and test-completion counters, which cannot
  identify participants or provide a person-level conversion rate.
- A declared website identity \`sense6.example.org\` with Cloudflare RUM
  as the date-scoped preferred source of website pageviews.
- A synthetic Umami time series reporting fewer pageviews for the same UTC
  dates. Pulse displays its descriptive _alternative minus preferred_
  difference and the comparability conditions, **not** a corrected visitor
  count or a suspected-bot percentage.
- A Plausible series using the \`Europe/Madrid\` reporting timezone. Pulse
  refuses to calculate a daily percentage against Cloudflare's UTC series,
  and explains that the calendar scopes differ.
- Every raw provider metric in its own card. It never adds Cloudflare,
  Umami and Plausible pageviews together or sums daily visitors/sessions
  into monthly unique people.

Other projects preserve the existing lessons about GitHub repository
traffic, npm package distribution, path-scoped shared sites and
Search Console impressions/clicks. Those are signals about different
aspects of a software project, not automatically one customer journey.

The scenario intentionally uses synthetic resource identities, a
fictional website and fake credential-environment **names**. No
credential values are included. It never attempts to authenticate to,
contact or modify Plausible, Umami, GitHub, npm, Search Console,
Sense6 or Cloudflare. The regular demo has the same network boundary.

A repeatable synthetic browser acceptance runs the **actual** evidence
demo on a separate local port and checks both narrow-screen and desktop
presentation, including the no-external-request boundary:

```sh
npm run test:browser:evidence
```

The test uses an isolated ignored SQLite database, a synthetic login
token, and Playwright. It does not ask for real credentials.

## Offline CLI review

Instead of starting a dashboard:

```sh
npm run demo -- --scenario evidence
node dist/cli.js report sense6 --days 28 --format json \
  --config .pulse/demo-evidence.config.json \
  --db .pulse/demo-evidence.db
node dist/cli.js brief sense6 --days 28 --format markdown \
  --config .pulse/demo-evidence.config.json \
  --db .pulse/demo-evidence.db
```

After building (\`npm run build\`), those commands read the existing
synthetic SQLite snapshot without making provider requests. The report
includes \`websites\` with a preferred source, alternatives and
\`comparisons\` showing compatible versus incompatible series. The
briefing retains the website decision even when other findings are
truncated.

The fixture generates 60 completed UTC days, while the Plausible
source declares a different reporting calendar. Data-quality values
and time windows are deliberately controlled to demonstrate the
interpretation contract. A measured disagreement in a live site may
also reflect blockers, different instrumentation or actual audience
behavior; this demo does not distinguish those causes.

## What this proves—and what it doesn't

This demonstration proves that the same private UI, API, storage and
reporting code can represent overlapping independent analytics sources
with explicit provenance. It illustrates the Pulse niche with no cloud
deployment requirement.

It does **not** prove that Plausible Community Edition or Umami
self-hosted APIs are connected, that paid SaaS APIs are available,
that visitor identities can be reconciled, or that Pulse is already
better than a competitor in operational reliability. Live provider
probes, independent maintainer pilots and real deployment/recovery
checks remain separate milestones.

No source data in this demo is suitable for public OSS adoption claims.
