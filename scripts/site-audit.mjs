#!/usr/bin/env node
/**
 * Opt-in, no-credential, public-website technical checks.
 *
 * Runs on an operator's Node host only, never in a Worker, provider connector,
 * request handler or background job. Public DNS answers are pinned per request
 * so an inventory cannot redirect the scanner to loopback/private services.
 */
import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const MAX_SITES = 30;
const MAX_BYTES = 1_048_576;
const MAX_PAGES = 8;
const TIMEOUT_MS = 8_000;

function publicIPv4(address) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return false;
  const a = address.split('.').map(Number);
  if (a.some((v) => v < 0 || v > 255)) return false;
  const [first, second, third] = a;
  if ([0, 10, 127].includes(first) || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && [0, 168].includes(second)) return false;
  if (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
    return false;
  if (first === 203 && second === 0 && third === 113) return false;
  if (first === 192 && second === 0 && third === 2) return false;
  return true;
}

function publicIPv6(address) {
  // Global unicast 2000::/3; disallow documentation and IPv4-mapped addresses.
  return /^[23][0-9a-f]{0,3}:/i.test(address) && !/^2001:db8:/i.test(address);
}

export function isPublicAddress(address) {
  const type = isIP(address);
  return type === 4 ? publicIPv4(address) : type === 6 && publicIPv6(address);
}

export function publicSiteUrl(value) {
  if (typeof value !== 'string' || value.length > 512) throw new Error('Invalid site URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid site URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname.length > 253 ||
    url.search ||
    url.hash ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) ||
    url.pathname !== '/' ||
    isIP(url.hostname) ||
    /\.(?:local|internal|test|invalid|localhost)$/.test(url.hostname)
  )
    throw new Error('Only public HTTPS website origins are accepted');
  return url;
}

function relativePath(value) {
  if (typeof value !== 'string' || !/^\/(?!\/)[^?#]*$/.test(value) || value.length > 500)
    throw new Error('Site path must be an absolute path without query or fragment');
  const result = new URL(value, 'https://audit.example/');
  if (result.pathname !== value) throw new Error('Site path must be normalized');
  return value;
}

export function parseSiteInventory(raw) {
  if (typeof raw !== 'object' || !raw || Array.isArray(raw)) throw new Error('Invalid inventory');
  if (Object.keys(raw).some((k) => !['version', 'sites'].includes(k)) || raw.version !== 1)
    throw new Error('Unsupported inventory');
  if (!Array.isArray(raw.sites) || !raw.sites.length || raw.sites.length > MAX_SITES)
    throw new Error('Inventory must contain 1–30 sites');
  const ids = new Set();
  return raw.sites.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).some(
        (k) => !['id', 'origin', 'startPath', 'sitemap', 'multilingual'].includes(k),
      )
    )
      throw new Error('Unknown site field');
    if (
      typeof entry.id !== 'string' ||
      !/^[a-z][a-z0-9-]{0,55}$/.test(entry.id) ||
      ids.has(entry.id)
    )
      throw new Error('Invalid or duplicate site id');
    ids.add(entry.id);
    const origin = publicSiteUrl(entry.origin).origin;
    const sitemap = entry.sitemap === undefined ? '/sitemap.xml' : relativePath(entry.sitemap);
    const startPath = entry.startPath === undefined ? '/' : relativePath(entry.startPath);
    if (entry.multilingual !== undefined && typeof entry.multilingual !== 'boolean')
      throw new Error('multilingual must be boolean');
    return { id: entry.id, origin, startPath, sitemap, multilingual: entry.multilingual === true };
  });
}

