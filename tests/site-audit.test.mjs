import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditInventory,
  auditSite,
  isPublicAddress,
  parseSiteInventory,
  publicSiteUrl,
} from '../scripts/site-audit.mjs';

const origin = 'https://sample.example.org';
const page = (url, attrs = '') =>
  `<!doctype html><html lang="en"><head><title>Document title</title><meta name="description" content="Useful information"><link rel="canonical" href="${url}"><script type="application/ld+json">{}</script>${attrs}</head><body>Article</body></html>`;
const responses = (extra = {}) => {
  const body = {
    [origin + '/robots.txt']: 'User-agent: *\nAllow: /\nSitemap: ' + origin + '/sitemap.xml\n',
    [origin + '/sitemap.xml']:
      `<?xml version="1.0"?><urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/about/</loc></url></urlset>`,
    [origin + '/']: page(origin + '/'),
    [origin + '/about/']: page(origin + '/about/'),
    ...extra,
  };
  const counts = [];
  return {
    counts,
    get: async (url) => {
      counts.push(url.href);
      const item = body[url.href];
      if (typeof item === 'object') return item;
      return item === undefined
        ? { status: 404, body: '', headers: {} }
        : { status: 200, body: item, headers: {} };
    },
  };
};

test('healthy public site records bounded, non-indexing HTTP evidence', async () => {
  const { get, counts } = responses();
  const result = await auditSite(
    { id: 'site', origin, sitemap: '/sitemap.xml' },
    { get, now: new Date('2026-11-16T12:00:00Z') },
  );
  assert.equal(result.outcome, 'clear');
  assert.equal(result.checkedPages, 2);
  assert.equal(result.findings.length, 0);
  assert.equal(result.checkedAt, '2026-11-16T12:00:00.000Z');
  assert.equal(counts.length, 4);
  assert.match(result.limitation, /does not establish Google indexing/i);
});

test('project subpaths on shared hosts remain distinct and never audit a sibling', async () => {
  const path = '/docs-a/';
  const { get, counts } = responses({
    [origin + '/docs-a/robots.txt']: undefined,
    [origin + '/docs-a/sitemap.xml']: undefined,
    [origin + '/robots.txt']: 'User-agent: *\nSitemap: ' + origin + '/docs-a/sitemap.xml',
    [origin + '/docs-a/sitemap.xml']:
      `<urlset><url><loc>${origin}/docs-a/</loc></url><url><loc>${origin}/docs-b/</loc></url></urlset>`,
    [origin + '/docs-a/']: page(origin + '/docs-a/'),
  });
  const [site] = parseSiteInventory({
    version: 1,
    sites: [{ id: 'docs-a', origin, startPath: path, sitemap: '/docs-a/sitemap.xml' }],
  });
  const report = await auditSite(site, { get });
  assert.equal(report.checkedPages, 1);
  assert.equal(counts.includes(origin + '/docs-b/'), false);
  assert.ok(report.findings.some((f) => f.code === 'sitemap_external_url'));
});

test('missing sitemap, noindex and bad canonical are independent issues', async () => {
  const { get } = responses({
    [origin + '/sitemap.xml']: { status: 404, body: '', headers: {} },
    [origin + '/']: page(
      'https://other.example.org/',
      '<meta name="robots" content="noindex,follow">',
    ),
  });
  const result = await auditSite({ id: 'site', origin }, { get });
  assert.equal(result.outcome, 'issues');
  assert.deepEqual(result.findings.map((x) => x.code).sort(), [
    'canonical_differs',
    'noindex_in_sitemap',
    'sitemap_http',
  ]);
});

test('optional localized site checks hreflang without inventing Google results', async () => {
  const { get } = responses();
  const [site] = parseSiteInventory({
    version: 1,
    sites: [{ id: 'loc', origin: origin + '/', multilingual: true }],
  });
  const result = await auditSite(site, { get });
  assert.equal(result.outcome, 'review');
  assert.equal(result.findings.filter((x) => x.code === 'missing_hreflang').length, 2);
});

test('redirects cannot escape the approved exact HTTPS host', async () => {
  const { get, counts } = responses({
    [origin + '/']: {
      status: 302,
      headers: { location: 'https://169.254.169.254/latest/meta-data' },
      body: '',
    },
  });
  const result = await auditSite({ id: 'site', origin }, { get });
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.findings.filter((x) => x.code === 'page_unavailable').length, 1);
  assert.equal(counts.includes('https://169.254.169.254/latest/meta-data'), false);
});

test('invalid public origins, duplicated identities, paths and extra fields refuse before network', async () => {
  for (const input of [
    'http://site.example.com/',
    'https://127.0.0.1/',
    'https://example.local/',
    'https://host.example.org:8443/',
    'https://username:secret@example.org/',
    'https://example.org/secret',
    'https://example.org/?debug=1',
  ])
    assert.throws(() => publicSiteUrl(input), /Only public HTTPS|Invalid site URL/);
  for (const input of [
    { version: 1, sites: [] },
    {
      version: 1,
      sites: [
        { id: 'same', origin },
        { id: 'same', origin },
      ],
    },
    { version: 1, sites: [{ id: 'test', origin, sitemap: '//internal/' }] },
    { version: 1, sites: [{ id: 'test', origin, apiToken: 'must-refuse' }] },
  ])
    assert.throws(() => parseSiteInventory(input));
  await assert.rejects(
    auditInventory({ version: 1, sites: [{ id: 'local', origin: 'https://localhost/' }] }),
  );
});

test('sitemap entity decoding applies exactly once, never converting an escaped entity into markup', async () => {
  const encoded = origin + '/path&amp;lt;safe/';
  const literal = origin + '/path&lt;safe/';
  const { get, counts } = responses({
    [origin + '/sitemap.xml']: '<urlset><url><loc>' + encoded + '</loc></url></urlset>',
    [literal]: page(literal),
  });
  const result = await auditSite({ id: 'site', origin }, { get });
  assert.ok(counts.includes(literal), 'single-unescaped URL was audited');
  assert.ok(
    !counts.some((x) => x.includes('%3C') || x.includes('<safe')),
    'double-decoded markup was never constructed',
  );
  assert.equal(result.checkedPages, 2);
});

test('only global unicast public DNS addresses are accepted', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '172.20.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '169.254.169.254',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
  ])
    assert.equal(isPublicAddress(ip), false, 'blocked: ' + ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])
    assert.equal(isPublicAddress(ip), true, 'public: ' + ip);
});

test('inventory audit retains bounded per-site identity and no guessed traffic', async () => {
  const { get } = responses();
  const result = await auditInventory(
    { version: 1, sites: [{ id: 'sample', origin }] },
    { get, now: new Date('2026-11-16T12:00:00Z') },
  );
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.sites.length, 1);
  assert.equal(result.sites[0].id, 'sample');
  assert.equal(Object.hasOwn(result, 'visitors'), false);
});
