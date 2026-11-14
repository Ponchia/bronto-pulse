#!/usr/bin/env bash
# Conformance acceptance against an actual official Umami release.
#
# Starts the pinned upstream image and a disposable Postgres with rootless
# Podman, on an internal network without outbound access, published on one
# loopback port only. The test file writes a wholly synthetic dataset, reads
# it back through Pulse's pinned transport and compares exact values.
# No external account, user data, secret, public listener or deployment.
#
#   PULSE_UPSTREAM_KEEP_IMAGES=1   keep images this run pulled (default: remove them)
set -euo pipefail
umask 077
for binary in podman node curl; do
  command -v "$binary" >/dev/null || { echo "Missing tool: $binary" >&2; exit 2; }
done
[[ "$(podman info --format '{{.Host.Security.Rootless}}')" == 'true' ]] || {
  echo 'Rootless Podman is required.' >&2; exit 2;
}
root="$(cd "$(dirname "$0")/.." && pwd)"
pin_file="$root/scripts/upstream-umami.pin.json"
pin() { node -e 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],p);if(typeof v!=="string")process.exit(1);console.log(v)' "$pin_file" "$1"; }
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "No pinned upstream image for $(uname -m)." >&2; exit 2 ;;
esac
release="$(pin release)"
commit="$(pin sourceCommit)"
app_image="$(pin image)@$(pin imageIndexDigest)"
app_image_id="$(pin "imageIds.$arch")"
db_image="$(pin database.image)@$(pin database.imageIndexDigest)"

run="pulse-upstream-umami-$$"
net="$run-net"
db="$run-db"
app="$run-app"
tmp="$(mktemp -d /tmp/pulse-upstream-umami.XXXXXXXX)"
pulled=()
status=1
# Only an exact per-run ownership label authorizes cleanup, even if creation
# races a same-name process or fails after creating a stopped container.
owner="$(node -e 'console.log(require("node:crypto").randomBytes(16).toString("hex"))')"
label='io.bronto.pulse.upstream-run'
owned_container() {
  [[ "$(podman container inspect "$1" --format "{{ index .Config.Labels \"$label\" }}" 2>/dev/null)" == "$owner" ]]
}
owned_network() {
  [[ "$(podman network inspect "$1" --format "{{ index .Labels \"$label\" }}" 2>/dev/null)" == "$owner" ]]
}
cleanup() {
  local code=$?
  if (( code != 0 )); then status=$code; fi
  for container in "$app" "$db"; do
    if owned_container "$container"; then podman rm -f -t 2 "$container" >/dev/null 2>&1 || true; fi
  done
  if owned_network "$net"; then podman network rm "$net" >/dev/null 2>&1 || true; fi
  if [[ "${PULSE_UPSTREAM_KEEP_IMAGES:-}" != 1 ]]; then
    for image in ${pulled[@]+"${pulled[@]}"}; do podman image rm "$image" >/dev/null 2>&1 || true; done
  fi
  case "$tmp" in /tmp/pulse-upstream-umami.*) rm -rf -- "$tmp" ;; esac
  # Exact cleanup: nothing carrying this run's ownership label may remain.
  local left
  left="$(podman ps -a --filter "label=$label=$owner" --format '{{.Names}}'; podman network ls --filter "label=$label=$owner" --format '{{.Name}}')"
  if [[ -n "$left" ]]; then
    echo "Cleanup incomplete: $left" >&2
    status=1
  fi
  echo "Upstream fixture cleanup verified; result=$status (entry=$code)."
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if podman container exists "$app" || podman container exists "$db" || podman network exists "$net"; then
  echo "Refusing to reuse existing Podman objects named $run-*." >&2; exit 2
fi
# A new registry reference may resolve to an image already cached under another
# tag. Such an image is not owned by this run and must never be removed.
existing_image_ids="$(podman images --no-trunc --format '{{.ID}}' | sed 's/^sha256://')"
for image in "$app_image" "$db_image"; do
  if ! podman image exists "$image"; then
    echo "Pulling $image"
    podman pull -q "$image" >/dev/null
    resolved_id="$(podman image inspect "$image" --format '{{.Id}}' | sed 's/^sha256://')"
    if ! grep -Fqx "$resolved_id" <<< "$existing_image_ids"; then pulled+=("$image"); fi
  fi
done
actual_id="$(podman image inspect "$app_image" --format '{{.Id}}')"
[[ "$actual_id" == "$app_image_id" ]] || {
  echo "Upstream image is not the pinned $arch build of $release." >&2; exit 1;
}

secret() { node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))'; }
db_password="$(secret)"
printf 'POSTGRES_DB=umami\nPOSTGRES_USER=umami\nPOSTGRES_PASSWORD=%s\n' "$db_password" > "$tmp/db.env"
printf 'DATABASE_URL=postgresql://umami:%s@db:5432/umami\nAPP_SECRET=%s\nDISABLE_TELEMETRY=1\nDISABLE_UPDATES=1\n' \
  "$db_password" "$(secret)" > "$tmp/app.env"

# Internal: the containers reach each other and nothing else.
podman network create --internal --label "$label=$owner" "$net" >/dev/null
podman run -d --name "$db" --label "$label=$owner" --network "$net" --network-alias db \
  --memory 512m --pids-limit 200 \
  --tmpfs /var/lib/postgresql/data:rw,size=512m \
  --env-file "$tmp/db.env" "$db_image" >/dev/null
# The image first runs a socket-only server to initialise; TCP readiness
# means the final server is up.
ready=''
for _ in $(seq 1 60); do
  if podman exec "$db" pg_isready -q -h 127.0.0.1 -U umami -d umami >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
[[ -n "$ready" ]] || { echo 'Disposable database did not become ready.' >&2; exit 1; }

podman run -d --name "$app" --label "$label=$owner" --network "$net" \
  --memory 1g --pids-limit 300 \
  --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1::3000 \
  --env-file "$tmp/app.env" "$app_image" >/dev/null
port="$(podman port "$app" 3000/tcp)"
[[ "$port" == 127.0.0.1:* ]] || { echo 'Upstream port is not loopback-only.' >&2; exit 1; }
port="${port##*:}"
ready=''
for _ in $(seq 1 90); do
  if [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/api/heartbeat" || true)" == 200 ]]; then
    ready=1; break
  fi
  [[ "$(podman inspect "$app" --format '{{.State.Running}}')" == true ]] || break
  sleep 2
done
[[ -n "$ready" ]] || {
  echo 'Upstream Umami did not become ready. Last log lines:' >&2
  podman logs --tail 20 "$app" >&2 || true
  exit 1
}

echo "Upstream under test: Umami $release (source $commit)"
echo "  image $app_image"
echo "  image id $actual_id ($arch), $(podman exec "$db" postgres --version), podman $(podman --version | awk '{print $3}')"
set +e
(cd "$root" && PULSE_UPSTREAM_UMAMI_PORT="$port" \
  node --import tsx --test --test-reporter=tap tests/upstream-provider/umami.acceptance.ts) | tee "$tmp/test.log"
status=${PIPESTATUS[0]}
set -e
# A process exit alone is insufficient: every declared case must pass, with
# no TODO, skipped, cancelled or missing summary masquerading as acceptance.
if [[ "$status" == 0 ]] && node "$root/scripts/upstream-result.mjs" "$tmp/test.log"; then
  echo "Umami $release conformance acceptance passed (synthetic local instance, not a real account)."
else
  status=1
  echo "Umami $release conformance acceptance FAILED." >&2
fi
