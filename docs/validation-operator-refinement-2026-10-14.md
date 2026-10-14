# Operator workflow refinement — 14 October 2026

Lifecycle: archive

Historical pre-publication validation record. For current source availability,
CI and deployment boundaries, see [maintainer releases](releasing.md).

This review extends the initial implementation; it does not supersede the live
activation work in repository issue #1. No provider account grants, production
routes, hosted schedules, paid plans or public repository/package visibility
were changed.

## Changes reviewed

- Offline planning and dry-run commands, bounded serial backfill and explicit
  provider-window clipping/current-only snapshot notes.
- Deterministic briefings and CSV/Markdown output with private download boundaries.
- Snapshot net changes, quality-aware comparison gating and mapping-date boundaries.
- Per-group probes, observed-date health, run-age diagnosis and targeted next steps.
- Lease cleanup after failed run creation; partitioned rotation cursors.
- Package consumer imports, schema/migration consistency, issue templates,
  ownership, dependency updates and safer trusted-runner routing.
- Accessible navigation, 320-pixel layouts, keyboard activation, private downloads,
  reloadable view URLs and failed-refresh export protection.

## Evidence

The full local unit/CLI/API suite and browser suite are required before the
change is handed off. Local D1 validation exercises actual SQL window queries,
JSON1 publication and independent restore equivalence. Package verification
installs the packed tarball in an empty offline consumer and runs its imports
and CLI commands. Documentation links, schema parity, formatting and strict
source/test TypeScript are part of `npm run check`.

The existing private GitHub/npm pilot was read without additional provider
requests. All four project reports still match its independent restored copy;
the new briefings and CSV reports were generated without exposing payloads.
This is compatibility evidence, not new Cloudflare/GSC/D1 authorization evidence.

Hosted CI previously failed before executing a step because of account billing.
The repository currently has no attached self-hosted runner. Local passing checks
must not be represented as hosted CI success. The change retains this blocker
rather than changing billing, attaching a privileged runner or bypassing a gate.

## Deliberate limits

Backfill is a bounded series of complete chunks, not a resumable page queue.
Offline plans cannot know account-specific Cloudflare entitlements. Data-lag
signals are operator heuristics, not proof that absent dates should contain
zeroes. Briefings do not establish causal release effects or unique-person
conversion funnels. Snapshot net changes depend on adequate dated baselines.
