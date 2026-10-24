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

The detailed [maintainer guide](docs/releasing.md) explains installed-consumer
verification and the CI trust boundary. Use the repository’s structured issue forms
for reproducible defects with synthetic inputs. No change is considered tested
merely because its own working directory happens to contain untracked fixtures.
New tests must be committed and pass from a clean clone. The code owner reviews
changes to source semantics, auth, migrations and release safeguards.

## Public development

Contributions do not require access to a maintainer account, remote development
host or private database. Use the synthetic demo and fixtures. Run
`npx playwright install --with-deps chromium` before the browser suite on Linux.
A maintainer's optional workspace wrappers are not part of the public toolchain.

Bronto Pulse uses AI-assisted implementation and review. Disclose material generated
contributions where useful and include tests; model output is not evidence that
behavior is correct. Do not submit confidential prompts, account data or material
whose license does not permit contribution. Keep discussions respectful and
technical; the maintainer may close abusive or off-topic contributions.

## Optional operator backup helper

The Unix operator backup helper and its synthetic archive regression require
Python 3 with the standard-library SQLite module. Hosted Ubuntu verification
includes this dependency. The collector and browser dashboard do not use Python.
No timer, live export, credential or off-box destination is installed by tests.
