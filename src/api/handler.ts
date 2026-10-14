import type { Config } from '../config.js';
import type { Secrets } from '../auth.js';
import { PulseError, safeError } from '../errors.js';
import { METRICS } from '../model.js';
import { projectReport, portfolio } from '../report.js';
import { Store } from '../storage/store.js';
import { doctor } from '../sync.js';
import { defaultRange, range, type DateRange } from '../time.js';
import { authorized, makeSession, validToken } from './auth.js';
export interface ApiContext {
  config: Config;
  store: Store;
  secrets: Secrets;
  apiToken: string;
  asset: (path: string) => Promise<Response>;
  now?: () => Date;
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
  const def = defaultRange(now, 30);
  return range(url.searchParams.get('from') ?? def.from, url.searchParams.get('to') ?? def.to);
}
function limitFor(url: URL, maximum = 1000): number {
  const n = Number(url.searchParams.get('limit') ?? 100);
  if (!Number.isInteger(n) || n < 1 || n > maximum)
    throw new PulseError('CONFIG', 'Invalid page size.');
  return n;
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
export async function handle(request: Request, ctx: ApiContext): Promise<Response> {
  const now = ctx.now?.() ?? new Date();
  const url = new URL(request.url);
  try {
    if (url.pathname === '/health') return secure(json({ ok: true, service: 'bronto-pulse' }));
    if (ctx.apiToken.length < 24)
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
    if (url.pathname === '/login' && request.method === 'POST') {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin)
        return secure(
          json({ error: { code: 'AUTH', message: 'Cross-origin login is forbidden.' } }, 403),
        );
      if (Number(request.headers.get('content-length') ?? 0) > 8192)
        return secure(
          json({ error: { code: 'CONFIG', message: 'Login body is too large.' } }, 413),
        );
      const body = await request.text();
      if (body.length > 8192)
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
      if (request.headers.get('origin') && request.headers.get('origin') !== url.origin)
        return secure(
          json({ error: { code: 'AUTH', message: 'Cross-origin request rejected.' } }, 403),
        );
      return secure(
        new Response(null, {
          status: 303,
          headers: {
            Location: '/login',
            'Set-Cookie': 'pulse_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
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
    if (!publicAsset && !(await authorized(request, ctx.apiToken, now.getTime()))) {
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
    const root = '/api/v1';
    if (url.pathname === root + '/projects')
      return secure(
        json({
          name: ctx.config.name,
          demo: ctx.config.demo,
          projects: ctx.config.projects.map((p) => ({
            id: p.id,
            label: p.label,
            description: p.description,
            resources: p.resources,
          })),
        }),
      );
    if (url.pathname === root + '/portfolio')
      return secure(json(await portfolio(ctx.config, ctx.store, windowFor(url, now), now)));
    if (url.pathname === root + '/health')
      return secure(json(await doctor(ctx.config, ctx.store, ctx.secrets, now)));
    if (url.pathname === root + '/runs')
      return secure(
        json({
          runs: await ctx.store.runs(limitFor(url), url.searchParams.get('resource') ?? undefined),
        }),
      );
    if (url.pathname === root + '/metrics')
      return secure(json({ definitions: Object.values(METRICS) }));
    if (url.pathname === root + '/export')
      return secure(
        new Response(JSON.stringify(await ctx.store.export()), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': 'attachment; filename="pulse-private-export.json"',
          },
        }),
      );
    const match = /^\/api\/v1\/projects\/([a-z][a-z0-9_-]{0,63})\/report$/.exec(url.pathname);
    if (match)
      return secure(
        json(await projectReport(ctx.config, ctx.store, match[1]!, windowFor(url, now), now)),
      );
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
