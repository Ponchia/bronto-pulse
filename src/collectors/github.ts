import type { Resource } from '../config.js';
import { PulseError, invariant } from '../errors.js';
import type { Observation, Collected, Annotation } from '../model.js';
import { addDays, contains, dateInZone, day } from '../time.js';
import { array, number, object, text, safePath, safeUrl, coalesceCounts } from '../validation.js';
import { collected, entry, token, type CollectContext } from './context.js';
type Github = Extract<Resource, { provider: 'github' }>;
export async function collectGithub(
  r: Github,
  group: string,
  ctx: CollectContext,
): Promise<Collected> {
  const today = dateInZone(ctx.now),
    base = `https://api.github.com/repos/${r.repository}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'bronto-pulse/0.1',
  };
  if (r.connection) headers.Authorization = `Bearer ${await token(r, ctx)}`;
  if (!headers.Authorization && !['repository', 'releases'].includes(group))
    throw new PulseError(
      'AUTH',
      'GitHub traffic requires selected-repository Administration: read access.',
    );
  const get = (suffix: string) => ctx.http.json(base + suffix, { headers });
  if (group === 'repository') {
    const data = object(await get(''));
    const id = number(data.id, 'repository ID', true);
    if (r.repositoryId && r.repositoryId !== id)
      throw new PulseError(
        'CONFLICT',
        'GitHub repository ID does not match the configured resource.',
      );
    const rows = [
      ['github.stars', 'stargazers_count'],
      ['github.forks', 'forks_count'],
      ['github.open_issues', 'open_issues_count'],
    ].map(([metric, key]) => ({
      ...entry(metric!, today, number(data[key!], key, true)),
      kind: 'snapshot' as const,
    }));
    return {
      ...collected({ from: today, to: today }, rows, [
        'Repository totals are snapshots at collection time.',
      ]),
      identity: `github:${id}`,
    };
  }
  if (group === 'views' || group === 'clones') {
    const window = {
      from: ctx.window.from < addDays(today, -13) ? addDays(today, -13) : ctx.window.from,
      to: ctx.window.to > today ? today : ctx.window.to,
    };
    if (window.from > window.to)
      throw new PulseError(
        'UNAVAILABLE',
        'Requested GitHub traffic dates have fallen outside the provider rolling window.',
      );
    const data = object(await get(`/traffic/${group}?per=day`));
    number(data.count, 'traffic total', true);
    number(data.uniques, 'unique total', true);
    const rows: Observation[] = [];
    for (const value of array(data[group], 'daily traffic')) {
      const d = object(value),
        date = day(text(d.timestamp, 'traffic timestamp').slice(0, 10));
      if (!contains(window, date)) continue;
      const quality = date === today ? 'provisional' : 'observed';
      rows.push(
        entry(`github.${group}`, date, number(d.count, 'daily count', true), {}, quality),
        entry(
          group === 'views' ? 'github.unique_viewers' : 'github.unique_cloners',
          date,
          number(d.uniques, 'daily uniques', true),
          {},
          quality,
        ),
      );
    }
    return collected(window, rows, [
      'Only returned UTC daily buckets are observations; omitted dates are not converted to zero.',
      'Daily unique counts are non-additive.',
    ]);
  }
  if (group === 'paths' || group === 'referrers') {
    const window = { from: addDays(today, -13), to: today };
    const rows = array(await get(`/traffic/popular/${group}`), 'top-ten rolling rows');
    invariant(rows.length <= 10, 'GitHub returned more than ten top referral rows.');
    const values = rows.map((value) => {
      const d = object(value);
      const dimensions: Record<string, string> =
        group === 'paths'
          ? { path: safePath(d.path) }
          : { referrer: text(d.referrer, 'referrer', 253) };
      return {
        ...entry(
          group === 'paths' ? 'github.path_views' : 'github.referral_views',
          today,
          number(d.count, 'referral count', true),
          dimensions,
          'top_n',
          'github-top10-rolling14-v1',
        ),
        from: window.from,
        kind: 'rolling' as const,
      };
    });
    // Sanitized query variants from popular paths are combined while preserving a rolling snapshot.
    const collapsed = new Map<string, Observation>();
    for (const value of values) {
      const key = JSON.stringify(value.dimensions);
      const old = collapsed.get(key);
      if (old) old.value += value.value;
      else collapsed.set(key, value);
    }
    return collected(
      window,
      [...collapsed.values()],
      ['Top ten over the current rolling 14 days; snapshots overlap and cannot be summed.'],
      'top_n',
    );
  }
  if (group === 'releases') {
    const rows: Observation[] = [],
      annotations: Annotation[] = [];
    let count = 0,
      page = 1;
    while (true) {
      const result = array(await get(`/releases?per_page=100&page=${page}`), 'releases');
      count += result.length;
      if (count > ctx.config.settings.maxRows)
        throw new PulseError(
          'ROW_LIMIT',
          'Release pagination exceeded the configured row budget; no partial refresh was published.',
        );
      for (const raw of result) {
        const release = object(raw);
        if (release.draft === true) continue;
        const id = number(release.id, 'release ID', true);
        const published = release.published_at;
        if (typeof published !== 'string') continue;
        const date = day(published.slice(0, 10));
        const title = text(release.tag_name, 'release tag', 150);
        annotations.push({
          id: `gh-release:${r.id}:${id}`,
          resourceId: r.id,
          date,
          title: `Release ${title}`,
          kind: 'release',
          url: safeUrl(release.html_url),
        });
        for (const rawAsset of array(release.assets, 'release assets')) {
          const asset = object(rawAsset);
          rows.push({
            ...entry(
              'github.release_downloads',
              today,
              number(asset.download_count, 'release downloads', true),
              {
                assetId: String(number(asset.id, 'asset ID', true)),
                asset: text(asset.name, 'asset name', 160),
                tag: title,
              },
            ),
            kind: 'snapshot',
          });
        }
      }
      if (result.length < 100) break;
      page++;
    }
    return {
      ...collected({ from: today, to: today }, rows, [
        'Asset downloads are snapshots, not daily install counts. Release titles are limited to tag names; author profiles and release bodies are not stored.',
      ]),
      annotations,
    };
  }
  throw new PulseError('CONFIG', 'Unknown GitHub metric group.');
}
// Keep exported for provider-specific contract tests.
export const normalizeGithubCounts = coalesceCounts;
