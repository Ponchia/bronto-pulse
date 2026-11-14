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
**minimum gap between completed refreshes**, not an SLA. It applies to
every group on the resource unless that group has its own entry.

`refreshHoursByGroup` is an optional map from a group name to its own
interval, with the same 1 to 720 bounds. A group listed there uses its
entry; every other group falls back to `refreshHours`, then to 24 hours.

```json
{
  "id": "repo",
  "provider": "github",
  "repository": "example/project",
  "connection": "github",
  "groups": ["repository", "views", "releases"],
  "refreshHours": 12,
  "refreshHoursByGroup": { "repository": 168, "releases": 1 }
}
```

Here `views` refreshes at most every 12 hours, `repository` weekly and
`releases` hourly. Each key must be a group the resource actually
collects: a group left out of `groups`, or Search Console `queries`
while `collectQueries` is off, is refused with a configuration error
rather than ignored. An empty map changes nothing.

Both settings are read only by due-time selection. Rotation, history
backfills and explicit date windows ignore them, so adding either to a
configuration changes nothing until due-time mode is enabled. A release
older than this setting rejects a stored configuration that contains
`refreshHoursByGroup`: remove the key before rolling back.

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
the next due time is the completion instant plus the dataset's interval.
A failure adds a conservative minimum delay, retaining prior history.
The failure delays are fixed: they do not shrink with a short interval.

| Outcome                             | Minimum retry delay |
| ----------------------------------- | ------------------- |
| Network/unavailable                 | 15 minutes          |
| HTTP 429 / rate limit               | 60 minutes          |
| Schema, config or row limit         | 6 hours             |
| Authentication or denied permission | 24 hours            |
| In-progress run                     | One-hour grace      |

This policy must not be used to evade rate limits. Existing per-job
request, byte and row budgets still apply.

### Provider wait guidance

When a rate-limited response states how long to wait, due-time mode
keeps that for the dataset that failed:

- Pulse reads `Retry-After` as whole seconds or as an HTTP date. For
  GitHub it also reads `x-ratelimit-reset` when `x-ratelimit-remaining`
  is `0`. If both are present, the longer wait is used. Anything else,
  including zero, a past date or unparsable text, is no guidance.
- The wait becomes one number of seconds, and the header text is never
  stored. A stated wait is never shortened, whether it is two hours or
  ninety days. One that runs past the year 9999, the last instant the
  stored timestamp can name, is kept as `9999-12-31T23:59:59.999Z`: an
  indefinite hold.
- A wait above ten seconds, in either form, ends the job at once instead
  of being retried inside it.
- A due-time run that fails with `RATE_LIMIT` records the failure time
  plus the wait, together with the run identifier, in the same transaction
  that marks the run failed. The failed job reports it as
  `retryNotBefore`.
- The dataset becomes due again at the later of the fixed 60-minute
  delay and that instant. Guidance can lengthen the fixed delay and never
  shortens it.
- `pulse doctor` shows the instant as `retryNotBefore` while that failure
  is the dataset's latest run.
- It applies only while that exact run is the dataset's latest regular
  failure. A later regular run, successful or not, makes it inert. An
  explicit `pulse sync --resource <id> --group <group>` is such a run: it
  does not consult the wait, so use it only when you know the provider
  will accept the request. It is also the only way to lift a long or
  indefinite hold; nothing lifts one automatically.
- `pulse export` writes every wait still in force together with its
  failed run, even when that run is older than the newest runs an export
  otherwise keeps. `pulse import` checks each one against its run before
  restoring it, so a restored installation waits for the same instant.
  A wait is left out only when the export itself shows a newer regular
  run of that dataset. An archive written by an earlier release has none
  and restores as before.

What this does **not** do:

- It does not defer other datasets of the same provider, connection or
  resource. A wait learned for `repo:views` leaves `repo:clones` on its
  own schedule, even though the provider quota is usually shared. There
  is no provider-wide quota coordination.
- It is not recorded by rotation, history backfills or explicit date
  windows, whose writes are unchanged.
- A provider that sends no wait, or one outside the forms above, gets the
  fixed delay only. A real provider may need a longer cooldown.

The value lives in the existing key/value settings table as
`scheduler_retry:<resource>:<group>`, one row per dataset, replaced by
that dataset's next guided failure. There is no schema change, and an
older release ignores the rows and the archive field. A row left by a
removed resource is inert.

### Regular runs and backfills

The due-time read prioritizes recent _source dates_, not merely the
latest execution timestamp. Thus an older backfill executed today
cannot displace the last successful regular collection covering the
newest complete source day. Normal run history remains unchanged.

A run counts as regular when its window ends on or after the last
complete day of the source calendar at the moment it started. SQLite
and D1 have no IANA calendar, so UTC sources are matched exactly in
SQL, while Search Console and Plausible runs are read newest first from
a two-day band and checked against the exact Pacific or site timezone.
A newer explicit window that ends one or two days back therefore cannot
hide the regular run before it.

That read is bounded to 256 runs per dataset. If more than 255 such
borderline windows are newer than the last regular run, Pulse cannot
tell whether the dataset was refreshed. It then reports the dataset as
`skipped` with `CONFLICT` on every due-time run and collects nothing
for it: guessing "never collected" could run inside an interval, a
failure delay or a provider wait. Any newer regular collection of that
dataset, such as an explicit `pulse sync --resource <id> --group
<group>`, resolves it.

## Limitations

This is a small-installation scheduler, not a durable distributed queue.
No high availability, provider-wide quota coordination, job priority
SLA or alert delivery is implied. Intervals are minimum gaps: with one
job per invocation, a dataset can wait behind others that are also due.
Run one collector against a single-host SQLite deployment and keep
leases, private backups and a rollback profile. Do not activate this
mode for the production Worker without its own explicit authorization.

See [deployment](deployment.md), [metrics](metrics.md) and
[provider contracts](providers.md).
