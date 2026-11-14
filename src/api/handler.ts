import { investigateProject } from '../investigations.js';
import { projectGraph } from '../project-graph.js';
import type { AggregateBindings } from '../collectors/bindings.js';
import type { Config } from '../config.js';
import type { Secrets } from '../auth.js';
import { PulseError, safeError } from '../errors.js';
import { METRICS } from '../model.js';
import { connectorCatalog } from '../collectors/registry.js';
import { projectReport, portfolio } from '../report.js';
import { compareWebsiteSources } from '../source-comparison.js';
import { Store } from '../storage/store.js';
import { doctor } from '../sync.js';
import { reportRange, type DateRange } from '../time.js';
import { planCollection } from '../plan.js';
import { projectBrief, markdownBrief } from '../brief.js';
import { csvReport } from '../report-export.js';
import { markdownReport } from '../report.js';
import { authorized, makeSession, validToken } from './auth.js';
import type { AccessAuthorizer } from './access.js';
export interface ApiData {
  config: Config;
  store: Store;
}
interface ApiAccessContext {
  secrets: Secrets;
  apiToken: string;
  /** Explicit signed-identity mode; never trusts a plain proxy email header. */
  access?: AccessAuthorizer;
  bindings?: AggregateBindings;
  asset: (path: string) => Promise<Response>;
  now?: () => Date;
}
export interface ApiContext extends ApiAccessContext, ApiData {}
export interface LazyApiContext extends ApiAccessContext {
  /** Resolve private configuration/storage only after request authentication. */
  loadData: () => Promise<ApiData>;
}
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Security-Policy', CSP);
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(response.body, { status: response.status, headers });
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
function windowFor(url: URL, now: Date): DateRange {
  const rawDays = url.searchParams.get('days');
  if (rawDays !== null && (!/^\d{1,3}$/.test(rawDays) || url.searchParams.has('from')))
    throw new PulseError('CONFIG', 'Days must be a decimal integer and cannot combine with from.');
  return reportRange(
    {
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      days: rawDays === null ? undefined : Number(rawDays),
    },
    now,
  );
}
function limitFor(url: URL, maximum = 1000): number {
  const raw = url.searchParams.get('limit') ?? '100';
  if (!/^\d{1,4}$/.test(raw)) throw new PulseError('CONFIG', 'Invalid page size.');
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > maximum)
    throw new PulseError('CONFIG', 'Invalid page size.');
  return n;
}
/** Query selectors are a contract, not hints: never return a broader result silently. */
function validateQuery(url: URL, now: Date): void {
  const dateKeys = ['from', 'to', 'days'];
  const plain = new Set(['projects', 'connectors', 'health', 'metrics', 'export']);
  const tail = url.pathname.slice('/api/v1/'.length);
  let allowed: string[] | undefined;
  let dated = false;
  if (plain.has(tail)) allowed = [];
  else if (tail === 'runs') allowed = ['limit', 'resource'];
  else if (tail === 'plan' || tail === 'portfolio') {
    allowed = dateKeys;
    dated = true;
  } else if (tail === 'brief' || /^projects\/[a-z][a-z0-9_-]{0,63}\/(report|brief)$/.test(tail)) {
    allowed = [...dateKeys, 'format'];
    dated = true;
  } else if (/^projects\/[a-z][a-z0-9_-]{0,63}\/graph$/.test(tail)) allowed = ['format'];
  else if (/^projects\/[a-z][a-z0-9_-]{0,63}\/investigation$/.test(tail)) {
    allowed = [...dateKeys, 'limit', 'format'];
    dated = true;
  } else if (/^projects\/[a-z][a-z0-9_-]{0,63}\/source-comparison$/.test(tail)) {
    allowed = [...dateKeys, 'primary', 'secondary', 'same_site'];
    dated = true;
  }
  if (!url.pathname.startsWith('/api/v1/') || !allowed)
    throw new PulseError('NOT_FOUND', 'Endpoint was not found.');
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || seen.has(key))
      throw new PulseError('CONFIG', 'Unsupported or repeated query parameter for this endpoint.');
    seen.add(key);
  }
  const format = url.searchParams.get('format');
  if (format !== null) {
    const formats = tail.endsWith('/report')
      ? ['json', 'markdown', 'csv']
      : tail === 'brief' || tail.endsWith('/brief')
        ? ['json', 'markdown']
        : ['json'];
    if (!formats.includes(format))
      throw new PulseError('CONFIG', 'Unsupported format for this endpoint.');
  }
  if (dated) windowFor(url, now);
  if (tail === 'runs') {
    limitFor(url);
    const resource = url.searchParams.get('resource');
    if (resource !== null && !/^[a-z][a-z0-9_-]{0,63}$/.test(resource))
      throw new PulseError('CONFIG', 'Invalid resource identifier.');
  }
  if (tail.endsWith('/investigation')) limitFor(url, 100);
}
const ASSETS = new Set([
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/login',
  '/login.html',
  '/login.js',
  '/favicon.svg',
]);
export async function handle(
  request: Request,
  ctx: ApiContext | LazyApiContext,
): Promise<Response> {
  const response = await route(request, ctx);
  return request.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}