async function pinnedHttpsGet(url, { timeoutMs = TIMEOUT_MS } = {}) {
  const resolved = await lookup(url.hostname, { all: true, verbatim: true });
  if (!resolved.length || resolved.some((entry) => !isPublicAddress(entry.address)))
    throw new Error('DNS returned an unavailable or non-public address');
  const pinned = resolved.find((entry) => entry.family === 4) ?? resolved[0];
  return await new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        headers: { Accept: 'text/html,application/xml,text/plain;q=0.9,*/*;q=0.1' },
        timeout: timeoutMs,
        lookup: (_hostname, options, callback) => {
          // Node's autoSelectFamily requests {all:true}; its lookup callback
          // requires an array of addresses rather than address/family scalars.
          if (options?.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
        // Deliberately no authentication, cookies, redirects, unsafe protocol or proxy.
        maxHeaderSize: 16_384,
      },
      (res) => {
        const parts = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error('Response exceeds 1 MiB limit'));
            return;
          }
          parts.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(parts).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function safeTarget(url, site) {
  const target = new URL(url);
  if (
    target.protocol !== 'https:' ||
    target.hostname !== new URL(site.origin).hostname ||
    target.port ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error('Site redirect or sitemap target escaped approved HTTPS host');
  return target;
}

async function fetchSite(url, site, get = pinnedHttpsGet) {
  let current = safeTarget(url, site);
  for (let hop = 0; hop <= 2; hop++) {
    const response = await get(current);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === 2 || !response.headers?.location) throw new Error('Redirect limit reached');
      current = safeTarget(new URL(response.headers.location, current), site);
      continue;
    }
    return { ...response, finalUrl: current.href };
  }
  throw new Error('Redirect limit reached');
}

function attributes(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([a-z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map((m) => [
      m[1].toLowerCase(),
      m[2] ?? m[3] ?? m[4] ?? '',
    ]),
  );
}

function headTags(html, name) {
  return [...html.matchAll(new RegExp('<' + name + '\\b[^>]*>', 'gi'))].map((m) =>
    attributes(m[0]),
  );
}

function unescapeXml(s) {
  // Decode only one XML entity layer. Consecutive replacements would turn
  // "&amp;lt;" into "<" even though XML semantics require the literal "&lt;".
  // That is both misleading for URL validation and a double-unescape hazard.
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_entity, name) => entities[name]);
}

function addCheck(checks, severity, code, url, reason) {
  checks.push({ severity, code, url, reason });
}

async function inspectPage(url, site, get, checks) {
  let res;
  try {
    res = await fetchSite(url, site, get);
  } catch (error) {
    addCheck(checks, 'unknown', 'page_unavailable', url, String(error.message).slice(0, 180));
    return;
  }
  if (res.status !== 200) {
    addCheck(checks, 'error', 'page_http', res.finalUrl, 'HTTP ' + res.status);
    return;
  }
  const page = res.finalUrl;
  const text = res.body;
  const title = text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  if (!title) addCheck(checks, 'error', 'missing_title', page, 'No HTML title');
  const metas = headTags(text, 'meta');
  const links = headTags(text, 'link');
  const description = metas.find((m) => m.name?.toLowerCase() === 'description')?.content?.trim();
  if (!description) addCheck(checks, 'warning', 'missing_description', page, 'No meta description');
  const lang = text.match(/<html\b[^>]*\blang=["']([^"']+)["']/i)?.[1];
  if (!lang) addCheck(checks, 'warning', 'missing_language', page, 'No HTML lang');
  const robots = metas
    .filter((m) => ['robots', 'googlebot'].includes(m.name?.toLowerCase()))
    .map((m) => m.content?.toLowerCase() ?? '')
    .join(',');
  const xRobots = String(res.headers?.['x-robots-tag'] ?? '').toLowerCase();
  if (/(^|[,\s])noindex([,\s]|$)/.test(robots + ',' + xRobots))
    addCheck(checks, 'error', 'noindex_in_sitemap', page, 'Sitemap page explicitly marked noindex');
  const canonical = links.find((m) =>
    m.rel?.toLowerCase().split(/\s+/).includes('canonical'),
  )?.href;
  if (!canonical) {
    addCheck(checks, 'error', 'missing_canonical', page, 'No canonical URL');
  } else {
    try {
      const target = new URL(canonical, page);
      if (
        target.hostname !== new URL(site.origin).hostname ||
        target.pathname !== new URL(page).pathname
      )
        addCheck(
          checks,
          'warning',
          'canonical_differs',
          page,
          'Canonical differs from fetched page: ' + target.href.slice(0, 250),
        );
    } catch {
      addCheck(checks, 'error', 'invalid_canonical', page, 'Malformed canonical');
    }
  }
  if (
    site.multilingual &&
    !links.some((m) => m.rel?.toLowerCase().split(/\s+/).includes('alternate') && m.hreflang)
  )
    addCheck(checks, 'warning', 'missing_hreflang', page, 'Multilingual site has no hreflang link');
  return { finalUrl: page, title: title?.slice(0, 120) ?? null, canonical: canonical ?? null };
}

