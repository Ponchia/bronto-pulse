#!/bin/sh
# Portable, bounded one-job-at-a-time scheduler. No third-party cron service.
set -eu
interval="${PULSE_COLLECT_INTERVAL_SECONDS:-900}"
jobs="${PULSE_COLLECT_MAX_JOBS:-1}"
mode="${PULSE_COLLECT_DUE_ONLY:-false}"
ready="${PULSE_COLLECT_READY_ONLY:-false}"
profile="${PULSE_COLLECT_EXECUTION_PROFILE:-}"
reconcile="${PULSE_RECONCILE_INTERVAL_SECONDS:-}"
case "$interval" in ''|*[!0-9]*|??????*) echo "Invalid collector interval" >&2; exit 2 ;; esac
case "$jobs" in ''|*[!0-9]*|???*) echo "Invalid collector job budget" >&2; exit 2 ;; esac
if [ "$interval" -lt 60 ] || [ "$interval" -gt 86400 ] || [ "$jobs" -lt 1 ] || [ "$jobs" -gt 32 ]; then
  echo "Collector interval/jobs outside supported bounds" >&2
  exit 2
fi
case "$mode" in true|false) ;; *) echo "Invalid collector due-time setting" >&2; exit 2 ;; esac
case "$ready" in true|false) ;; *) echo "Invalid collector readiness setting" >&2; exit 2 ;; esac
case "$profile" in ''|free) ;; *) echo "Invalid collector execution profile" >&2; exit 2 ;; esac
if [ "$profile" = "free" ] && [ "$jobs" -ne 1 ]; then
  echo "The Free execution profile requires one job" >&2
  exit 2
fi
if [ -n "$reconcile" ]; then
  case "$reconcile" in *[!0-9]*|??????*) echo "Invalid reconciliation interval" >&2; exit 2 ;; esac
  if [ "$reconcile" -lt 60 ] || [ "$reconcile" -gt 86400 ]; then
    echo "Reconciliation interval outside supported bounds" >&2
    exit 2
  fi
  reconcile=$(expr "$reconcile" + 0)
fi
set -- --config /run/pulse/config.json --db /app/.pulse/pulse.db
if [ "$ready" = "true" ]; then
  set -- "$@" --ready-only
fi
if [ -n "$profile" ]; then
  set -- "$@" --execution-profile "$profile"
fi
if [ "$mode" = "true" ]; then
  regular_mode="--due-only"
else
  regular_mode="--rotate"
fi

# Kubernetes sends TERM to PID 1. Forward it to the active CLI or sleeper and
# reap it, so a stopped pod cannot leave an unobserved collector behind.
child=""
stop() {
  trap '' TERM INT
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || :
    wait "$child" 2>/dev/null || :
  fi
  exit 0
}
trap stop TERM INT
run_child() {
  "$@" &
  child=$!
  result=0
  wait "$child" || result=$?
  child=""
  return "$result"
}

next_reconcile=0
while :; do
  if run_child node /app/dist/cli.js sync "$@" --max-jobs "$jobs" "$regular_mode"; then
    : # Failed source jobs keep previously published history and return nonzero.
  else
    echo "Pulse collector cycle failed; inspect the private doctor and run history." >&2
  fi
  if [ -n "$reconcile" ] && [ "$(date +%s)" -ge "$next_reconcile" ]; then
    if run_child node /app/dist/cli.js reconcile "$@"; then
      :
    else
      echo "Pulse reconciliation cycle failed; inspect the private doctor and run history." >&2
    fi
    # A minimum gap after the last attempt, checked after regular collection.
    # Restarting may run a correction immediately; its durable cursor is retained.
    next_reconcile=$(( $(date +%s) + reconcile ))
  fi
  run_child sleep "$interval" || exit 0
done
