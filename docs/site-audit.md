# Bounded public-site SEO checks

Lifecycle: current

The optional `npm run sites:audit -- --input /private/public-sites.json` command
reads an explicit inventory and makes bounded read-only HTTPS requests from a
Node operator host. It is independent of Pulse's provider collectors, private
dashboard, Worker scheduler, paid services and browser tracking. It never
queries Google or Bing, installs a visitor script, or claims a URL is indexed.
It does not add anonymous counts to Pulse or create a new provider identity.

## Inventory

Keep the actual website inventory **outside Git**. The example below contains
a fictional domain; substitute your verified public hosts.

```json
{
  "version": 1,
  "sites": [
    {
      "id": "example",
      "origin": "https://www.example.org/",
      "startPath": "/docs/",
      "sitemap": "/docs/sitemap.xml",
      "multilingual": false
    }
  ]
}
```

The command checks `robots.txt`, the sitemap and up to eight same-host page
URLs (starting at `startPath`, default `/`; this also supports GitHub Pages
projects sharing one hostname). It reports HTTP errors, missing metadata, mismatched canonicals,
explicit `noindex` in sitemap pages, missing `hreflang` when the inventory
marks a site multilingual, and incomplete responses. Findings are annotated
with their exact URL and a bounded reason. The first page is always included
even if its sitemap is missing. A sitemap index receives an explicit
`sitemap_index` warning instead of pretending every nested URL was checked.
The report notes sampling rather than treating the sample as the entire site.

This is an operator-only command. Strict HTTPS public-host validation, private
address rejection, DNS pinning, two-redirect limit, exact-host redirects, a
one-MiB response cap and eight-second request timeout limit unexpected egress.
No cookies, authentication or account credentials are sent. Only run
inventories you have reviewed; it is not a web crawler-as-a-service or an
untrusted-url endpoint.

Reports are JSON on stdout. Exit 0 means no confirmed critical issues, although
warnings or unknowns may still need review; exit 2 means a confirmed HTTP or
HTML issue; exit 1 means invalid inputs or fatal CLI failure. Do not use exit
0 as an SEO success score. Search Console performance, its URL Inspection
API, Bing indexing and verified AI citations remain separate, provider-native
sources with their own quality and authorization contracts.

For real portfolios, first obtain consent for collection from each site
owner, keep business/property analytics separated where appropriate, and review
the report before surfacing any conclusions in Pulse's private annotations.