export async function auditSite(site, { get = pinnedHttpsGet, now = new Date() } = {}) {
  // Callers must pass only parseSiteInventory results.
  const [validated] = parseSiteInventory({ version: 1, sites: [site] });
  site = validated;
  const checks = [];
  const pages = [];
  let robots;
  try {
    robots = await fetchSite(site.origin + '/robots.txt', site, get);
    if (robots.status !== 200)
      addCheck(
        checks,
        'warning',
        'robots_unavailable',
        site.origin + '/robots.txt',
        'HTTP ' + robots.status,
      );
    else if (!/^\s*sitemap\s*:/im.test(robots.body))
      addCheck(
        checks,
        'warning',
        'robots_sitemap_unlisted',
        site.origin + '/robots.txt',
        'No sitemap directive',
      );
  } catch (error) {
    addCheck(
      checks,
      'unknown',
      'robots_unknown',
      site.origin + '/robots.txt',
      String(error.message).slice(0, 180),
    );
  }
  let targets = [site.origin + site.startPath];
  try {
    const sitemap = await fetchSite(site.origin + site.sitemap, site, get);
    if (sitemap.status !== 200) {
      addCheck(checks, 'error', 'sitemap_http', sitemap.finalUrl, 'HTTP ' + sitemap.status);
    } else if (!/<(?:urlset|sitemapindex)\b/i.test(sitemap.body)) {
      addCheck(checks, 'error', 'sitemap_invalid', sitemap.finalUrl, 'Response is not a sitemap');
    } else {
      const urls = [...sitemap.body.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((m) =>
        unescapeXml(m[1].trim()),
      );
      if (!urls.length)
        addCheck(checks, 'warning', 'sitemap_empty', sitemap.finalUrl, 'No URLs declared');
      if (/<sitemapindex\b/i.test(sitemap.body)) {
        addCheck(
          checks,
          'warning',
          'sitemap_index',
          sitemap.finalUrl,
          'Nested sitemaps not followed; audit explicitly',
        );
      } else {
        const good = [];
        for (const url of urls) {
          try {
            const target = safeTarget(url, site);
            if (!target.pathname.startsWith(site.startPath))
              throw new Error('outside selected path prefix');
            good.push(target.href);
          } catch {
            addCheck(
              checks,
              'warning',
              'sitemap_external_url',
              sitemap.finalUrl,
              'Sitemap URL outside selected host/path',
            );
          }
        }
        const candidates = [...new Set([site.origin + site.startPath, ...good])];
        targets = candidates.slice(0, MAX_PAGES);
        if (candidates.length > MAX_PAGES)
          addCheck(
            checks,
            'warning',
            'sitemap_sampled',
            sitemap.finalUrl,
            'Inspected first ' + MAX_PAGES + ' of ' + candidates.length + ' candidates',
          );
      }
    }
  } catch (error) {
    addCheck(
      checks,
      'unknown',
      'sitemap_unknown',
      site.origin + site.sitemap,
      String(error.message).slice(0, 180),
    );
  }
  for (const url of targets) {
    const summary = await inspectPage(url, site, get, checks);
    if (summary) pages.push(summary);
  }
  return {
    id: site.id,
    origin: site.origin,
    checkedAt: now.toISOString(),
    checkedPages: pages.length,
    pages,
    findings: checks,
    outcome: checks.some((x) => x.severity === 'error')
      ? 'issues'
      : checks.some((x) => x.severity === 'unknown')
        ? 'incomplete'
        : checks.some((x) => x.severity === 'warning')
          ? 'review'
          : 'clear',
    limitation:
      'Checks public HTTP/HTML only. Does not establish Google indexing, Bing indexing, AI citations, search rank or traffic.',
  };
}

export async function auditInventory(raw, deps = {}) {
  const sites = parseSiteInventory(raw);
  const rows = [];
  // Serial requests bound resource usage; no external process or token needed.
  for (const site of sites) rows.push(await auditSite(site, deps));
  return { schemaVersion: 1, generatedAt: (deps.now ?? new Date()).toISOString(), sites: rows };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== '--input' || !argv[1] || argv[1] === '-')
    throw new Error('Usage: npm run sites:audit -- --input /private/public-sites.json');
  const filename = argv[1];
  const input = await readFile(filename);
  if (input.byteLength > 262_144) throw new Error('Site inventory exceeds 256 KiB');
  const report = await auditInventory(JSON.parse(input.toString('utf8')));
  console.log(JSON.stringify(report, null, 2));
  if (report.sites.some((x) => x.outcome === 'issues')) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Site audit refused:', error.message);
    process.exitCode = 1;
  });
}
