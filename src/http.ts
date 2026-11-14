import { PulseError } from './errors.js';
import { retryAfterSeconds } from './retry-after.js';
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const ORIGINS = new Set([
  'https://api.github.com',
  'https://api.npmjs.org',
  'https://registry.npmjs.org',
  'https://api.cloudflare.com',
  'https://www.googleapis.com',
  'https://oauth2.googleapis.com',
  'https://searchconsole.googleapis.com',
  'https://plausible.io',
  'https://api.umami.is',
]);
/** Report only fixed, operator-actionable transport categories. Never persist upstream
 * exception messages: runtime exceptions may contain URLs or credentials. */
function transportFailureCategory(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error';
  if (error.name === 'TimeoutError') return 'timeout';
  if (error.name === 'AbortError') return 'aborted';
  if (error.message === 'Network connection lost' || error.message === 'Network connection lost.')
    return 'connection-lost';
  if (error.name === 'TypeError') return 'type-error';
  if (error.name === 'RangeError') return 'range-error';
  return 'other';
}
export class HttpClient {
  requests = 0;
  constructor(
    // Workerd requires native fetch to be called without an unrelated receiver.
    // Calling a stored fetch as this.fetcher() otherwise throws "Illegal invocation".
    private readonly fetcher: Fetcher = (input, init) => fetch(input, init),
    private readonly timeoutMs = 20000,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly maximumBytes = 8 * 1024 * 1024,
    private readonly maximumRequests = 120,
    private readonly retryRateLimits = true,
  ) {}
  async json(url: string, init: RequestInit = {}): Promise<unknown> {
    const target = new URL(url);
    if (!ORIGINS.has(target.origin) || target.username || target.password)
      throw new PulseError('CONFIG', 'Provider request origin is not permitted.');
    if (
      target.origin === 'https://searchconsole.googleapis.com' &&
      (target.pathname !== '/v1/urlInspection/index:inspect' ||
        target.search ||
        target.hash ||
        init.method !== 'POST')
    )
      throw new PulseError('CONFIG', 'Only the read-only URL inspection endpoint is permitted.');
    if (
      target.origin === 'https://plausible.io' &&
      (target.pathname !== '/api/v2/query' ||
        target.search ||
        target.hash ||
        init.method !== 'POST')
    )
      throw new PulseError('CONFIG', 'Only the read-only Plausible statistics query is permitted.');
    if (
      target.origin === 'https://api.umami.is' &&
      (!/^\/v1\/websites\/[A-Za-z0-9_-]+\/pageviews$/.test(target.pathname) ||
        target.hash ||
        (init.method !== undefined && init.method !== 'GET') ||
        [...target.searchParams.keys()].some(
          (key) => !['startAt', 'endAt', 'timezone', 'unit'].includes(key),
        ))
    )
      throw new PulseError(
        'CONFIG',
        'Only the read-only Umami website pageviews endpoint is permitted.',
      );
    const failures: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      if (++this.requests > this.maximumRequests)
        throw new PulseError(
          'ROW_LIMIT',
          'Per-job request budget exhausted. Narrow the collection window.',
        );
      let response: Response;
      try {
        response = await this.fetcher(url, {
          ...init,
          // Workers supports manual/follow, not the Fetch-standard error mode.
          // Never follow provider redirects: credentials must stay on the pinned origin.
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        failures.push(transportFailureCategory(error));
        if (attempt < 2) {
          await this.sleep(100 * 2 ** attempt);
          continue;
        }
        throw new PulseError(
          'NETWORK',
          `Provider fetch failed (${failures.join(', ')}). No upstream error content retained.`,
          true,
        );
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        // Do not store the upstream Location header or response body.
        throw new PulseError(
          'REDIRECT',
          'Provider redirect refused. Verify the provider endpoint.',
        );
      }
      // Normalize guidance once. Numeric coercion would accept non-HTTP values
      // such as hexadecimal/exponents and lose valid HTTP dates or unbounded waits.
      const githubQuota = target.origin === 'https://api.github.com';
      const stated = retryAfterSeconds(response.headers, Date.now(), githubQuota);
      const retryableStatus = [429, 500, 502, 503, 504].includes(response.status);
      // GitHub also reports exhausted primary/secondary quotas as HTTP 403.
      // Distinguish that documented case from a real missing permission. Do
      // not retain response content or retry a known rate limit in this job.
      if (
        githubQuota &&
        [403, 429].includes(response.status) &&
        (response.headers.get('x-ratelimit-remaining')?.trim() === '0' || stated !== undefined)
      ) {
        await response.body?.cancel();
        throw new PulseError(
          'RATE_LIMIT',
          'GitHub quota is exhausted. Retry in a later collection run.',
          true,
          stated,
        );
      }
      if (response.status === 429 && !this.retryRateLimits) {
        await response.body?.cancel();
        throw new PulseError(
          'RATE_LIMIT',
          'Provider quota requires a later collection run.',
          true,
          stated,
        );
      }
      // Long waits (including the parser's unbounded sentinel) belong to the
      // scheduler. Preserve a final-attempt wait too: retry exhaustion does not
      // revoke the provider's guidance, including on a 503 response.
      if (retryableStatus && stated !== undefined && (stated > 10 || attempt === 2)) {
        await response.body?.cancel();
        throw new PulseError(
          'RATE_LIMIT',
          'Provider rate limit requires a later collection run.',
          true,
          stated,
        );
      }
      if (retryableStatus && attempt < 2) {
        await response.body?.cancel();
        await this.sleep(stated === undefined ? 200 * 2 ** attempt : stated * 1000);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401)
          throw new PulseError('AUTH', 'Provider credentials were rejected.');
        if (response.status === 403)
          throw new PulseError(
            'PERMISSION',
            'Provider denied this dataset. Verify account and least-privilege permissions.',
          );
        if (response.status === 429)
          throw new PulseError(
            'RATE_LIMIT',
            'Provider rate limit exceeded.',
            true,
            stated,
          );
        if (response.status === 404)
          throw new PulseError('NOT_FOUND', 'Provider resource or dataset is unavailable.');
        throw new PulseError('UNAVAILABLE', `Provider returned HTTP ${response.status}.`);
      }
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > this.maximumBytes) {
        await response.body?.cancel();
        throw new PulseError('ROW_LIMIT', 'Provider response exceeds the byte budget.');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new PulseError('SCHEMA', 'Provider returned no JSON body.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > this.maximumBytes) {
            await reader.cancel();
            throw new PulseError('ROW_LIMIT', 'Provider response exceeds the byte budget.');
          }
          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof PulseError) throw error;
        throw new PulseError('NETWORK', 'Provider response stream failed.', true);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch {
        throw new PulseError('SCHEMA', 'Provider returned malformed JSON.');
      }
    }
    throw new PulseError('NETWORK', 'Provider retry budget exhausted.', true);
  }
}
