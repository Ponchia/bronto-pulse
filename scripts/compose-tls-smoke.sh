#!/usr/bin/env bash
# Synthetic, rootless Compose + local HTTPS reverse-proxy acceptance.
# Uses temporary credentials, site config and SQLite; no external accounts.
set -euo pipefail
umask 077
for binary in podman podman-compose caddy openssl curl node; do
  command -v "$binary" >/dev/null || { echo "Missing tool: $binary" >&2; exit 2; }
done
[[ "$(podman info --format '{{.Host.Security.Rootless}}')" == 'true' ]] || {
  echo 'Rootless Podman is required.' >&2; exit 2;
}
root="$(cd "$(dirname "$0")/.." && pwd)"
[[ ! -e "$root/.env" && ! -L "$root/.env" &&
   ! -e "$root/.pulse-container" && ! -L "$root/.pulse-container" ]] || {
  echo 'Refusing to overwrite existing private Compose configuration.' >&2; exit 2;
}
tmp="$(mktemp -d /tmp/pulse-compose-tls-smoke.XXXXXXXX)"
project="pulse-tls-$$"
image="localhost/pulse-compose-tls-smoke:$$"
token='synthetic-compose-strong-token-never-production-2026'
proxy_pid=''
cleanup() {
  if [[ -n "$proxy_pid" ]]; then
    kill "$proxy_pid" >/dev/null 2>&1 || true
    wait "$proxy_pid" >/dev/null 2>&1 || true
  fi
  (cd "$root" && podman-compose -f compose.yaml -p "$project" down >/dev/null 2>&1) || true
  podman image rm "$image" >/dev/null 2>&1 || true
  if [[ -d "$root/.pulse-container/data" ]]; then
    podman unshare chown -R 0:0 "$root/.pulse-container/data" >/dev/null 2>&1 || true
  fi
  # Only delete artifacts carrying this run's explicit markers. An unrelated
  # file created concurrently must never be treated as our private data.
  if [[ -f "$root/.env" ]] && grep -Fxq "PULSE_IMAGE=$image" "$root/.env"; then
    rm -f -- "$root/.env"
  fi
  if [[ -f "$root/.pulse-container/.pulse-compose-smoke-owned" ]] &&
     grep -Fxq "$project" "$root/.pulse-container/.pulse-compose-smoke-owned"; then
    rm -rf -- "$root/.pulse-container"
  fi
  case "$tmp" in /tmp/pulse-compose-tls-smoke.*) rm -rf -- "$tmp" ;; esac
}
trap cleanup EXIT

tcp_port() {
  node -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}
backend_port="$(tcp_port)"
tls_port="$(tcp_port)"
while [[ "$tls_port" == "$backend_port" ]]; do tls_port="$(tcp_port)"; done
origin="https://pulse.example.test:$tls_port"
mkdir -m 755 "$root/.pulse-container"
printf '%s\n' "$project" > "$root/.pulse-container/.pulse-compose-smoke-owned"
chmod 600 "$root/.pulse-container/.pulse-compose-smoke-owned"
mkdir -m 700 "$root/.pulse-container/data"
cat > "$root/.pulse-container/pulse.config.json" <<'JSON'
{"version":1,"demo":true,"name":"Compose TLS synthetic acceptance","resources":[{"id":"sample","provider":"npm","package":"@example/package"}],"projects":[{"id":"synthetic","label":"Synthetic HTTPS proof","resources":[{"resource":"sample"}]}]}
JSON
chmod 644 "$root/.pulse-container/pulse.config.json"
podman unshare chown 1000:1000 "$root/.pulse-container/data"
cat > "$root/.env" <<VARS
PULSE_API_TOKEN=$token
PULSE_PUBLIC_ORIGIN=$origin
PULSE_LOCAL_PORT=$backend_port
PULSE_IMAGE=$image
VARS
chmod 600 "$root/.env"

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj '/CN=pulse.example.test' \
  -addext 'subjectAltName=DNS:pulse.example.test' \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" > "$tmp/cert.log" 2>&1
