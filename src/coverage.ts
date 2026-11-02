import * as z from 'zod/mini';
import type { Config } from './config.js';
import { PulseError } from './errors.js';

const githubGroups = ['repository', 'views', 'clones', 'referrers', 'paths', 'releases'] as const;
const inventorySchema = z.strictObject({
  version: z.literal(1),
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
      ]),
    )
    .check(z.minLength(1), z.maxLength(500)),
});
export type CoverageInventory = z.infer<typeof inventorySchema>;
export interface CoverageEntry {
  provider: 'github' | 'npm';
  identity: string;
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
      'Invalid coverage inventory. Expected version 1 and 1–500 GitHub/npm resource identities.',
    );
  const seen = new Set<string>();
  const resources: CoverageEntry[] = parsed.data.resources.map((expected) => {
    const identity =
      expected.provider === 'github' ? expected.repository.toLowerCase() : expected.package;
    const key = `${expected.provider}:${identity}`;
    if (seen.has(key))
      throw new PulseError('CONFIG', 'Coverage inventory contains duplicate resource identities.');
    seen.add(key);
    if (expected.provider === 'github' && new Set(expected.groups).size !== expected.groups.length)
      throw new PulseError('CONFIG', 'Coverage inventory contains duplicate GitHub groups.');
    const matches = config.resources.filter((r) =>
      expected.provider === 'github'
        ? r.provider === 'github' && r.repository.toLowerCase() === identity
        : r.provider === 'npm' && r.package === identity,
    );
    const active = matches.filter((r) => r.enabled);
    const projectIds = config.projects
      .filter((p) => p.resources.some((b) => active.some((r) => r.id === b.resource)))
      .map((p) => p.id)
      .sort();
    const bound = active.filter((r) =>
      config.projects.some((p) => p.resources.some((b) => b.resource === r.id)),
    );
    const requested = expected.provider === 'github' ? expected.groups : ['downloads'];
    const present = new Set(
      bound.flatMap((r) => (r.provider === 'github' ? r.groups : ['downloads'])),
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
