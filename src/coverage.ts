import * as z from 'zod/mini';
import type { Config } from './config.js';
import { PulseError } from './errors.js';

const githubGroups = ['repository', 'views', 'clones', 'referrers', 'paths', 'releases'] as const;
const cloudflareGroups = ['totals', 'pages', 'referrers', 'vitals', 'performance'] as const;
const gscGroups = ['totals', 'pages', 'queries'] as const;

function gscIdentity(siteUrl: string): string {
  if (siteUrl.startsWith('sc-domain:')) {
    const domain = siteUrl.slice('sc-domain:'.length).toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.includes('..'))
      throw new PulseError('CONFIG', 'Coverage GSC property has an invalid domain identity.');
    return 'sc-domain:' + domain;
  }
  try {
    const url = new URL(siteUrl);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.port
    )
      throw new Error('Invalid URL-prefix property');
    return url.href;
  } catch {
    throw new PulseError(
      'CONFIG',
      'Coverage GSC property must be an exact HTTPS URL-prefix or sc-domain identity.',
    );
  }
}
const inventorySchema = z.strictObject({
  version: z.literal(1),
  asOf: z.optional(z.iso.date()),
  resources: z
    .array(
      z.discriminatedUnion('provider', [
        z.strictObject({
          provider: z.literal('github'),
          repository: z
            .string()
            .check(z.maxLength(200), z.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
          groups: z._default(z.array(z.enum(githubGroups)).check(z.minLength(1), z.maxLength(6)), [
            ...githubGroups,
          ]),
        }),
        z.strictObject({
          provider: z.literal('npm'),
          package: z
            .string()
            .check(z.maxLength(214), z.regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/)),
        }),
        z.strictObject({
          provider: z.literal('cloudflare'),
          hostname: z
            .string()
            .check(
              z.maxLength(253),
              z.regex(
                /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/,
              ),
            ),
          projectId: z.optional(
            z.string().check(z.maxLength(120), z.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)),
          ),
          pathPrefix: z.optional(z.string().check(z.maxLength(500), z.regex(/^\/[^?#]*$/))),
          groups: z._default(
            z.array(z.enum(cloudflareGroups)).check(z.minLength(1), z.maxLength(5)),
            [...cloudflareGroups],
          ),
        }),
        z.strictObject({
          provider: z.literal('gsc'),
          siteUrl: z.string().check(z.maxLength(500)),
          groups: z._default(z.array(z.enum(gscGroups)).check(z.minLength(1), z.maxLength(3)), [
            ...gscGroups,
          ]),
        }),
      ]),
    )
    .check(z.minLength(1), z.maxLength(500)),
});
export type CoverageInventory = z.infer<typeof inventorySchema>;
export interface CoverageEntry {
  provider: 'github' | 'npm' | 'cloudflare' | 'gsc';
  identity: string;
  projectId?: string;
  pathPrefix?: string;
  state: 'missing' | 'disabled' | 'unbound' | 'partial' | 'configured';
  resourceIds: string[];
  projectIds: string[];
  missingGroups: string[];
}
export interface CoverageAudit {
  schemaVersion: 1;
  configured: boolean;
  resources: CoverageEntry[];
  limitation: string;
}
/** Configuration coverage only. Never requests a provider, reads credentials or opens storage. */
export function auditCoverage(config: Config, input: unknown): CoverageAudit {
  const parsed = inventorySchema.safeParse(input);
  if (!parsed.success)
    throw new PulseError(
      'CONFIG',
      'Invalid coverage inventory. Expected version 1 and 1–500 supported resource identities.',
    );
  const seen = new Set<string>();
  const asOf = parsed.data.asOf;
  const resources: CoverageEntry[] = parsed.data.resources.map((expected) => {
    const identity =
      expected.provider === 'github'
        ? expected.repository.toLowerCase()
        : expected.provider === 'npm'
          ? expected.package
          : expected.provider === 'cloudflare'
            ? expected.hostname.toLowerCase()
            : gscIdentity(expected.siteUrl);
    if (expected.provider === 'cloudflare' && expected.pathPrefix && !expected.projectId)
      throw new PulseError('CONFIG', 'Path-scoped Cloudflare inventory requires a projectId.');
    const key =
      expected.provider +
      ':' +
      identity +
      (expected.provider === 'cloudflare' && expected.projectId
        ? ':' + expected.projectId + ':' + (expected.pathPrefix ?? '')
        : '');
    if (seen.has(key))
      throw new PulseError('CONFIG', 'Coverage inventory contains duplicate resource identities.');
    seen.add(key);
    const requested =
      expected.provider === 'github'
        ? expected.groups
        : expected.provider === 'npm'
          ? ['downloads']
          : expected.groups;
    if (new Set(requested).size !== requested.length)
      throw new PulseError('CONFIG', 'Coverage inventory contains duplicate groups.');

    const matches = config.resources.filter((r) => {
      if (expected.provider === 'github')
        return r.provider === 'github' && r.repository.toLowerCase() === identity;
      if (expected.provider === 'npm') return r.provider === 'npm' && r.package === identity;
      if (expected.provider === 'cloudflare')
        return r.provider === 'cloudflare' && r.hostname?.toLowerCase() === identity;
      return r.provider === 'gsc' && gscIdentity(r.siteUrl) === identity;
    });
    const active = matches.filter((r) => r.enabled);
    const normalizePrefix = (path: string) => (path === '/' ? '/' : path.replace(/\/+$/, ''));
    const isBoundAtDate = (
      binding: {
        resource: string;
        effectiveFrom?: string;
        effectiveTo?: string;
        scope?: { hostname?: string; pathPrefix?: string };
      },
      id: string,
      projectId: string,
    ) =>
      binding.resource === id &&
      (!asOf ||
        ((!binding.effectiveFrom || binding.effectiveFrom <= asOf) &&
          (!binding.effectiveTo || binding.effectiveTo >= asOf))) &&
      (expected.provider !== 'cloudflare' ||
        ((!expected.projectId || expected.projectId === projectId) &&
          (!binding.scope?.hostname || binding.scope.hostname.toLowerCase() === identity) &&
          (!expected.pathPrefix ||
            normalizePrefix(binding.scope?.pathPrefix ?? '/') ===
              normalizePrefix(expected.pathPrefix))));
    const bound = active.filter((r) =>
      config.projects.some((p) => p.resources.some((b) => isBoundAtDate(b, r.id, p.id))),
    );
    const projectIds = config.projects
      .filter((p) => p.resources.some((b) => bound.some((r) => isBoundAtDate(b, r.id, p.id))))
      .map((p) => p.id)
      .sort();
    const present = new Set(
      bound.flatMap((r) => {
        switch (r.provider) {
          case 'github':
          case 'cloudflare':
            return r.groups;
          case 'npm':
            return ['downloads'];
          case 'gsc':
            return [
              'totals',
              ...(r.collectPages ? ['pages'] : []),
              ...(r.collectQueries ? ['queries'] : []),
            ];
          default:
            return [];
        }
      }),
    );
    const missingGroups = requested.filter((g) => !present.has(g));
    const state = !matches.length
      ? 'missing'
      : !active.length
        ? 'disabled'
        : !bound.length
          ? 'unbound'
          : missingGroups.length
            ? 'partial'
            : 'configured';
    return {
      provider: expected.provider,
      identity,
      ...(expected.provider === 'cloudflare' && expected.projectId
        ? {
            projectId: expected.projectId,
            ...(expected.pathPrefix ? { pathPrefix: expected.pathPrefix } : {}),
          }
        : {}),
      state,
      resourceIds: matches.map((r) => r.id).sort(),
      projectIds,
      missingGroups,
    };
  });
  return {
    schemaVersion: 1,
    configured: resources.every((r) => r.state === 'configured'),
    resources,
    limitation:
      'This compares an explicit inventory with configuration only. It does not prove provider access, current observations, historical date coverage or independent adoption. It changes no grants, configuration or schedules.',
  };
}
