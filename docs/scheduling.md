# Opt-in due-time collection scheduling

Lifecycle: current

## Motivation

A fixed circular scheduler fetches each source at the same frequency, even
when no new data is available. With 56 groups and one job every 15 minutes,
the original installation needs around 14 hours per rotation. Recent
historical backfills must not masquerade as successful regular refreshes.

The new scheduler is opt-in. Existing installations keep their rotation
cursor and behavior unless specifically enabled. No queue, monitoring
service, API grant, new deployment or recurring task is installed by source.

## Source refresh policy

Every resource can optionally declare `refreshHours`, an integer between
1 and 720. Omitted means 24 hours in due-time mode; this is the
**minimum gap between completed refreshes**, not an SLA. It currently
applies to all groups on the resource.

```json
{
  "id": "search",
  "provider": "gsc",
  "siteUrl": "sc-domain:example.org",
  "connection": "search",
  "refreshHours": 24
}
```

The source calendar remains native: GSC uses Pacific source dates,
Plausible uses its configured IANA timezone, others use UTC unless
their metric contract explicitly says otherwise. Missing observations
remain unknown, not confirmed zero.

## Explicit activation

For an existing Node installation, run a bounded one-shot collector:

```sh
pulse sync --config /private/pulse.config.json --db /private/pulse.db --due-only --max-jobs 1
```

`--due-only` cannot combine with `--rotate`, explicit date windows or
`--dry-run`. Offline `pulse plan` cannot inspect durable run heads;
use `pulse doctor` for current collection evidence. Default due-time
execution runs one job to prevent accidental quota bursts.

For the optional Docker Compose collector, set
`PULSE_COLLECT_DUE_ONLY=true` in its private `.env` file. The sidecar
then passes `--due-only` instead of `--rotate`, keeping the same
one-job-per-cycle bound. Leaving the setting absent preserves rotation.

For a Cloudflare Worker, the private installation can explicitly set
`PULSE_DUE_ONLY=true`, retaining `PULSE_EXECUTION_PROFILE=free` and
`PULSE_MAX_JOBS=1`. The default when unset is the existing rotation;
an invalid setting is rejected before any D1 access. This is a
production configuration change and requires its own approval.
The history-only cron keeps its separate backfill selection regardless
of the due-time setting.

## Queueing and retry rules

Datasets are sorted by oldest due instant with stable resource/group
tie-breaking. Never-collected datasets enter first. On recent success,
the next due time is the completion instant plus `refreshHours`.
A failure adds a conservative minimum delay, retaining prior history.

| Outcome                             | Minimum retry delay |
| ----------------------------------- | ------------------- |
| Network/unavailable                 | 15 minutes          |
| HTTP 429 / rate limit               | 60 minutes          |
| Schema, config or row limit         | 6 hours             |
| Authentication or denied permission | 24 hours            |
| In-progress run                     | One-hour grace      |

Provider-specific Retry-After values are not yet stored; a real provider
may require a longer cooldown. This policy must not be used to evade
rate limits. Existing per-job request, byte and row budgets still apply.

The due-time read prioritizes recent _source dates_, not merely the
latest execution timestamp. Thus an older backfill executed today
cannot displace the last successful regular collection covering the
newest complete source day. Normal run history remains unchanged.

## Limitations

This is a small-installation scheduler, not a durable distributed queue.
No high availability, provider-wide quota coordination, per-group
freshness policy, job priority SLA or alert delivery is implied.
Run one collector against a single-host SQLite deployment and keep
leases, private backups and a rollback profile. Do not activate this
mode for the production Worker without its own explicit authorization.

See [deployment](deployment.md), [metrics](metrics.md) and
[provider contracts](providers.md).
