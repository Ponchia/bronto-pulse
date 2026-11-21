#!/usr/bin/env bash
# Explicit opt-in synthetic OCI acceptance test for the portable Pulse image.
# Requires rootless Podman, curl and Node; uses no real provider data or tokens.
set -euo pipefail
umask 077

command -v podman >/dev/null || { echo 'Rootless Podman is required.' >&2; exit 2; }
command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 2; }
command -v node >/dev/null || { echo 'Node is required.' >&2; exit 2; }
[[ "$(podman info --format '{{.Host.Security.Rootless}}')" == "true" ]] || {
  echo 'This test must run under rootless Podman.' >&2
  exit 2
}

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${PULSE_SMOKE_IMAGE:-localhost/pulse-oci-smoke:$$}"
owned_image=true
if [[ -n "${PULSE_SMOKE_IMAGE:-}" ]]; then
  owned_image=false
  podman image exists "$image" || { echo "The supplied smoke image is not local." >&2; exit 2; }
fi
tmp="$(mktemp -d /tmp/pulse-oci-smoke.XXXXXXXX)"
container="pulse-oci-smoke-$$"
token='synthetic-oci-strong-test-token-only-0123456789'
cleanup() {
  podman rm -f "$container" >/dev/null 2>&1 || true
  if [[ "$owned_image" == "true" ]]; then
    podman image rm "$image" >/dev/null 2>&1 || true
  fi
  if [[ -n "${tmp:-}" && "$tmp" == /tmp/pulse-oci-smoke.* ]]; then
    podman unshare chown -R 0:0 "$tmp/data" >/dev/null 2>&1 || true
    rm -rf -- "$tmp"
  fi
}
trap cleanup EXIT

# The synthetic manifest has no live source grants and never triggers sync.
mkdir -m 700 "$tmp/data"
chmod 755 "$tmp"
cat > "$tmp/pulse.config.json" <<'JSON'
{"version":1,"demo":true,"name":"OCI synthetic acceptance","resources":[{"id":"sample","provider":"npm","package":"@example/package"}],"projects":[{"id":"demo","label":"Synthetic proof project","resources":[{"resource":"sample"}]}]}
JSON
chmod 644 "$tmp/pulse.config.json"
podman unshare chown 1000:1000 "$tmp/data"

port="$(node -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
url="http://127.0.0.1:$port"
origin='https://pulse.example.test'

# No live credentials or Cloudflare resources are accessed by the synthetic test.
if [[ "$owned_image" == "true" ]]; then
  podman build --pull=missing -t "$image" -f "$root/Dockerfile" "$root" > "$tmp/build.log" 2>&1 || {
    echo 'Image build failed (last output):' >&2
    tail -20 "$tmp/build.log" >&2
    exit 1
  }
fi

launch() {
  podman run -d --name "$container" \
    --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    -e "PULSE_API_TOKEN=$token" \
    -v "$tmp/pulse.config.json:/run/pulse/config.json:ro,Z" \
    -v "$tmp/data:/app/.pulse:Z" \
    -p "127.0.0.1:$port:4177" \
    "$image" serve --host 0.0.0.0 --public-origin "$origin" \
    --port 4177 --config /run/pulse/config.json --db /app/.pulse/pulse.db \
    > "$tmp/container-id"
}

ready() {
  local n=0 code=''
  until [[ "$code" == '200' ]]; do
    code="$(curl -s -o /dev/null --max-time 1 -w '%{http_code}' \
      -H 'Host: pulse.example.test' "$url/health" || true)"
    n=$((n + 1))
    if (( n >= 40 )); then
      podman logs "$container" 2>&1 | tail -20 >&2 || true
      echo 'Synthetic OCI dashboard did not become ready.' >&2
      exit 1
    fi
    [[ "$code" == '200' ]] || sleep .2
  done
}

expect_status() {
  local expected="$1"
  shift
  local got
  got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@")"
  if [[ "$got" != "$expected" ]]; then
    echo "HTTP acceptance failed: expected $expected, received $got." >&2
    exit 1
  fi
}

launch
ready
expect_status 200 -H 'Host: pulse.example.test' "$url/health"
expect_status 401 -H 'Host: pulse.example.test' "$url/api/v1/projects"
expect_status 403 -H 'Host: wrong.example.test' -H 'X-Forwarded-Host: pulse.example.test' "$url/health"
owner="$(curl -s --max-time 5 -H 'Host: pulse.example.test' -H "Authorization: Bearer $token" "$url/api/v1/projects")"
grep -q 'Synthetic proof project' <<<"$owner"
expect_status 403 -X POST -H 'Host: pulse.example.test' \
  -H 'Origin: https://wrong.example.test' --data-urlencode "token=$token" "$url/login"
curl -s --max-time 5 -D "$tmp/login.headers" -o /dev/null \
  -X POST -H 'Host: pulse.example.test' \
  -H 'Origin: https://pulse.example.test' \
  --data-urlencode "token=$token" "$url/login"
grep -Eiq '^set-cookie: pulse_session=.*; HttpOnly; SameSite=Strict; .*Secure' "$tmp/login.headers"
podman unshare test -s "$tmp/data/pulse.db"
# Configuration is reconstructed on startup, so seeing a project alone cannot
# prove persistence. Write a row that only the running installation contains.
podman exec "$container" node dist/cli.js annotate \
  --config /run/pulse/config.json --db /app/.pulse/pulse.db \
  --resource sample --title 'synthetic-oci-restart-sentinel' --date 2026-01-01 \
  > "$tmp/annotation-result"

podman stop -t 3 "$container" >/dev/null
podman rm "$container" >/dev/null
launch
ready
resumed="$(curl -s --max-time 5 -H 'Host: pulse.example.test' -H "Authorization: Bearer $token" "$url/api/v1/projects")"
grep -q 'Synthetic proof project' <<<"$resumed"
podman exec "$container" node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync("/app/.pulse/pulse.db", { readOnly: true });
  const count = db.prepare("SELECT count(*) AS n FROM annotations WHERE title = ? AND resource_id = ? AND date = ?")
    .get("synthetic-oci-restart-sentinel", "sample", "2026-01-01").n;
  db.close();
  if (count !== 1) throw new Error("Synthetic annotation did not survive restart.");
'
printf '%s\n' 'OCI_SMOKE_PASSED: exact local image, loopback port, auth, Host/Origin rejection, Secure session and SQLite restart persistence.'
printf '%s\n' 'Not tested: external TLS termination, Docker Compose orchestration, D1 migration or live provider credentials.'