cat > "$tmp/Caddyfile" <<CADDY
{
  admin off
  auto_https disable_redirects
}
https://pulse.example.test:$tls_port {
  tls $tmp/cert.pem $tmp/key.pem
  reverse_proxy 127.0.0.1:$backend_port {
    header_up Host pulse.example.test:$tls_port
  }
}
CADDY

cd "$root"
podman-compose -f compose.yaml -p "$project" config > "$tmp/compose.config" 2> "$tmp/config.log" || {
  echo 'Compose config failed.' >&2; exit 1;
}
podman-compose -f compose.yaml -p "$project" up -d --build dashboard > "$tmp/up.log" 2>&1 || {
  echo 'Compose build/start failed; private diagnostics suppressed.' >&2; exit 1;
}
caddy run --config "$tmp/Caddyfile" --adapter caddyfile > "$tmp/caddy.log" 2>&1 &
proxy_pid="$!"

tls_curl() {
  curl --noproxy '*' --silent --show-error --max-time 5 \
    --resolve "pulse.example.test:$tls_port:127.0.0.1" \
    --cacert "$tmp/cert.pem" "$@"
}
status() {
  tls_curl -o /dev/null -w '%{http_code}' "$@"
}
ready() {
  local code='' n
  for n in $(seq 1 70); do
    code="$(status "$origin/health" 2>/dev/null || true)"
    [[ "$code" == '200' ]] && return 0
    sleep .2
  done
  echo 'Synthetic HTTPS dashboard did not become ready.' >&2; exit 1;
}
expect() {
  local expected="$1"; shift
  local got
  got="$(status "$@")"
  if [[ "$got" != "$expected" ]]; then
    echo "HTTPS check failed: expected $expected, got $got." >&2; exit 1;
  fi
}

ready
expect 200 "$origin/health"
expect 401 "$origin/api/v1/projects"
expect 403 -X POST -H 'Origin: https://wrong.example.test' \
  --data-urlencode "token=$token" "$origin/login"
expect 303 -X POST -H "Origin: $origin" --data-urlencode "token=$token" "$origin/login"
tls_curl -D "$tmp/login.headers" -o /dev/null -X POST \
  -H "Origin: $origin" --data-urlencode "token=$token" "$origin/login"
grep -Eiq '^set-cookie: pulse_session=.*; HttpOnly; SameSite=Strict; .*Secure' "$tmp/login.headers"
tls_curl -H "Authorization: Bearer $token" "$origin/api/v1/projects" > "$tmp/authorized.json"
grep -q 'Synthetic HTTPS proof' "$tmp/authorized.json"
backend_code="$(curl --noproxy '*' --silent -o /dev/null -w '%{http_code}' --max-time 5 \
  -H 'Host: wrong.example.test' -H 'X-Forwarded-Host: pulse.example.test' \
  "http://127.0.0.1:$backend_port/health")"
[[ "$backend_code" == '403' ]] || { echo 'Backend Host-spoofing guard failed.' >&2; exit 1; }
podman unshare test -s "$root/.pulse-container/data/pulse.db"

podman-compose -f compose.yaml -p "$project" stop dashboard > "$tmp/stop.log" 2>&1
podman-compose -f compose.yaml -p "$project" start dashboard > "$tmp/start.log" 2>&1
ready
tls_curl -H "Authorization: Bearer $token" "$origin/api/v1/projects" > "$tmp/restarted.json"
grep -q 'Synthetic HTTPS proof' "$tmp/restarted.json"
printf '%s\n' 'COMPOSE_TLS_SMOKE_PASSED: rootless Compose build, loopback-only backend, trusted local HTTPS proxy, Host/Origin/token boundaries, Secure session and SQLite restart persistence.'
printf '%s\n' 'Not tested: public DNS/ACME, live provider credentials, production permissions, external HA or Kubernetes.'
