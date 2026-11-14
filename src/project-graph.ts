import type { Config, Provider, Resource } from './config.js';
import { PulseError } from './errors.js';
import { addDays } from './time.js';

/**
 * Read-only projection of explicit, validated configuration. It adds no
 * configuration field, reads no store and writes nothing. Relationships exist
 * only where an operator declared them: a name match never links a package to
 * a repository, and no deployment or ownership identity is derived.
 */
export type ResourceKind =
  'repository' | 'package' | 'website_analytics' | 'search_property' | 'product_events';

export interface GraphIdentity {
  type: 'repository' | 'package' | 'hostname' | 'search_property' | 'none';
  /**
   * The name an operator wrote in configuration, not evidence of ownership or control.
   * Account, site-tag, database and website IDs are never projected.
   */
  value: string | null;
  /**
   * `config_pinned_id`: the operator also pinned the provider's stable ID, which
   * collection checks before accepting data. This projection verifies nothing itself.
   */
  basis: 'config_declared' | 'config_pinned_id';
}
export interface GraphBinding {
  scope: { hostname: string | null; pathPrefix: string | null } | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  shared: boolean;
}
export interface GraphResource {
  id: string;
  provider: Provider;
  kind: ResourceKind;
  label: string | null;
  enabled: boolean;
  identity: GraphIdentity;
  bindings: GraphBinding[];
  /** Other projects that explicitly share this resource. Their values are not additive. */
  sharedWithProjects: string[];
  /** Declared website identities that list this resource as a source. */
  websites: string[];
}
export interface GraphWebsite {
  id: string;
  hostname: string;
  sources: string[];
  pageviewAuthority: { resource: string; effectiveFrom: string }[];
}
export interface GraphRelationship {
  type:
    | 'project_measures_resource'
    | 'resource_shared_with_project'
    | 'resource_reports_website'
    | 'website_prefers_pageview_source';
  /** Namespaced node reference: `project:ID`, `resource:ID` or `website:ID`. */
  from: string;
  to: string;
  provenance: 'project_binding' | 'website_declaration' | 'pageview_authority';
  effectiveFrom: string | null;
  effectiveTo: string | null;
}
export interface ProjectGraph {
  schemaVersion: 1;
  project: { id: string; label: string };
  resources: GraphResource[];
  websites: GraphWebsite[];
  relationships: GraphRelationship[];
  limitation: string;
}

const LIMITATION =
  'This map restates explicit configuration: project bindings, declared website sources and dated pageview preferences. It verifies no ownership, deployment or package-to-repository link, and no relationship is inferred from a name.';
const KINDS: Record<Provider, ResourceKind> = {
  github: 'repository',
  npm: 'package',
  cloudflare: 'website_analytics',
  plausible: 'website_analytics',
  umami: 'website_analytics',
  gsc: 'search_property',
  sense6: 'product_events',
};
const TYPES: GraphRelationship['type'][] = [
  'project_measures_resource',
  'resource_shared_with_project',
  'resource_reports_website',
  'website_prefers_pageview_source',
];

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function identity(resource: Resource): GraphIdentity {
  switch (resource.provider) {
    case 'github':
      return {
        type: 'repository',
        value: resource.repository,
        basis: resource.repositoryId === undefined ? 'config_declared' : 'config_pinned_id',
      };
    case 'npm':
      return { type: 'package', value: resource.package, basis: 'config_declared' };
    case 'cloudflare':
      return resource.hostname
        ? { type: 'hostname', value: resource.hostname, basis: 'config_declared' }
        : { type: 'none', value: null, basis: 'config_declared' };
    case 'plausible':
      return { type: 'hostname', value: resource.siteId, basis: 'config_declared' };
    case 'gsc':
      return { type: 'search_property', value: resource.siteUrl, basis: 'config_declared' };
    case 'umami':
    case 'sense6':
      // Their only identifiers are opaque account-side IDs, which stay private.
      return { type: 'none', value: null, basis: 'config_declared' };
  }
}

