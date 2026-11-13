#!/bin/sh
# Portable, bounded one-job-at-a-time scheduler. No third-party cron service.
set -eu
interval="${PULSE_COLLECT_INTERVAL_SECONDS:-900}"
jobs="${PULSE_COLLECT_MAX_JOBS:-1}"
mode="${PULSE_COLLECT_DUE_ONLY:-false}"
case "$interval" in ''|*[!0-9]*) echo "Invalid collector interval" >&2; exit 2 ;; esac
case "$jobs" in ''|*[!0-9]*) echo "Invalid collector job budget" >&2; exit 2 ;; esac
if [ "$interval" -lt 60 ] || [ "$interval" -gt 86400 ] || [ "$jobs" -lt 1 ] || [ "$jobs" -gt 32 ]; then
  echo "Collector interval/jobs outside supported bounds" >&2
  exit 2
fi
case "$mode" in true|false) ;; *) echo "Invalid collector due-time setting" >&2; exit 2 ;; esac
set -- /app/dist/cli.js sync --config /run/pulse/config.json --db /app/.pulse/pulse.db --max-jobs "$jobs"
if [ "$mode" = "true" ]; then
  set -- "$@" --due-only
else
  set -- "$@" --rotate
fi
trap 'exit 0' TERM INT
while :; do
  if node "$@"; then
    : # The CLI gives a nonzero status for failed source jobs; it does not alter valid history.
  else
    echo "Pulse collector cycle failed; inspect the private doctor and run history." >&2
  fi
  sleep "$interval" &
  wait $! || exit 0
done
