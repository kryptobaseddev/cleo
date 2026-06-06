#!/usr/bin/env bash
# safe-test.sh — memory-safe, single-runner vitest wrapper (T11860).
#
# WHY: `--max-old-space-size` (vitest.config.ts) caps only the V8 heap, not a
# fork's native sqlite/vec0 memory (~2.2 GB extra/fork). And `systemd-run
# --user --scope -p MemoryMax` is a NO-OP on a user manager with Delegate=no
# (verified 2026-06-06: memory.max never set on the leaf scope). And when TWO
# agents run the suite at once, 2 × ~26 GB freezes a 62 GB box.
#
# This wrapper provides what the cgroup cap cannot:
#   1. flock(1) on a machine-wide lock  → only ONE vitest runs at a time.
#   2. A poll-based memory watchdog      → kills the run if MemAvailable drops
#      below the threshold, so a runaway/leaky test can never freeze the host.
#
# Usage:
#   scripts/safe-test.sh [--threshold-gb N] [--lock-wait SECONDS] -- <vitest cli...>
# Examples:
#   scripts/safe-test.sh -- pnpm --filter @cleocode/core exec vitest run src/store
#   scripts/safe-test.sh --threshold-gb 10 -- pnpm exec vitest run
set -u

THRESHOLD_GB=8
LOCK_WAIT=1800
LOCK_FILE="${CLEO_TEST_LOCK:-/tmp/cleo-vitest.lock}"

while [ $# -gt 0 ]; do
  case "$1" in
    --threshold-gb) THRESHOLD_GB="$2"; shift 2 ;;
    --lock-wait) LOCK_WAIT="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "safe-test.sh: unknown arg '$1'" >&2; exit 2 ;;
  esac
done
[ $# -gt 0 ] || { echo "safe-test.sh: no command after --" >&2; exit 2; }

THRESHOLD_KB=$(( THRESHOLD_GB * 1024 * 1024 ))

# ── 1. Machine-wide single-runner mutex ────────────────────────────────────
exec 9>"$LOCK_FILE" || { echo "safe-test.sh: cannot open lock $LOCK_FILE" >&2; exit 1; }
if ! flock -w "$LOCK_WAIT" 9; then
  echo "[safe-test] another vitest run holds $LOCK_FILE after ${LOCK_WAIT}s — aborting to avoid an OOM collision" >&2
  exit 1
fi
echo "[safe-test] acquired $LOCK_FILE ; mem threshold=${THRESHOLD_GB}GB available ; cmd: $*"

# ── 2. Run + memory watchdog ────────────────────────────────────────────────
"$@" &
RUN_PID=$!

PEAK_USED_KB=0
while kill -0 "$RUN_PID" 2>/dev/null; do
  AVAIL_KB=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
  TOTAL_KB=$(awk '/MemTotal/{print $2}' /proc/meminfo)
  USED_KB=$(( TOTAL_KB - AVAIL_KB ))
  [ "$USED_KB" -gt "$PEAK_USED_KB" ] && PEAK_USED_KB=$USED_KB
  if [ "$AVAIL_KB" -lt "$THRESHOLD_KB" ]; then
    echo "[safe-test] !!! MemAvailable $((AVAIL_KB/1024/1024))GB < ${THRESHOLD_GB}GB — KILLING vitest tree to protect the host"
    pkill -9 -P "$RUN_PID" 2>/dev/null
    kill -9 "$RUN_PID" 2>/dev/null
    pkill -9 -f vitest 2>/dev/null
    echo "[safe-test] peak used: $((PEAK_USED_KB/1024/1024))GB"
    exit 137
  fi
  sleep 2
done
wait "$RUN_PID"
RC=$?
echo "[safe-test] done rc=$RC ; peak used: $((PEAK_USED_KB/1024/1024))GB"
exit $RC