export function projectGraph(config: Config, projectId: string): ProjectGraph {
  const project = config.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new PulseError('NOT_FOUND', 'Project was not found.');
  const relationships: GraphRelationship[] = [];
  const resources: GraphResource[] = [];
  const websites: GraphWebsite[] = (project.websites ?? [])
    .map((site) => ({
      id: site.id,
      hostname: site.hostname,
      sources: [...site.sources].sort(compare),
      pageviewAuthority: (site.pageviewsAuthority ?? []).map((entry) => ({
        resource: entry.resource,
        effectiveFrom: entry.effectiveFrom,
      })),
    }))
    .sort((a, b) => compare(a.id, b.id));
  for (const id of [...new Set(project.resources.map((binding) => binding.resource))].sort(
    compare,
  )) {
    const resource = config.resources.find((candidate) => candidate.id === id);
    // parseConfig refuses unknown references; a hand-built object fails closed here.
    if (!resource) throw new PulseError('CONFIG', 'Project references an unknown resource.');
    // Dated segments are listed by start date, whatever their order in configuration.
    const bindings = project.resources
      .filter((binding) => binding.resource === id)
      .sort(
        (a, b) =>
          compare(a.effectiveFrom ?? '', b.effectiveFrom ?? '') ||
          compare(a.effectiveTo ?? '9999-12-31', b.effectiveTo ?? '9999-12-31') ||
          compare(a.scope?.hostname ?? '', b.scope?.hostname ?? '') ||
          compare(a.scope?.pathPrefix ?? '', b.scope?.pathPrefix ?? ''),
      );
    const sharedWithProjects = bindings.some((binding) => binding.allowShared)
      ? config.projects
          .filter(
            (other) =>
              other.id !== project.id &&
              other.resources.some((binding) => binding.resource === id && binding.allowShared),
          )
          .map((other) => other.id)
          .sort(compare)
      : [];
    resources.push({
      id,
      provider: resource.provider,
      kind: KINDS[resource.provider],
      label: resource.label ?? null,
      enabled: resource.enabled,
      identity: identity(resource),
      bindings: bindings.map((binding) => ({
        scope: binding.scope
          ? {
              hostname: binding.scope.hostname ?? null,
              pathPrefix: binding.scope.pathPrefix ?? null,
            }
          : null,
        effectiveFrom: binding.effectiveFrom ?? null,
        effectiveTo: binding.effectiveTo ?? null,
        shared: binding.allowShared,
      })),
      sharedWithProjects,
      websites: websites.filter((site) => site.sources.includes(id)).map((site) => site.id),
    });
    for (const binding of bindings)
      relationships.push({
        type: 'project_measures_resource',
        from: 'project:' + project.id,
        to: 'resource:' + id,
        provenance: 'project_binding',
        effectiveFrom: binding.effectiveFrom ?? null,
        effectiveTo: binding.effectiveTo ?? null,
      });
    for (const other of sharedWithProjects)
      relationships.push({
        type: 'resource_shared_with_project',
        from: 'resource:' + id,
        to: 'project:' + other,
        provenance: 'project_binding',
        effectiveFrom: null,
        effectiveTo: null,
      });
  }
  for (const site of websites) {
    for (const source of site.sources)
      relationships.push({
        type: 'resource_reports_website',
        from: 'resource:' + source,
        to: 'website:' + site.id,
        provenance: 'website_declaration',
        effectiveFrom: null,
        effectiveTo: null,
      });
    site.pageviewAuthority.forEach((entry, index) =>
      relationships.push({
        type: 'website_prefers_pageview_source',
        from: 'website:' + site.id,
        to: 'resource:' + entry.resource,
        provenance: 'pageview_authority',
        effectiveFrom: entry.effectiveFrom,
        // parseConfig keeps these in increasing order; the next entry ends this one.
        effectiveTo: site.pageviewAuthority[index + 1]
          ? addDays(site.pageviewAuthority[index + 1]!.effectiveFrom, -1)
          : null,
      }),
    );
  }
  relationships.sort(
    (a, b) =>
      TYPES.indexOf(a.type) - TYPES.indexOf(b.type) ||
      compare(a.from, b.from) ||
      compare(a.to, b.to) ||
      compare(a.effectiveFrom ?? '', b.effectiveFrom ?? ''),
  );
  return {
    schemaVersion: 1,
    project: { id: project.id, label: project.label },
    resources,
    websites,
    relationships,
    limitation: LIMITATION,
  };
}
