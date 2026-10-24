# Offline AI visibility benchmark

Lifecycle: current

The operator CLI prepares and scores manually captured answers. It makes no
model/API calls, uses no credentials and creates no billing or schedule.
The [example suite](../examples/visibility-suite.json) contains 12 unbranded
discovery prompts: 6 for Sense6 and 6 for Bronto packages (2 per package).
Sense6 cases cover general discovery, reaction time without an account,
the `tetrachromacy-limits` prompt, hearing/device limits, Italian and Spanish.
The 3 branded controls cover Sense6, Zeno Trevisan/Ponchia and the
`brontolotto.observer` portfolio, and the responsibilities of all 3 packages.
Package discovery prompts also score the portfolio target, so citations and
links to both requested websites remain measurable. English is primary, with
selected Italian and Spanish cases. Suite version `1.1.0` defines a curated
sample, not a market-share estimate or a measure of overall market visibility.

## Prepare a session

Copy [the session example](../examples/visibility-session.json) outside Git and
replace its provider, product/interface, displayed model (or `unknown`), date,
search mode, conversation context and repeat count with your intended test.
Use a fresh conversation for each prompt and repeat, without previous answers
or brand hints. Record `continuing` or `unknown` when that condition is not met;
those sessions remain separate. Freeze the suite before recording answers.

```sh
pulse visibility template --suite examples/visibility-suite.json \
  --session /private/session.json --out /private/runs.json
pulse visibility report --suite examples/visibility-suite.json \
  --input /private/runs.json --out /private/visibility-report.json
```

These commands run without project configuration, database access or network
access. `--out` uses an exclusive file with mode 0600. Store answer files in a
private directory outside the repository; they can contain sensitive text.
The generated [suite schema](../schemas/visibility-suite.schema.json) and
[run schema](../schemas/visibility-runs.schema.json) describe the versioned
format. Runtime validation also checks references, hashes and contradictory
evidence. Do not change the prompt text, language, classification or target IDs
after a run: its SHA-256 hash must match. Use a new suite version for revisions
and retain the old suite alongside historical results.

## Capture and review evidence

Each planned run has `sessionId`, `promptId`, `promptHash`, `language`, `repeat`,
`status`, `rawAnswer`, `citations` and `reviews`. Retain the exact answer privately
in `rawAnswer`; set `status` to `completed` only when an answer was captured.
Use `unrun` or `error` with a null answer, null citations and empty reviews
otherwise. Missing run records remain unknown in the expected session matrix.

Capture actual product source-panel citations separately as an object with its
URL and evidence pointer:

```json
{
  "url": "https://sense6.net/en/",
  "evidence": "Source-panel citation 1 in private capture"
}
```

A link generated in the answer alone is not a provider citation. Use `[]` only
after confirming the product supplied no citations; use `null` when citation
evidence was unavailable. Pulse validates supplied evidence, but cannot verify
that a manually entered citation came from the provider.

| Signal              | Evidence and meaning                           |
| ------------------- | ---------------------------------------------- |
| `mention`           | Alias boundary match in answer text            |
| `link`              | Answer URL within target host and path         |
| `citation`          | Captured provider citation for a target URL    |
| `recommendation`    | Human review of a suggestion to use the target |
| `misrepresentation` | Human review of an inaccurate claim            |

Review entries name `targetId`, `reviewer`, `reviewedAt`, nullable boolean
`recommendation` and `misrepresentation`, and explanatory `notes`. For example,
the Sense6 accuracy control asks about diagnostic and research claims; verify
the answer against current project evidence before applying a label. No LLM
judge is invoked. Duplicate/conflicting reviews and positive labels without
any target mention, link or citation are rejected. A recommendation can also
contain a misrepresentation, so these two labels are independent.

Reports show positive, observed and unknown counts for every signal. Any rate
you derive must use `positive / observed`; no observed evidence means unknown.
Missing, `unrun` and error records never enter the observed denominator. Branded
and unbranded prompts, languages, products, models, dates, search modes and
conversation contexts remain separate in session groups. Repeat runs aggregate
only inside the same session; their raw records keep repeat IDs. Reports omit
raw answers and citations; preserve the private run file as the evidence source.

## Optional `promptfoo` export

```sh
pulse visibility promptfoo --suite examples/visibility-suite.json \
  --out /private/promptfoo.json
```

The adapter exports `prompts` and `tests.vars`, including prompt IDs and hashes,
with an empty `providers` array. It installs and executes nothing. An operator
must deliberately configure a provider and separately run an external tool.
External execution can incur charges. Import captured answers into the private
run format manually, preserving actual metadata and citation provenance.
API/CLI model responses do not establish how a consumer chat product behaves.
See the [configuration reference](https://www.promptfoo.dev/docs/configuration/guide/).
