# Contributing

Use Node 24.15+ and the locked npm dependencies. Read AGENTS.md and the docs
router. Open a focused branch; run `npm run check`, browser tests and the local
D1 contract before proposing changes. A fixture must demonstrate each new
provider field, pagination boundary and metric operation. Keep real credentials
and analytics out of commits, reports and screenshots.

New metrics must define units, source timezone, period kind, quality and valid
aggregation. New adapters must preserve old data when a page, token or lease
fails. Interface changes must work at narrow mobile widths and retain keyboard
access. Do not add a visitor tracker, general SQL endpoint or unrestricted
provider URL proxy. Public release/visibility decisions belong to the maintainer.