/**
 * Native POST forms under Referrer-Policy:no-referrer can carry Origin:null.
 * Permit that case only with browser Fetch Metadata asserting same-origin.
 * This is CSRF context, never authentication; login still requires its token.
 */
function sameOriginWrite(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') return false;
  if (origin === url.origin) return true;
  if (origin === 'null') return site === 'same-origin';
  // Preserve explicit non-browser clients without Origin/Fetch Metadata.
  return origin === null && (site === null || site === 'same-origin');
}
async function route(request: Request, ctx: ApiContext | LazyApiContext): Promise<Response> {
  const now = ctx.now?.() ?? new Date();
  const url = new URL(request.url);
  try {
    if (url.pathname === '/health') return secure(json({ ok: true, service: 'bronto-pulse' }));
    if (ctx.access && !(await ctx.access(request, now)))
      return secure(
        json(
          { error: { code: 'AUTH', message: 'A valid Cloudflare Access identity is required.' } },
          401,
        ),
      );
    if (!ctx.access && ctx.apiToken.length < 24)
      return secure(
        json(
          {
            error: {
              code: 'AUTH',
              message: 'Server is locked until a strong API token is configured.',
            },
          },
          503,
        ),
      );
    if (ctx.access && ['/login', '/login.html', '/login.js'].includes(url.pathname)) {
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return secure(
          json({ error: { code: 'AUTH', message: 'Sign in through Cloudflare Access.' } }, 405),
        );
      return secure(new Response(null, { status: 303, headers: { Location: '/' } }));
    }
    if (url.pathname === '/login' && request.method === 'POST') {
      if (!sameOriginWrite(request, url))
        return secure(
          json({ error: { code: 'AUTH', message: 'Cross-origin login is forbidden.' } }, 403),
        );
      if (Number(request.headers.get('content-length') ?? 0) > 8192)
        return secure(
          json({ error: { code: 'CONFIG', message: 'Login body is too large.' } }, 413),
        );
      let body = '';
      let bytes = 0;
      const reader = request.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 8192) {
            await reader.cancel();
            break;
          }
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
      }
      if (bytes > 8192)
        return secure(
          json({ error: { code: 'CONFIG', message: 'Login body is too large.' } }, 413),
        );
      const supplied = new URLSearchParams(body).get('token') ?? '';
      if (!(await validToken(supplied, ctx.apiToken)))
        return secure(json({ error: { code: 'AUTH', message: 'Invalid access token.' } }, 401));
      const session = await makeSession(ctx.apiToken, now.getTime());
      return secure(
        new Response(null, {
          status: 303,
          headers: {
            Location: '/',
            'Set-Cookie': `pulse_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${url.protocol === 'https:' ? '; Secure' : ''}`,
          },
        }),
      );
    }
    if (url.pathname === '/logout' && request.method === 'POST') {
      if (!sameOriginWrite(request, url))
        return secure(
          json({ error: { code: 'AUTH', message: 'Cross-origin request rejected.' } }, 403),
        );
      return secure(
        new Response(null, {
          status: 303,
          headers: {
            Location: ctx.access ? '/cdn-cgi/access/logout' : '/login',
            'Set-Cookie': `pulse_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${url.protocol === 'https:' ? '; Secure' : ''}`,
          },
        }),
      );
    }
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return secure(
        json({ error: { code: 'CONFIG', message: 'The reporting API is read-only.' } }, 405),
      );
    const publicAsset = [
      '/login',
      '/login.html',
      '/login.js',
      '/style.css',
      '/favicon.svg',
    ].includes(url.pathname);
    if (!ctx.access && !publicAsset && !(await authorized(request, ctx.apiToken, now.getTime()))) {
      if (url.pathname.startsWith('/api/'))
        return secure(
          json(
            { error: { code: 'AUTH', message: 'A bearer token or signed session is required.' } },
            401,
          ),
        );
      return secure(new Response(null, { status: 303, headers: { Location: '/login' } }));
    }
    if (ASSETS.has(url.pathname))
      return secure(
        await ctx.asset(
          url.pathname === '/login'
            ? '/login.html'
            : url.pathname === '/'
              ? '/index.html'
              : url.pathname,
        ),
      );
    // Authenticate first, then validate before loading private configuration/storage.
    validateQuery(url, now);
    let data: ApiData;
    try {
      data = 'loadData' in ctx ? await ctx.loadData() : ctx;
    } catch {
      return secure(
        json(
          {
            error: {
              code: 'CONFIG',
              message:
                'Private reporting service is not configured. Check the operator deployment settings.',
            },
          },
          503,
        ),
      );
    }
    const root = '/api/v1';
    if (url.pathname === root + '/connectors')
      return secure(json({ schemaVersion: 1, connectors: connectorCatalog() }));
    if (url.pathname === root + '/projects')
      return secure(
        json({
          name: data.config.name,
          demo: data.config.demo,
          projects: data.config.projects.map((p) => ({
            id: p.id,
            label: p.label,
            description: p.description,
            resources: p.resources,
          })),
        }),
      );
    if (url.pathname === root + '/plan')
      return secure(
        json({
          ...planCollection(data.config, { now, window: windowFor(url, now) }),
          demo: data.config.demo,
        }),
      );
    if (url.pathname === root + '/brief') {
      const reports = await portfolio(data.config, data.store, windowFor(url, now), now);
      const briefs = reports.reports.map((r) => projectBrief(r, 20, r.resources));
      const format = url.searchParams.get('format') ?? 'json';
      if (format === 'markdown')
        return secure(
          new Response(briefs.map(markdownBrief).join('\n---\n'), {
            headers: {
              'Content-Type': 'text/markdown; charset=utf-8',
              'Content-Disposition': 'attachment; filename="pulse-private-briefing.md"',
            },
          }),
        );
      if (format !== 'json') throw new PulseError('CONFIG', 'Brief supports json or markdown.');
      return secure(
        json({
          schemaVersion: 1,
          demo: data.config.demo,
          window: reports.window,
          generatedAt: reports.generatedAt,
          briefs,
        }),
      );
    }
    if (url.pathname === root + '/portfolio')
      return secure(json(await portfolio(data.config, data.store, windowFor(url, now), now)));
    if (url.pathname === root + '/health')
      return secure(json(await doctor(data.config, data.store, ctx.secrets, now, ctx.bindings)));
    if (url.pathname === root + '/runs')
      return secure(
        json({
          runs: await data.store.runs(limitFor(url), url.searchParams.get('resource') ?? undefined),
        }),
      );
    if (url.pathname === root + '/metrics')
      return secure(json({ definitions: Object.values(METRICS) }));
    if (url.pathname === root + '/export')
      return secure(
        new Response(JSON.stringify(await data.store.export()), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': 'attachment; filename="pulse-private-export.json"',
          },
        }),
      );
    const evidenceView =
      /^\/api\/v1\/projects\/([a-z][a-z0-9_-]{0,63})\/(graph|investigation)$/.exec(url.pathname);
    if (evidenceView) {
      const format = url.searchParams.get('format');
      if (format !== null && format !== 'json')
        throw new PulseError('CONFIG', 'Evidence views support JSON only.');
      if (evidenceView[2] === 'graph') {
        if ([...url.searchParams.keys()].some((key) => key !== 'format'))
          throw new PulseError(
            'CONFIG',
            'The configuration graph has no report date or source filters.',
          );
        return secure(json(projectGraph(data.config, evidenceView[1]!)));
      }
      const rawLimit = url.searchParams.get('limit');
      if (
        url.searchParams.getAll('limit').length > 1 ||
        (rawLimit !== null &&
          (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100))
      )
        throw new PulseError('CONFIG', 'Investigation limit must be an integer from 1 to 100.');
      const maximum = rawLimit === null ? 20 : Number(rawLimit);
      const report = await projectReport(
        data.config,
        data.store,
        evidenceView[1]!,
        windowFor(url, now),
        now,
      );
      return secure(
        json({
          schemaVersion: 1,
          project: report.project,
          window: report.window,
          generatedAt: report.generatedAt,
          demo: report.demo,
          investigation: investigateProject(report, maximum, report.resources),
        }),
      );
    }
    const comparison = /^\/api\/v1\/projects\/([a-z][a-z0-9_-]{0,63})\/source-comparison$/.exec(
      url.pathname,
    );
    if (comparison) {
      const primary = url.searchParams.get('primary') ?? '';
      const secondary = url.searchParams.get('secondary') ?? '';
      const confirmation = url.searchParams.get('same_site');
      if (confirmation !== null && confirmation !== 'confirmed')
        throw new PulseError('CONFIG', 'Same-site confirmation must be explicit or omitted.');
      const project = await projectReport(
        data.config,
        data.store,
        comparison[1]!,
        windowFor(url, now),
        now,
      );
      return secure(
        json(compareWebsiteSources(project, primary, secondary, confirmation === 'confirmed')),
      );
    }
    const match = /^\/api\/v1\/projects\/([a-z][a-z0-9_-]{0,63})\/(report|brief)$/.exec(
      url.pathname,
    );
    if (match) {
      const format = url.searchParams.get('format') ?? 'json';
      const isBrief = match[2] === 'brief';
      if (!['json', 'markdown', ...(isBrief ? [] : ['csv'])].includes(format))
        throw new PulseError('CONFIG', 'Unsupported report format.');
      const report = await projectReport(
        data.config,
        data.store,
        match[1]!,
        windowFor(url, now),
        now,
      );
      if (format === 'json')
        return secure(json(isBrief ? projectBrief(report, 20, report.resources) : report));
      const output =
        format === 'csv'
          ? csvReport(report)
          : isBrief
            ? markdownBrief(projectBrief(report, 20, report.resources))
            : markdownReport(report);
      return secure(
        new Response(output, {
          headers: {
            'Content-Type':
              format === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8',
            'Content-Disposition': `attachment; filename="pulse-${match[1]}-${match[2]}.${format === 'csv' ? 'csv' : 'md'}"`,
          },
        }),
      );
    }
    return secure(json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404));
  } catch (error) {
    const clean = safeError(error);
    return secure(
      json(
        { error: clean },
        clean.code === 'CONFIG'
          ? 400
          : clean.code === 'NOT_FOUND'
            ? 404
            : clean.code === 'CONFLICT'
              ? 409
              : 500,
      ),
    );
  }
}
