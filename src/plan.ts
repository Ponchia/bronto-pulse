import type { Config, Provider, Resource } from './config.js';
import { groups } from './collectors/index.js';
import { PulseError } from './errors.js';
import { addDays, dateInZone, defaultRange, range, type DateRange } from './time.js';

export interface Selection {
  provider?: Provider;
  resourceId?: string;
  group?: string;
}
export interface PlannedJob {
  resourceId: string;
  provider: Provider;
  group: string;
  timezone: string;
  window: DateRange;
  mode: 'daily' | 'snapshot' | 'rolling';
  command: string[];
}
export interface CollectionPlan {
  schemaVersion: 1;
  readOnly: true;
  generatedAt: string;
  jobs: PlannedJob[];
  totalJobs: number;
  omittedJobs: number;
  disabledResources: string[];
  notices: string[];
}
export function selectCollectionJobs(
  config: Config,
  options: Selection = {},
): { resource: Resource; group: string }[] {
  if (
    options.provider &&
    !['github', 'npm', 'cloudflare', 'gsc', 'sense6'].includes(options.provider)
  )
    throw new PulseError('CONFIG', 'Unknown provider.');
  if (options.resourceId && !config.resources.some((r) => r.id === options.resourceId))
    throw new PulseError('CONFIG', 'Unknown resource selection.');
  const selected = config.resources
    .filter(
      (r) =>
        r.enabled &&
        (!options.provider || r.provider === options.provider) &&
        (!options.resourceId || r.id === options.resourceId),
    )
    .flatMap((resource) =>
      groups(resource)
        .filter((group) => !options.group || group === options.group)
        .map((group) => ({ resource, group })),
    );
  if (!selected.length)
    throw new PulseError('CONFIG', 'No enabled collection jobs match this selection.');
  return selected;
}
/** Pure plan: no database, credentials, network access or schedules are created. */
export function planCollection(
  config: Config,
  options: Selection & {
    window?: DateRange;
    chunkDays?: number;
    maxJobs?: number;
    now?: Date;
  } = {},
): CollectionPlan {
  const now = options.now ?? new Date();
  const chunkDays = options.chunkDays ?? 7,
    maximum = options.maxJobs ?? 64;
  if (!Number.isSafeInteger(chunkDays) || chunkDays < 1 || chunkDays > 366)
    throw new PulseError('CONFIG', 'Chunk size must be between 1 and 366 days.');
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000)
    throw new PulseError('CONFIG', 'Plan job budget must be between 1 and 1000.');
  if (options.window) range(options.window.from, options.window.to);
  const jobs: PlannedJob[] = [],
    notices = new Set<string>();
  let totalJobs = 0;
  const add = (
    resource: Resource,
    group: string,
    timezone: string,
    window: DateRange,
    mode: PlannedJob['mode'],
  ) => {
    totalJobs++;
    if (jobs.length < maximum)
      jobs.push({
        resourceId: resource.id,
        provider: resource.provider,
        group,
        timezone,
        window,
        mode,
        command: [
          'pulse',
          'sync',
          '--resource',
          resource.id,
          '--group',
          group,
          '--from',
          window.from,
          '--to',
          window.to,
        ],
      });
  };
  for (const { resource, group } of selectCollectionJobs(config, options)) {
    const timezone = resource.provider === 'gsc' ? 'America/Los_Angeles' : 'UTC';
    const today = dateInZone(now, timezone);
    const requested = options.window ?? defaultRange(now, config.settings.lookbackDays, timezone);
    if (
      resource.provider === 'github' &&
      ['repository', 'releases', 'referrers', 'paths'].includes(group)
    ) {
      const rolling = group === 'referrers' || group === 'paths';
      add(
        resource,
        group,
        timezone,
        { from: rolling ? addDays(today, -13) : today, to: today },
        rolling ? 'rolling' : 'snapshot',
      );
      notices.add(
        `${resource.id}/${group}: only the current ${rolling ? 'rolling top-ten summary' : 'snapshot'} can be fetched; historical snapshots cannot be backfilled.`,
      );
      continue;
    }
    let from = requested.from;
    const end = resource.provider === 'npm' ? addDays(today, -1) : today;
    const to = requested.to < end ? requested.to : end;
    if (to !== requested.to)
      notices.add(
        `${resource.id}/${group}: future or unpublished dates were clipped from the plan.`,
      );
    if (resource.provider === 'github' && from < addDays(today, -13)) {
      from = addDays(today, -13);
      notices.add(
        `${resource.id}/${group}: traffic before ${from} cannot be recovered from GitHub's current rolling window.`,
      );
    }
    if (from > to) {
      notices.add(
        `${resource.id}/${group}: no provider-retrievable dates in the requested window.`,
      );
      continue;
    }
    if (resource.provider === 'cloudflare')
      notices.add(
        `${resource.id}: account-specific RUM retention and row limits still require a capability probe; a date plan is not authorization evidence.`,
      );
    if (resource.provider === 'gsc')
      notices.add(
        `${resource.id}: source dates remain Pacific Time; recent dates may be provisional and detailed rows provider-limited.`,
      );
    for (let start = from; start <= to;) {
      const candidate = addDays(start, chunkDays - 1),
        finish = candidate < to ? candidate : to;
      add(resource, group, timezone, { from: start, to: finish }, 'daily');
      start = addDays(finish, 1);
    }
  }
  return {
    schemaVersion: 1,
    readOnly: true,
    generatedAt: now.toISOString(),
    jobs,
    totalJobs,
    omittedJobs: Math.max(0, totalJobs - jobs.length),
    disabledResources: config.resources.filter((r) => !r.enabled).map((r) => r.id),
    notices: [...notices],
  };
}
export function markdownPlan(plan: CollectionPlan): string {
  return [
    '# Collection plan — no requests executed',
    '',
    `${plan.jobs.length} of ${plan.totalJobs} bounded jobs shown.`,
    ...plan.jobs.map(
      (j) =>
        `- ${j.resourceId}/${j.group}: ${j.window.from} → ${j.window.to} (${j.timezone}, ${j.mode})\n  ${j.command.join(' ')}`,
    ),
    ...(plan.omittedJobs
      ? [
          '',
          `${plan.omittedJobs} jobs are outside the selected budget. Narrow the selection; do not assume complete coverage.`,
        ]
      : []),
    '',
    ...plan.notices.map((n) => `- ${n}`),
    '',
  ].join('\n');
}
