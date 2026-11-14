# Upstream provider acceptance

Lifecycle: current

`npm run test:upstream:umami` runs the self-hosted Umami adapter against an
actual official Umami release. It starts the pinned upstream image with a
disposable database, writes a synthetic dataset, reads it back through
Pulse's pinned transport and compares exact stored values.

**Evidence level: upstream runtime, synthetic installation.** The server is
the official release. The installation, users, websites, keys and events are
created by the test and destroyed afterwards. This is not a real account, a
real visitor dataset, a public certificate authority or a real network path.
The connector stays account-unverified until a consenting operator's
instance has been read; see
[self-hosted analytics sources](self-hosted-provider-adapters.md).

## Upstream under test

The pins live in `scripts/upstream-umami.pin.json`.

| Item                | Value                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Release             | Umami v3.5.0, published 12 November 2026                                                               |
| Source commit       | `d3c62a805beda8643cb468924dda38617fb4c286`                                                             |
| Image               | `ghcr.io/umami-software/umami@sha256:b64f40400d77bcadd39cf5c62a1e368c99524ca442024f96e1133355a19a5dbc` |
| Platforms           | `linux/amd64` and `linux/arm64`, each checked against its pinned image ID                              |
| Database            | `docker.io/library/postgres:16` by index digest (PostgreSQL 16.15 when pinned)                         |
| Storage engine path | PostgreSQL only. The ClickHouse query path of Umami is not exercised                                   |

## Run it

```sh
npm run test:upstream:umami
```

Requirements: rootless Podman, Node, curl and network access to pull the
two pinned images on first use. Run this from a source checkout; the harness
is development tooling, not part of the installed runtime package. On a shared
host use the host's test gate. No upstream source build is performed.

The script:

- verifies the pulled image ID against the pin for the host architecture,
- creates an internal Podman network, so the containers reach each other and
  nothing else,
- keeps the database in memory (`tmpfs`) with generated per-run passwords,
- publishes Umami on one loopback port chosen by Podman,
- caps memory (1 GiB and 512 MiB) and process counts, and drops all
  capabilities from the Umami container,
- removes only containers and the network carrying this run's random ownership
  label, plus its temporary directory, on exit. Existing same-name objects are
  refused and never deleted. An image is removed only when this run pulled it
  and its underlying image ID was absent before the pull. Set `PULSE_UPSTREAM_KEEP_IMAGES=1` to keep the
  images for the next run.

It is opt-in and not part of `npm run check` or CI: it needs a container
runtime and a registry.

## How Pulse reaches the instance

Pulse's transport is unmodified. Two test-owned pieces sit between it and
Umami:

- an in-memory certificate authority that issues a certificate for the
  reserved name `umami.pulse-upstream.example`;
- a TLS wrapper on loopback that copies bytes in both directions without
  parsing HTTP. The transport therefore parses the reply exactly as the
  upstream server framed it.

Loopback is refused by every production path. The test admits it through
the symbol-keyed test seam that no setting, flag or configuration field can
produce, so the suite calls `sync` and `probe` as a library. The `pulse`
command line cannot reach this fixture, and that path is not covered here.

## What is checked

| Case                  | Assertion                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Daily values          | Stored pageviews and sessions equal the synthetic counts for each UTC day                                   |
| Day boundaries        | Events at 00:00:00 and 23:59:59 UTC land on the right day; one second outside the window is excluded        |
| Empty day             | A day without events has no row. Pulse does not invent a zero                                               |
| Custom events         | A named event adds neither a pageview nor a session                                                         |
| Wire format           | One connection and one request for the short-window cases, with exact request line, `Host` and four headers |
| Reply framing         | Upstream answers `200`, `application/json`, chunked, without content encoding                               |
| Probe                 | `probe` reads the requested window, reports four rows and stores nothing                                    |
| Website isolation     | Two websites on one instance and the same dates produce separate datasets                                   |
| Credentials           | An API key (`umami_…`) and a login token both work as the instance credential                               |
| Rejected key          | `AUTH`, one request, no retry, and previously stored history is intact                                      |
| Secrecy               | No result, message or exported archive contains a key, a login token or the pinned address                  |
| Long window, upstream | Up to seven calendar months stay daily; a longer request returns monthly buckets (see below)                |
| Long window, Pulse    | Eight bounded requests preserve the exact daily values across the upstream monthly-coarsening boundary      |

