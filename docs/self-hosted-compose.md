# Portable single-host deployment

Lifecycle: current

Pulse does not need Cloudflare Workers or D1 to run. The **same core**, reports,
API and existing collectors work with Node.js 24.15+, SQLite and the included
Docker image. This path is intended for a single machine, VPS or a single
persistent-volume pod; it is **not** a multi-replica/HA configuration. An
alternative Worker+D1 installation remains supported.

## Before starting

1. Copy `.env.example` to the ignored `.env` file. Generate a fresh
   `PULSE_API_TOKEN` of at least 24 characters using a cryptographic RNG; never
   use the example as a secret. Set `PULSE_PUBLIC_ORIGIN=https://pulse.example.org`
   to the exact hostname of your trusted TLS reverse proxy. Supply only the
   provider credentials you intend to use.
2. Create the ignored `.pulse-container/data` directory, accessible to UID
   1000 inside the image; never bind-mount a world-readable directory.
3. Place a reviewed `.pulse-container/pulse.config.json` with your source
   mappings. See [configuration](configuration.md) and [provider permissions](providers.md).
   Keep it outside the Docker build context and Git. Do not mix synthetic demo
   config with live history.
4. Configure a TLS proxy (Caddy, nginx, Traefik or equivalent) to
   `127.0.0.1:4177` **on the Docker host**. It must preserve the original
   `Host` header, terminate HTTPS, and block direct Internet access to the
   container port. Do not trust arbitrary `X-Forwarded-Host` or
   `X-Forwarded-Proto`; the server ignores them.

Example:

```sh
cp .env.example .env
mkdir -p .pulse-container/data
chmod 700 .pulse-container/data
# On Linux, ensure the data dir is writable by the image's node user (UID 1000).
# Generate/store PULSE_API_TOKEN securely; edit .env and config before running.
docker compose config --quiet
docker compose up -d --build dashboard
```

The compose file maps container port 4177 to **127.0.0.1 only** on the host.
Inside the container, `--host 0.0.0.0` is deliberately enabled **only**
alongside the exact `--public-origin` and an explicitly supplied strong token.
Without both, the service refuses to start. Default standalone
`pulse serve` continues to bind loopback and can generate a one-session
token without opening a public listener.

Do not change the port map to `0.0.0.0:4177:4177`. No TLS terminator or identity
broker is installed automatically. An optional owner-only access policy in
your reverse proxy can complement Pulse's token login.

## Collector and data volume

```sh
# Enable a separate bounded collector only after source access is reviewed.
docker compose --profile collect up -d collector
docker compose logs --tail 20 collector
```

The optional collector runs `pulse sync --rotate --max-jobs 1` on the same
SQLite volume at a 900-second interval by default. Review your provider
quotas, requested groups, API limits and collection delay before increasing
`PULSE_COLLECT_MAX_JOBS` (maximum 32). Jobs rotate with a durable database
cursor. One job per quarter hour means 56 groups take roughly 14 hours
to complete one rotation; this is **not** an independent hourly freshness
guarantee.

A failed source job leaves the previous successfully published observations
intact and is visible in `doctor` and private run history. The collection
loop does not provide a distributed queue, high availability, priority
scheduling or alert delivery. It never copies the Cloudflare D1 database:
use the explicit private export/import workflow for a migration, importing
into an **empty** SQLite database and verifying it before cutting over.

Do not run multiple collectors/replicas or share SQLite across network
filesystems. WAL locking and 5-second busy timeouts are appropriate for the
small single-host layout, not an HA database. Avoid placing the database on
an ephemeral pod filesystem.

## Repeatable OCI smoke test (optional)

From the source checkout on a Linux host with rootless Podman, curl and
Node.js installed, run:

```sh
npm run test:oci
```

This builds a fresh image from the current checkout and launches only a
**synthetic** Pulse installation, with an ephemeral localhost-bound port
and SQLite volume. It verifies unauthorized requests, Host-header spoofing,
same-origin login, a Secure session cookie, and surviving a container restart.
It drops privileges, cleans the image, container and synthetic database
even on failure, and never uses real provider credentials.

This does **not** test your external HTTPS reverse proxy, Docker Compose
orchestrator, real API permissions or an encrypted off-host restore. Verify
those separately before production use. It is deliberately not part of the
default npm check so contributors without Podman can run the ordinary
offline unit tests.

## Verification and recovery

```sh
docker compose ps
# Your browser opens https://pulse.example.org with the configured token.
docker compose run --rm dashboard doctor --config /run/pulse/config.json \
  --db /app/.pulse/pulse.db --json
docker compose run --rm dashboard export --config /run/pulse/config.json \
  --db /app/.pulse/pulse.db --out /app/.pulse/private-export.json
```

The exported file contains private history. Move/encrypt it into an
independent backup destination, verify a restore in a separate empty database,
and limit retention according to data sensitivity. An export inside the same
volume is **not** an off-box backup. Preserve the private configuration,
credentials and archive independently of the runtime.

The unauthenticated `/health` endpoint proves process liveness only.
Check `/api/v1/health` through authenticated access for collection health.
Use a real browser behind your proxy to verify token login, session cookie
`Secure` flag, CSRF rejection and private report views before opening the
service to users.

For migration from an existing Cloudflare/D1 installation, the
[offline D1-to-SQLite recovery proof](d1-to-sqlite-recovery.md)
verifies both raw backup integrity and portable published-report parity
before any production cutover.

## Runtime support matrix

| Profile                      | State                                          | Storage                            | Scheduler                          | Network                                 |
| ---------------------------- | ---------------------------------------------- | ---------------------------------- | ---------------------------------- | --------------------------------------- |
| Node local/SSH               | Supported                                      | SQLite                             | External cron or one-shot CLI      | Loopback by default                     |
| Docker Compose, single host  | Included; validate on your infrastructure      | Shared-volume SQLite               | Optional bounded collector sidecar | Loopback host port + external TLS proxy |
| Cloudflare Worker            | Operationally verified in private installation | D1                                 | Two bounded cron triggers          | Owner-only Access + token boundary      |
| Kubernetes                   | Design target, not a supported HA release      | Single writable PVC only for pilot | External CronJob or one collector  | Authenticated ingress required          |
| Multiple replicas/PostgreSQL | Planned, not implemented                       | Future DB adapter                  | Durable due-time worker            | Future deployment guide                 |

Node and Worker must keep identical report semantics. Nothing in the
portable example enables a paid Cloudflare resource, a SaaS account, a new
visitor tracker or a hosted Pulse service.
