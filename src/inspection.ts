import { z } from 'zod';
import { pathMatches, type Config, type Resource } from './config.js';
import { Credentials, type Secrets } from './auth.js';
import { HttpClient } from './http.js';
import { PulseError, safeError } from './errors.js';
import { object, text, array, safeUrl } from './validation.js';

const field = z.string().max(2048).nullable();
export const inspectionSchema = z
  .object({
    id: z.string().uuid(),
    resourceId: z.string().min(1).max(64),
    url: z.string().max(2048),
    inspectedAt: z.iso.datetime(),
    status: z.enum(['observed', 'unknown', 'error']),
    verdict: field,
    coverageState: field,
    declaredCanonical: field,
    googleCanonical: field,
    lastCrawlTime: z.iso.datetime({ offset: true }).nullable(),
    sitemaps: z.array(z.string().max(2048)).max(100).nullable(),
    errorCode: z
      .enum([
        'CONFIG',
        'AUTH',
        'PERMISSION',
        'RATE_LIMIT',
        'NETWORK',
        'REDIRECT',
        'SCHEMA',
        'ROW_LIMIT',
        'UNAVAILABLE',
        'LEASE_LOST',
        'CONFLICT',
        'NOT_FOUND',
      ])
      .nullable(),
  })
  .strict();
export type Inspection = z.infer<typeof inspectionSchema>;

/** No fetch of the target URL. Exact origin and segment bounds prevent prefix confusion. */
export function inspectionUrl(siteUrl: string, raw: string): string {
  try {
    if (raw.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(raw)) throw new Error();
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.port
    )
      throw new Error();
    // Reject encoded separators/dot segments rather than guessing server path semantics.
    if (/%(?:2f|5c|2e)/i.test(url.pathname)) throw new Error();
    if (siteUrl.startsWith('sc-domain:')) {
      const domain = siteUrl.slice(10);
      if (url.hostname !== domain && !url.hostname.endsWith('.' + domain)) throw new Error();
    } else {
      const property = new URL(siteUrl);
      if (url.origin !== property.origin || !pathMatches(url.pathname, property.pathname))
        throw new Error();
    }
    return url.href;
  } catch {
    throw new PulseError(
      'CONFIG',
      'Inspection URLs must be HTTPS URLs within the configured property, without credentials, queries or fragments.',
    );
  }
}

export function validateInspection(input: unknown, resource: Resource): Inspection {
  const parsed = inspectionSchema.safeParse(input);
  if (!parsed.success || resource.provider !== 'gsc')
    throw new PulseError('SCHEMA', 'Invalid normalized URL inspection.');
  const row = parsed.data;
  if (row.resourceId !== resource.id || inspectionUrl(resource.siteUrl, row.url) !== row.url)
    throw new PulseError('SCHEMA', 'URL inspection resource or property mismatch.');
  const fields = [
    row.verdict,
    row.coverageState,
    row.declaredCanonical,
    row.googleCanonical,
    row.lastCrawlTime,
    row.sitemaps,
  ];
  if (
    (row.status !== 'observed' && fields.some((v) => v !== null)) ||
    (row.status === 'error') !== (row.errorCode !== null) ||
    (row.status === 'observed' && !fields.some((v) => v !== null))
  )
    throw new PulseError('SCHEMA', 'Contradictory URL inspection state.');
  for (const value of [row.declaredCanonical, row.googleCanonical, ...(row.sitemaps ?? [])])
    if (value !== null && safeUrl(value) !== value)
      throw new PulseError('SCHEMA', 'Unsafe inspection URL field.');
  return row;
}

export async function inspectUrls(
  config: Config,
  resourceId: string,
  urls: string[],
  env: Secrets,
  options: { http?: HttpClient; now?: () => Date } = {},
): Promise<Inspection[]> {
  const resource = config.resources.find((r) => r.id === resourceId);
  if (!resource || resource.provider !== 'gsc' || !resource.enabled || config.demo)
    throw new PulseError('CONFIG', 'Choose an enabled non-demo GSC resource for inspection.');
  if (urls.length < 1 || urls.length > 20)
    throw new PulseError('ROW_LIMIT', 'Pass an explicit list of 1–20 inspection URLs.');
  const targets = urls.map((url) => inspectionUrl(resource.siteUrl, url));
  if (new Set(targets).size !== targets.length)
    throw new PulseError('CONFIG', 'Duplicate inspection URL.');
  const now = options.now ?? (() => new Date());
  const http = options.http ?? new HttpClient(undefined, config.settings.requestTimeoutMs);
  const credentials = new Credentials(env, http, now);
  const results: Inspection[] = [];
  for (const url of targets) {
    const base: Inspection = {
      id: crypto.randomUUID(),
      resourceId,
      url,
      inspectedAt: now().toISOString(),
      status: 'unknown',
      verdict: null,
      coverageState: null,
      declaredCanonical: null,
      googleCanonical: null,
      lastCrawlTime: null,
      sitemaps: null,
      errorCode: null,
    };
    try {
      const token = await credentials.token(
        config.connections.find((c) => c.id === resource.connection),
      );
      const data = object(
        await http.json('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inspectionUrl: url,
            siteUrl: resource.siteUrl,
            languageCode: 'en-US',
          }),
        }),
      );
      const result = object(data.inspectionResult);
      if (result.indexStatusResult !== undefined) {
        const index = object(result.indexStatusResult);
        const optional = (key: string) =>
          index[key] === undefined ? null : text(index[key], 'inspection field');
        const optionalUrl = (key: string) =>
          index[key] === undefined ? null : safeUrl(index[key]);
        base.verdict = optional('verdict');
        base.coverageState = optional('coverageState');
        base.declaredCanonical = optionalUrl('userCanonical');
        base.googleCanonical = optionalUrl('googleCanonical');
        base.lastCrawlTime = optional('lastCrawlTime');
        base.sitemaps = index.sitemap === undefined ? null : array(index.sitemap).map(safeUrl);
        if (
          [
            base.verdict,
            base.coverageState,
            base.declaredCanonical,
            base.googleCanonical,
            base.lastCrawlTime,
            base.sitemaps,
          ].some((v) => v !== null)
        )
          base.status = 'observed';
      }
      results.push(validateInspection(base, resource));
    } catch (error) {
      results.push({
        ...base,
        status: 'error',
        verdict: null,
        coverageState: null,
        declaredCanonical: null,
        googleCanonical: null,
        lastCrawlTime: null,
        sitemaps: null,
        errorCode: safeError(error).code,
      });
    }
  }
  return results;
}