## Upstream behaviours an operator should know

These were observed on the pinned release and are asserted by the suite, so
a change in a later release shows up as a failure. Source paths refer to the
pinned commit.

1. **A daily request over more than seven calendar months is answered with
   monthly buckets.** The reply keeps status 200 and the same shape; each
   bucket is labelled with the first day of its month. Umami replaces the
   requested unit when it is finer than its minimum for the range
   (`getRequestDateRange` in `src/lib/request.ts`, `getMinimumUnit` in
   `src/lib/date.ts`). Pulse at `daa7653` stores such a bucket as the value of
   that single day. The corrected collector splits requests at 31 UTC calendar days; the
   acceptance case requires eight successful requests and exact daily values.
   The default lookback of 14 days was unaffected by the upstream coarsening.
2. **A valid key without access gets 401, not 403.** Umami does not
   distinguish a wrong key from a user who cannot view the website
   (`src/app/api/websites/[websiteId]/pageviews/route.ts`). Pulse reports
   both as `AUTH`. If the key is correct, check that its user owns the website
   or is an administrator.
3. **An administrator key reading an unknown website ID gets an empty
   series.** The request succeeds with two empty arrays, so Pulse records a
   successful run without rows. A mistyped website ID then looks like a site
   without traffic. Compare the ID with the instance's website settings when
   a new source stays empty.
4. **A website ID that is not a UUID gets HTTP 500.** Pulse reports
   `UNAVAILABLE` with "Self-hosted provider returned HTTP 500". Pulse's
   configuration accepts any short identifier, so this is the symptom of a
   malformed ID, not of an outage.
5. **Sessions are distinct session identifiers per day** among events that
   are neither custom nor performance events
   (`src/queries/sql/sessions/getSessionStats.ts`). They are a
   provider-defined visitor count, not visits, and are not additive across
   days.
6. **A login token is bound to the password.** It works as a credential.
   According to the source, Umami rejects it after the password changes
   (`src/lib/auth.ts`); the suite does not change a password. Prefer an
   API key, which self-hosted Umami 3.5.0 supports and Pulse sends as a bearer
   token.

## Acceptance result and cleanup contract

On 14 November 2026 the pinned ARM64 upstream image, PostgreSQL 16.15 and
Podman 4.9.3 completed all **12 required tests**, with no failures, skips,
TODOs or cancellations. This includes the corrected long-range collection;
it is an ordinary required assertion, not an expected failure.

The shell checks the test process exit and an unambiguous complete TAP summary.
An empty, incomplete, skipped or TODO-bearing run fails acceptance. Lightweight
unit tests cover this summary check and prove that a pre-existing same-name
container or network cannot authorize cleanup. Cleanup verifies that no object
with this run's ownership label remains. Unrelated containers and pre-existing
cached images are preserved. Interrupted or failed cleanup is a failure, not a
provider-validation success.

This observation is synthetic-installation conformance, not existing-account
access, a public-network deployment or unattended reliability evidence.

## Limits

- One release, one database engine, one architecture per run. Older Umami
  versions and ClickHouse-backed installations are untested.
- Umami has no rate limit of its own in this setup, so the `429` and
  `Retry-After` path is covered only by the synthetic suites.
- No reverse proxy product (Caddy, nginx, Traefik) is involved. A proxy that
  compresses, redirects or rewrites replies is not represented.
- No DNS, public certificate, firewall or private-network admission is
  exercised: the destination is loopback through the test seam.
- The fixture contains small synthetic datasets on two websites. High volume,
  pagination limits and production quota behaviour are untested.
- Plausible Community Edition has no upstream acceptance yet.

## Updating the pin

1. Read the release tag, its commit and the image index digest from the
   official repository and registry. Read the per-architecture image IDs from
   the image manifests.
2. Update `scripts/upstream-umami.pin.json` and the table above.
3. Run the suite. A changed upstream behaviour fails a case named after the
   release; decide whether the adapter or the recorded behaviour changes, and
   update this page in the same change.
