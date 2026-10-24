import * as z from 'zod/mini';
import { PulseError } from './errors.js';
import { day, addDays } from './time.js';
z.config(z.locales.en());
const id = z.string().check(z.regex(/^[a-z][a-z0-9_-]{0,63}$/));
const envName = z.string().check(z.regex(/^[A-Z][A-Z0-9_]{0,127}$/));
const date = z.string().check(
  z.refine((v) => {
    try {
      day(v);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid date'),
);
const hash = z.string().check(z.regex(/^[a-f0-9]{32}$/i));
const host = z.string().check(z.regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/));
const connection = z.strictObject({
  id,
  provider: z.enum(['github', 'cloudflare', 'gsc']),
  tokenEnv: z.optional(envName),
  clientIdEnv: z.optional(envName),
  clientSecretEnv: z.optional(envName),
  refreshTokenEnv: z.optional(envName),
  serviceAccountJsonEnv: z.optional(envName),
  appIdEnv: z.optional(envName),
  privateKeyEnv: z.optional(envName),
  installationIdEnv: z.optional(envName),
});
const common = {
  id,
  label: z.optional(z.string().check(z.minLength(1), z.maxLength(120))),
  connection: z.optional(id),
  enabled: z._default(z.boolean(), true),
};
const resource = z.discriminatedUnion('provider', [
  z.strictObject({
    ...common,
    provider: z.literal('github'),
    repository: z.string().check(z.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
    repositoryId: z.optional(z.int().check(z.gt(0))),
    groups: z._default(
      z
        .array(z.enum(['repository', 'views', 'clones', 'referrers', 'paths', 'releases']))
        .check(z.minLength(1)),
      ['repository', 'views', 'clones', 'referrers', 'paths', 'releases'],
    ),
  }),
  z.strictObject({
    ...common,
    provider: z.literal('npm'),
    package: z.string().check(z.maxLength(214), z.regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/)),
  }),
  z.strictObject({
    ...common,
    provider: z.literal('cloudflare'),
    accountId: hash,
    siteTag: hash,
    hostname: z.optional(host),
    groups: z._default(
      z
        .array(z.enum(['totals', 'pages', 'referrers', 'performance', 'vitals']))
        .check(z.minLength(1)),
      ['totals', 'pages'],
    ),
    durationUnit: z._default(z.enum(['microseconds', 'milliseconds']), 'microseconds'),
  }),
  z.strictObject({
    ...common,
    provider: z.literal('gsc'),
    siteUrl: z.string().check(
      z.maxLength(500),
      z.refine((s) => {
        if (s.startsWith('sc-domain:')) return /^[a-z0-9.-]+$/.test(s.slice(10));
        try {
          const u = new URL(s);
          return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
        } catch {
          return false;
        }
      }),
    ),
    searchType: z._default(
      z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']),
      'web',
    ),
    collectPages: z._default(z.boolean(), true),
    collectQueries: z._default(z.boolean(), false),
  }),
  z.strictObject({
    ...common,
    provider: z.literal('sense6'),
    accountId: hash,
    databaseId: z.uuid(),
  }),
]);
const scope = z.strictObject({
  hostname: z.optional(host),
  pathPrefix: z.optional(z.string().check(z.maxLength(500), z.regex(/^\/[^?#]*$/))),
});
const binding = z.strictObject({
  resource: id,
  scope: z.optional(scope),
  effectiveFrom: z.optional(date),
  effectiveTo: z.optional(date),
  allowShared: z._default(z.boolean(), false),
});
export const configSchema = z.strictObject({
  version: z.literal(1),
  name: z._default(z.string().check(z.maxLength(120)), 'Project portfolio'),
  demo: z._default(z.boolean(), false),
  connections: z._default(z.array(connection), []),
  resources: z.array(resource).check(z.minLength(1), z.maxLength(500)),
  projects: z
    .array(
      z.strictObject({
        id,
        label: z.string().check(z.minLength(1), z.maxLength(120)),
        description: z._default(z.string().check(z.maxLength(500)), ''),
        resources: z.array(binding).check(z.minLength(1), z.maxLength(50)),
      }),
    )
    .check(z.minLength(1), z.maxLength(200)),
  settings: z._default(
    z.strictObject({
      lookbackDays: z._default(z.int().check(z.gte(1), z.lte(366)), 14),
      maxRows: z._default(z.int().check(z.gte(10), z.lte(50000)), 5000),
      requestTimeoutMs: z._default(z.int().check(z.gte(100), z.lte(60000)), 20000),
      staleAfterHours: z._default(z.number().check(z.gte(1), z.lte(720)), 48),
    }),
    { lookbackDays: 14, maxRows: 5000, requestTimeoutMs: 20000, staleAfterHours: 48 },
  ),
});
export type Config = z.infer<typeof configSchema>;
export type Resource = Config['resources'][number];
export type Connection = Config['connections'][number];
export type Project = Config['projects'][number];
export type Binding = Project['resources'][number];
export type Provider = Resource['provider'];
/** Linear trimming also protects direct library callers outside config size limits. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}
export function pathMatches(path: string, prefix: string): boolean {
  const normalized = prefix === '/' ? '/' : stripTrailingSlashes(prefix);
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
  for (const conn of c.connections) {
    if (conn.serviceAccountJsonEnv && conn.provider !== 'gsc')
      throw new PulseError('CONFIG', 'Service-account JSON authentication requires GSC.');
    if (
      conn.serviceAccountJsonEnv &&
      (conn.clientIdEnv || conn.clientSecretEnv || conn.refreshTokenEnv)
    )
      throw new PulseError(
        'CONFIG',
        'Choose service-account JSON or refresh OAuth for a GSC connection.',
      );
  }
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
      scoped: Boolean(b.scope),
      hostname: b.scope?.hostname ?? null,
      pathPrefix: (b.scope?.pathPrefix ? stripTrailingSlashes(b.scope.pathPrefix) : '') || '/',
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
