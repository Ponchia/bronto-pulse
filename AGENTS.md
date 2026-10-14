# Bronto Pulse — repository contract

Pulse is a private project-analytics collector and reporter, not a visitor
tracking product. Read [docs/README.md](docs/README.md) before changing behavior.

## Source of truth

- `src/config.ts`: validated resource/project identities and mapping scopes.
- `src/model.ts`: metric meanings and legal aggregation operations.
- `src/collectors/`: bounded provider requests and schema normalization.
- `src/storage/`: portable SQL, leases, staging and publication.
- `src/report.ts`: deterministic reporting; no inferred person-level funnels.
- `src/api/`, `web/`: authenticated read-only reporting; no provider credentials.
- `src/worker.ts`, `src/cli.ts`: execution adapters, not separate business logic.

## Checks

Run `npm run check`, `npm run test:browser`, `npm run test:d1`,
`npm run worker:check`, and `repo-instruction-audit --repo .`.
Use the workspace `box-test-run --` wrapper for expensive checks on the devbox.
Run `git status --short --branch` before editing. Do not overwrite parallel work.

## Hazards

- `.pulse/`, `.env`, `pulse.config.json`, snapshots and reports may contain
  private data. Never commit them, keys, cookies, provider payloads or tokens.
- Do not weaken auth, bypass CI gates, expand arbitrary network origins, or
  accept SQL from the browser or agent API.
- A failed or truncated refresh must not replace prior successful history.
- Counts, snapshots, uniques, ratios and percentiles have different arithmetic.
- Do not silently treat unavailable data as zero or change project attribution
  for historical dates. Record changes with effective dates and stable IDs.
- Production publication, account grants and schedules are explicit operator
  actions. Tests may use only the declared synthetic fixtures.

Use this vendor-neutral file for all coding agents. Never add a CLAUDE.md shim.
