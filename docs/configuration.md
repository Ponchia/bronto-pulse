# Configuration and project attribution

Lifecycle: current

`pulse.config.json` is private operator configuration and is ignored by Git.
Validate it with `pulse validate --json`. The generated editor schema is
[`schemas/config.schema.json`](../schemas/config.schema.json); executable
validation additionally enforces cross-resource identity and overlap rules.

## Connections, resources and projects

A **connection** names credential environment variables, never their values.
A **resource** identifies one upstream dataset. A **project binding** specifies
which dates and page scope belong to a project. Resources are collected once,
independently of how many projects refer to them.

```json
{
  "version": 1,
  "connections": [
    { "id": "analytics", "provider": "cloudflare", "tokenEnv": "CLOUDFLARE_API_TOKEN" }
  ],
  "resources": [
    {
      "id": "shared-docs",
      "provider": "cloudflare",
      "connection": "analytics",
      "accountId": "00000000000000000000000000000000",
      "siteTag": "11111111111111111111111111111111",
      "groups": ["totals", "pages"]
    }
  ],
  "projects": [
    {
      "id": "library-one",
      "label": "Library One",
      "resources": [
        {
          "resource": "shared-docs",
          "scope": { "hostname": "example.github.io", "pathPrefix": "/library-one/" }
        }
      ]
    }
  ]
}
```

The identifiers above are placeholders, not working credentials or authorized
accounts. Path prefixes have segment boundaries: `/library-one/` does not match
`/library-one-secret`. Host/path scope selects page data, not property totals.
It does not reconstruct per-project sessions from a shared host.

See the [full synthetic example](../examples/full.json) for the five providers
and [quickstart example](../examples/quickstart.json) for minimal setup.

A Plausible or Umami connection may carry a `selfHosted` block that names an
instance you run, and its resources then name the same `instance`. The block
holds a hostname and the name of a deployment setting, never a URL or an
address. See [self-hosted analytics source connectors](self-hosted-provider-adapters.md).

## Historical changes

Once observations are published, resource identity cannot be silently replaced.
Keep a retired resource with `enabled: false`; reports retain its history.
To change page attribution prospectively, close the old binding with
`effectiveTo` and add a non-overlapping binding with `effectiveFrom`.
Historical mappings must remain intact. A new Cloudflare collection hostname
requires a new resource ID because it changes the upstream query, not just a label.

Intentional resource overlap across projects requires `allowShared: true` on
both bindings. That does not make their totals additive. Duplicate overlapping
bindings inside the same project are rejected.

A mapping beginning partway through a comparison window does not establish an
equal-duration growth baseline. The report retains its actual applicable dates.

## Refresh intervals

`refreshHours` on a resource, and `refreshHoursByGroup` for single groups of
it, set the minimum gap between completed refreshes. Both accept 1–720 and
are read only by the opt-in due-time mode; rotation ignores them. See
[scheduling](scheduling.md).

## Per-group regular collection windows

A resource may declare `lookbackDaysByGroup` to shorten one high-cardinality
**implicit** collection window while preserving `settings.lookbackDays` for
the other datasets. For example:

```json
{
  "id": "search",
  "provider": "gsc",
  "siteUrl": "sc-domain:example.org",
  "connection": "gsc-read",
  "collectQueries": true,
  "lookbackDaysByGroup": { "queries": 2 }
}
```

Values are whole days between 1 and 366, inclusive, and keys must name
collected daily groups; unknown groups, disabled query groups and GitHub
snapshots/rolling groups are rejected. Both rotating and due-time regular
syncs use this narrower source-local lookback; an explicitly supplied date
window, history scheduling and manual backfill keep their exact requested
dates. `pulse plan --resource search --group queries --json` shows the selected
implicit window without querying the provider.

This is an **operator tradeoff**, not an automatic remedy. A shorter lookback
can keep daily query observation counts within a Free-profile limit, but it also
reduces how often delayed or corrected older dates are refetched. The setting
neither increases the 250-normalized-observation cap nor guarantees that even
one day fits. Check actual per-day provider cardinality and data freshness first.
Keep historical collection appropriately bounded and probe explicit older dates
when checking revisions; a failed or too-large window still preserves prior
published history. No existing installation changes without opting in.

## Older history

An npm, Search Console or Sense6 resource may declare
`"history": { "from": "2026-05-15", "chunkDays": 7 }`. A Worker with a history
trigger (see [deployment](deployment.md)) then collects one older chunk per
invocation, ending the day before the dataset's earliest published day, until it
reaches `from`. A dataset with no published day waits for the regular rotation.

- `chunkDays` defaults to 7 and accepts 1–366. A budget failure (`ROW_LIMIT`)
  halves that dataset's later chunks; nothing is published from the failed chunk.
- Search Console history stops 480 days back, inside the provider's 16 months,
  so unreachable dates are never published as empty days.
- Set `from` no earlier than the package's first publication or the property's
  verification. npm reports a day before a package existed as zero downloads.
- GitHub traffic keeps 14 days and snapshots are current-only, so GitHub
  resources reject `history`. Cloudflare RUM retention is account-specific and is
  not backfilled.

## Bounds and lifecycle

| Setting            | Default | Accepted range |
| ------------------ | ------: | -------------- |
| `lookbackDays`     |      14 | 1–366          |
| `maxRows`          |    5000 | 10–50000       |
| `requestTimeoutMs` |   20000 | 100–60000      |
| `staleAfterHours`  |      48 | 1–720          |

Higher limits are not evidence that a provider will return more history or that
a job fits a Workers plan. High-cardinality providers may require one-day
chunks. A hit row limit fails closed; publication never guesses that a truncated
response is complete. `collectQueries` is false unless explicitly enabled on a
Search Console resource. Review retention and disclosure before enabling it.
