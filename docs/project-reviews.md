# Review a project with evidence

Lifecycle: current

Start with a question about a project you maintain. Pulse keeps the repository,
package, website and search observations available for that review, together
with their dates and limitations.

## Try a repository, package and documentation review

From a source checkout with Node.js 24.15 or newer:

```sh
npm ci
npm run demo -- --serve
```

Open the loopback address and use the temporary token printed by the CLI.
Choose **Bronto UI** and a 30-day window. Everything in this installation is
**synthetic**; no accounts or provider requests are needed.

This fictional project has a GitHub repository, an npm package and a scoped
documentation site. Ask:

> What changed around this project, and which check would be useful next?

Choose **Read project briefing** in its project report. The dashboard opens
only that project's findings for the selected dates. Its private link preserves
the project and period when you reload or return with browser history. Use
**Project report** to inspect the supporting evidence or **All project briefings**
to widen the review. The Markdown download keeps the same project and dates.

Follow the source and date references for a supported change. Inspect the npm
download history and GitHub observations, then inspect the documentation
pageviews and their quality information.

The example deliberately includes a sampled documentation observation. That
qualification should travel with the answer. Daily unique viewers are not a
monthly audience total, and package downloads do not count independent users.
Do not divide website pageviews by package downloads to manufacture a funnel.

Now choose **Bronto Annotations**. Its repository history has deliberately
missing days. The review should explain the missing comparison rather than
describe an invented decline. These are different outcomes from the same
review workflow.

For an overlapping website-source comparison, use the separate
[evidence demo](evidence-demo.md). It includes a comparable descriptive
difference and a comparison withheld because source calendars differ.

## Choose the review situation

| Situation              | Start with                                              | Finish with                                                                 |
| ---------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| Routine review         | One project or the portfolio; a useful completed period | One or a few findings worth the owner's attention                           |
| Release or site change | The relevant project and dated release/change context   | Supported observations around the event and an appropriate follow-up window |
| Focused investigation  | A concrete question and selected source/resource        | A supported conclusion, or the exact evidence still missing                 |

For a real installation, use project IDs from its configuration:

```sh
node dist/cli.js review --days 30
node dist/cli.js brief PROJECT --days 30
node dist/cli.js report PROJECT --days 30 --json
```

Those examples use the configured installation. Do not point them at the
synthetic database while interpreting a real project. See
[quickstart](quickstart.md) for setup and [reporting](reporting.md) for date
selection and export contracts.

For a release review, choose completed dates that the sources actually
observe. Inspect the report's baseline and comparison windows. An immediate
post-release check may have too little evidence to support a trend. Release
annotations establish timing, not causation.

## Read a finding before acting

Check the project's resource mapping, exact dates, metric definition,
comparison baseline, observed/expected coverage and relevant quality flags.
A recent successful collection can still contain incomplete or provider-limited
evidence.

Distinguish three things in the answer:

- **Observed:** what the cited source measured over the stated dates.
- **Interpretation:** what that observation could mean, with alternatives.
- **Next check:** a specific verification that can reduce an important uncertainty.

For example, a change in package distribution can justify inspecting the
release and documentation context. It cannot establish new people, bots,
company adoption or search-to-install attribution.

When the answer depends on missing coverage, first inspect collection health
or the read-only plan. Reading a report does not repair a collection, grant a
permission or start a schedule. Use the explicit operator workflow for those
actions.

## Keep a conclusion when it helps

A conclusion can stay in the owner's existing issue, PR or notes. To keep it
in Pulse, write a private JSON input file outside Git. This example is a
template: replace its project, dates, question and conclusion with the actual
review.

```json
{
  "id": "review-docs-20261119",
  "projectId": "my-project",
  "window": { "from": "2026-10-20", "to": "2026-11-18" },
  "question": "Is the documentation change followed by a supported pageview change?",
  "conclusion": "The selected source has insufficient comparable coverage. Recheck after the missing dates are resolved."
}
```

```sh
node dist/cli.js review-record --input /private/project-review.json
node dist/cli.js review-history my-project --limit 20 --json
node dist/cli.js review-history my-project --review-id review-docs-20261119
```

Use the existing installation's `--config` and `--db` when they differ from
the defaults. The write command freezes the bounded project report and stores
its SHA-256 digest with the conclusion. A stable caller-chosen `id` makes an
identical retry safe; it is not permission to overwrite a prior conclusion.
IDs use 8–96 lowercase letters, digits, underscores or hyphens and start with a
letter or digit.

### Save the evidence you reviewed

After investigating through MCP, pass the current result's
`evidenceRef.arguments.expectedRevision` when saving the conclusion:

```sh
node dist/cli.js review-record --input /private/project-review.json \
  --expected-revision CURRENT_EVIDENCE_REVISION
```

Replace the placeholder with the exact 64-character lowercase revision returned
for the same project and dates. This is a current-content revision; it is not
an existing saved review's full snapshot SHA-256. The optional guard excludes
only report generation time. If published evidence, source qualifications or
project context has changed, the command refuses with `CONFLICT` before
creating a new review. Read the evidence again and reconsider the conclusion;
do not simply substitute a new revision to suppress that refusal.

An identical retry checks the original frozen evidence, so later collection
does not break recovery of a successfully saved record. A reused ID whose
frozen evidence differs from the requested revision is refused. A concurrent
save cannot silently substitute another snapshot. Existing records and the
unguarded CLI workflow remain compatible: without this option, a new review
captures the evidence available at save time.

The optional `actionUrl` can point to the owner's existing issue or PR.
A later record may set `followUpOf` to a prior record in the same project.
It appends a new conclusion and evidence snapshot instead of rewriting the
earlier observation. There are no assignees, task states or mandatory notes.

For an existing Workers/D1 installation, an authorized operator can use the
same commands with `--remote-d1`. Provide `PULSE_D1_DATABASE_ID`,
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` through the private
operator environment. This mode reads the hosted configuration and cannot
combine with `--config` or `--db`. The reporting MCP token does not grant
this operator access.

Review records are private and travel in portable backup/restore archives.
The report API and MCP tools expose read-only history and frozen evidence.
In the project dashboard, **Read saved review** opens that record's conclusion
and frozen report. Its private deep link preserves the project and review ID,
including across reload and browser Back/Forward. The date controls are fixed
to the saved evidence window. A preceding-review link opens one record at a
time; **Open current evidence for these dates** explicitly leaves the snapshot.
The frozen view never fills omitted leads or comparisons from later collections.
The owner's explicit CLI command is the write boundary.

A useful result can be “no action justified” or “this question is not measured.”
Recording more notes or making more changes is not itself evidence of value.

The [agent integration](agent-review.md) supports the same review in a coding
assistant. It can return the evidence needed to inspect related code or docs;
changing those files or publishing work follows the user's actual instruction.
The [pilot evaluation](pilot-evaluation.md) compares this workflow with the
owner's existing approach.
