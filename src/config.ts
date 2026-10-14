import { z } from 'zod';
import { PulseError } from './errors.js';
import { day, addDays } from './time.js';
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const date = z.string().refine((v) => {
  try {
    day(v);
    return true;
  } catch {
    return false;
  }
}, 'Invalid date');
const hash = z.string().regex(/^[a-f0-9]{32}$/i);
const host = z.string().regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
const connection = z
  .object({
    id,
    provider: z.enum(['github', 'cloudflare', 'gsc']),
    tokenEnv: envName.optional(),
    clientIdEnv: envName.optional(),
    clientSecretEnv: envName.optional(),
    refreshTokenEnv: envName.optional(),
    appIdEnv: envName.optional(),
    privateKeyEnv: envName.optional(),
    installationIdEnv: envName.optional(),
  })
  .strict();
const common = {
  id,
  label: z.string().min(1).max(120).optional(),
  connection: id.optional(),
  enabled: z.boolean().default(true),
};
const resource = z.discriminatedUnion('provider', [
  z
    .object({
      ...common,
      provider: z.literal('github'),
      repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      repositoryId: z.number().int().positive().optional(),
      groups: z
        .array(z.enum(['repository', 'views', 'clones', 'referrers', 'paths', 'releases']))
        .min(1)
        .default(['repository', 'views', 'clones', 'referrers', 'paths', 'releases']),
    })
    .strict(),
  z
    .object({
      ...common,
      provider: z.literal('npm'),
      package: z
        .string()
        .max(214)
        .regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/),
    })
    .strict(),
  z
    .object({
      ...common,
      provider: z.literal('cloudflare'),
      accountId: hash,
      siteTag: hash,
      hostname: host.optional(),
      groups: z
        .array(z.enum(['totals', 'pages', 'referrers', 'performance', 'vitals']))
        .min(1)
        .default(['totals', 'pages']),
      durationUnit: z.enum(['microseconds', 'milliseconds']).default('microseconds'),
    })
    .strict(),
  z
    .object({
      ...common,
      provider: z.literal('gsc'),
      siteUrl: z
        .string()
        .max(500)
        .refine((s) => {
          if (s.startsWith('sc-domain:')) return /^[a-z0-9.-]+$/.test(s.slice(10));
          try {
            const u = new URL(s);
            return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
          } catch {
            return false;
          }
        }),
      searchType: z
        .enum(['web', 'image', 'video', 'news', 'discover', 'googleNews'])
        .default('web'),
      collectPages: z.boolean().default(true),
      collectQueries: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      ...common,
      provider: z.literal('sense6'),
      accountId: hash,
      databaseId: z.string().uuid(),
    })
    .strict(),
]);
const scope = z
  .object({
    hostname: host.optional(),
    pathPrefix: z
      .string()
      .max(500)
      .regex(/^\/[^?#]*$/)
      .optional(),
  })
  .strict();
const binding = z
  .object({
    resource: id,
    scope: scope.optional(),
    effectiveFrom: date.optional(),
    effectiveTo: date.optional(),
    allowShared: z.boolean().default(false),
  })
  .strict();
export const configSchema = z
  .object({
    version: z.literal(1),
    name: z.string().max(120).default('Project portfolio'),
    demo: z.boolean().default(false),
    connections: z.array(connection).default([]),
    resources: z.array(resource).min(1).max(500),
    projects: z
      .array(
        z
          .object({
            id,
            label: z.string().min(1).max(120),
            description: z.string().max(500).default(''),
            resources: z.array(binding).min(1).max(50),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    settings: z
      .object({
        lookbackDays: z.number().int().min(1).max(366).default(14),
        maxRows: z.number().int().min(10).max(50000).default(5000),
        requestTimeoutMs: z.number().int().min(100).max(60000).default(20000),
        staleAfterHours: z.number().min(1).max(720).default(48),
      })
      .strict()
      .default({ lookbackDays: 14, maxRows: 5000, requestTimeoutMs: 20000, staleAfterHours: 48 }),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export type Resource = Config['resources'][number];
export type Connection = Config['connections'][number];
export type Project = Config['projects'][number];
export type Binding = Project['resources'][number];
export type Provider = Resource['provider'];
export function pathMatches(path: string, prefix: string): boolean {
  const normalized = prefix === '/' ? '/' : prefix.replace(/\/+$/, '');
  return normalized === '/' || path === normalized || path.startsWith(normalized + '/');
}
function scopesOverlap(a: Binding, b: Binding): boolean {
  if (
    (a.effectiveTo && b.effectiveFrom && a.effectiveTo < b.effectiveFrom) ||
    (b.effectiveTo && a.effectiveFrom && b.effectiveTo < a.effectiveFrom)
  )
    return false;
  if (a.scope?.hostname && b.scope?.hostname && a.scope.hostname !== b.scope.hostname) return false;
  const ap = a.scope?.pathPrefix ?? '/',
    bp = b.scope?.pathPrefix ?? '/';
  return pathMatches(ap, bp) || pathMatches(bp, ap);
}
export function parseConfig(input: unknown): Config {
  const result = configSchema.safeParse(input);
  if (!result.success)
    throw new PulseError(
      'CONFIG',
      'Invalid project configuration: ' +
        result.error.issues
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .slice(0, 5)
          .join('; '),
    );
  const c = result.data;
  for (const list of [c.connections, c.resources, c.projects]) {
    const ids = list.map((x) => x.id);
    if (new Set(ids).size !== ids.length)
      throw new PulseError('CONFIG', 'Duplicate identifier in configuration.');
  }
  for (const r of c.resources) {
    if (r.provider === 'npm' && r.connection)
      throw new PulseError('CONFIG', 'npm downloads must not receive private credentials.');
    if (r.connection) {
      const conn = c.connections.find((x) => x.id === r.connection);
      if (!conn || conn.provider !== (r.provider === 'sense6' ? 'cloudflare' : r.provider))
        throw new PulseError(
          'CONFIG',
          'Resource connection is absent or belongs to another provider.',
        );
    }
    if ('groups' in r && new Set(r.groups).size !== r.groups.length)
      throw new PulseError('CONFIG', 'Duplicate collection group.');
  }
  const bindings: { project: string; b: Binding }[] = [];
  for (const p of c.projects) {
    for (const b of p.resources) {
      const r = c.resources.find((x) => x.id === b.resource);
      if (!r) throw new PulseError('CONFIG', 'Project references an unknown resource.');
      if (b.scope && !['cloudflare', 'gsc'].includes(r.provider))
        throw new PulseError('CONFIG', 'Page scopes require a website or search resource.');
      if (b.effectiveFrom && b.effectiveTo && b.effectiveFrom > b.effectiveTo)
        throw new PulseError('CONFIG', 'Reversed mapping effective dates.');
      for (const existing of bindings) {
        if (
          existing.b.resource === b.resource &&
          scopesOverlap(existing.b, b) &&
          !(b.allowShared && existing.b.allowShared && existing.project !== p.id)
        )
          throw new PulseError(
            'CONFIG',
            'Overlapping project mappings require explicit allowShared on both projects; duplicate mappings in one project are forbidden.',
          );
      }
      bindings.push({ project: p.id, b });
    }
  }
  return c;
}
/** Identity does not include labels or auth. A stable provider ID survives a display rename. */
export function resourceIdentity(r: Resource): string {
  switch (r.provider) {
    case 'github':
      return `github:${r.repositoryId ?? r.repository.toLowerCase()}`;
    case 'npm':
      return `npm:${r.package}`;
    case 'cloudflare':
      return `cloudflare:${r.accountId}:${r.siteTag}`;
    case 'gsc':
      return `gsc:${r.siteUrl}:${r.searchType}`;
    case 'sense6':
      return `sense6:${r.accountId}:${r.databaseId}`;
  }
}
export function configWarnings(c: Config): string[] {
  return c.projects.flatMap((p) =>
    p.resources
      .filter((b) => b.allowShared)
      .map(() => `${p.id}: shared resources are not additive in a portfolio total.`),
  );
}

/** Preserve historical project/source scopes when installing a new configuration. */
export function assertHistoricalMappings(previous: Config, next: Config, changeDate: string): void {
  day(changeDate);
  const normalize = (b: Binding) =>
    JSON.stringify({
      resource: b.resource,
      hostname: b.scope?.hostname ?? null,
      pathPrefix: b.scope?.pathPrefix?.replace(/\/+$/, '') || '/',
    });
  for (const project of previous.projects) {
    const replacement = next.projects.find((p) => p.id === project.id);
    if (!replacement)
      throw new PulseError(
        'CONFLICT',
        `Project ${project.id} owns historical mappings; retain its stable ID.`,
      );
    for (const resourceId of new Set(project.resources.map((b) => b.resource))) {
      const before = project.resources.filter((b) => b.resource === resourceId),
        after = replacement.resources.filter((b) => b.resource === resourceId);
      const cuts = new Set(['0001-01-01']);
      for (const b of [...before, ...after]) {
        if (b.effectiveFrom && b.effectiveFrom < changeDate) cuts.add(b.effectiveFrom);
        if (b.effectiveTo && b.effectiveTo < changeDate) cuts.add(addDays(b.effectiveTo, 1));
      }
      const active = (bindings: Binding[], date: string) =>
        bindings
          .filter(
            (b) =>
              (!b.effectiveFrom || date >= b.effectiveFrom) &&
              (!b.effectiveTo || date <= b.effectiveTo),
          )
          .map(normalize)
          .sort()
          .join('|');
      if (
        [...cuts].some((date) => date < changeDate && active(before, date) !== active(after, date))
      )
        throw new PulseError(
          'CONFLICT',
          `Historical mapping for ${project.id}/${resourceId} would change. Preserve the old binding through yesterday and add a new effective-dated segment.`,
        );
    }
  }
}
