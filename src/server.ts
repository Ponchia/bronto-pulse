import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type { Secrets } from './auth.js';
import { PulseError } from './errors.js';
import { Store } from './storage/store.js';
import { handle } from './api/handler.js';
export async function startServer(
  config: Config,
  store: Store,
  secrets: Secrets,
  {
    port = 4177,
    host = '127.0.0.1',
    token = secrets.PULSE_API_TOKEN ?? '',
    publicOrigin,
  }: { port?: number; host?: string; token?: string; publicOrigin?: string } = {},
) {
  const local = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!local && !['0.0.0.0', '::'].includes(host))
    throw new PulseError('CONFIG', 'Server bind host must be loopback or an explicit wildcard.');
  let publicUrl: URL | undefined;
  if (publicOrigin !== undefined) {
    try {
      publicUrl = new URL(publicOrigin);
    } catch {
      throw new PulseError('CONFIG', 'Invalid public origin.');
    }
    if (
      publicUrl.protocol !== 'https:' ||
      publicUrl.pathname !== '/' ||
      publicUrl.search ||
      publicUrl.hash ||
      publicUrl.username ||
      publicUrl.password ||
      publicUrl.hostname === 'localhost' ||
      ['127.0.0.1', '0.0.0.0', '[::1]'].includes(publicUrl.hostname)
    )
      throw new PulseError('CONFIG', 'Public origin must be an exact external HTTPS origin.');
  }
  if (!local && !publicUrl)
    throw new PulseError(
      'CONFIG',
      'Non-loopback listening requires an exact HTTPS public origin and a reverse proxy.',
    );
  if (token.length < 24)
    throw new PulseError('AUTH', 'PULSE_API_TOKEN must contain at least 24 characters.');
  const asset = async (path: string) => {
    // handler passes only exact allowlisted paths. Never serve arbitrary filesystem paths.
    const allowed = new Set([
      '/index.html',
      '/login.html',
      '/login.js',
      '/style.css',
      '/app.js',
      '/favicon.svg',
    ]);
    if (!allowed.has(path)) return new Response('Not found', { status: 404 });
    const content = await readFile(fileURLToPath(new URL('../web' + path, import.meta.url)));
    const type = path.endsWith('.js')
      ? 'text/javascript'
      : path.endsWith('.css')
        ? 'text/css'
        : path.endsWith('.svg')
          ? 'image/svg+xml'
          : 'text/html';
    return new Response(content, { headers: { 'Content-Type': type + '; charset=utf-8' } });
  };
  const server = createServer(async (req, res) => {
    try {
      const authority = req.headers.host ?? (local ? `localhost:${port}` : '');
      // Never trust X-Forwarded-* for scheme or authority. The operator pins
      // one canonical HTTPS origin; the reverse proxy must preserve Host.
      const base = publicUrl?.origin ?? `http://${authority}`;
      const target = req.url ?? '/';
      const url = new URL(target, base);
      let hostAllowed = false;
      try {
        const hostUrl = new URL(`http://${authority}`);
        hostAllowed = publicUrl
          ? hostUrl.host === publicUrl.host
          : ['localhost', '127.0.0.1', '[::1]'].includes(hostUrl.hostname);
      } catch {
        hostAllowed = false;
      }
      if (
        !hostAllowed ||
        !target.startsWith('/') ||
        target.startsWith('//') ||
        url.origin !== base
      ) {
        res.writeHead(403, { 'Cache-Control': 'no-store' });
        res.end('Invalid host');
        return;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 8192) {
          res.writeHead(413);
          res.end('Body too large');
          req.destroy();
          return;
        }
        chunks.push(part);
      }
      const request = new Request(url, {
        method: req.method,
        headers: Object.fromEntries(
          Object.entries(req.headers).flatMap(([k, v]) =>
            v === undefined ? [] : [[k, Array.isArray(v) ? v.join(',') : v]],
          ),
        ),
        body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
      });
      const response = await handle(request, { config, store, secrets, apiToken: token, asset });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Reporting request failed. No private diagnostics are exposed.');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}
