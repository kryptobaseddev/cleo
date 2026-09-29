# shellcheck shell=bash
#
# Wave runner for the npm publish step of .github/workflows/release.yml.
# SOURCED by that step (and by scripts/__tests__/release-publish-waves.test.mjs,
# which drives it with fake publishers) — never executed on its own.
#
# The caller defines, before calling `run_wave`:
#   _publish_one <dir> [npmName]  publishes one package. It returns 0 for every
#                                 handled outcome — PUBLISHED and the idempotent
#                                 SKIP-EXISTS / SKIP-RACE / SKIP-CONFLICT — and
#                                 appends the npm name to $FAILED_LOG for a
#                                 classified failure (FAIL / FAIL-OIDC).
#   FAILED_LOG                    file of failed package names (one per line).
#   PUBLISH_LOG                   timeline TSV (pkg, outcome, call_ts, done_ts).
#   WAVE_LOG_DIR                  directory for per-package wave logs.
#
# Guarantees:
#   - A publish subshell that exits NONZERO (a crash: `set -e` abort, a kill, an
#     unexpected error the classifier never saw) is a FAILURE for that package,
#     recorded in $FAILED_LOG and the timeline as CRASH. It is never swallowed.
#   - After a wave with ANY failure, every later wave is NOT attempted: its
#     packages are logged as NOT-ATTEMPTED and nothing is published. A later
#     wave depends on the earlier ones, so publishing it would put a version on
#     npm whose @cleocode/* dependencies are missing.
#   - A re-run of the same release stays idempotent: the SKIP-* outcomes return
#     0 and are not failures, so a wave of already-published packages passes.

WAVE=()
PUBLISH_HALTED=0

# `publish_pkg <dir> [npmName]` ENQUEUES into the current wave. The calls in
# release.yml are the npm publish-surface SSoT (arch gate 9, execute-payload).
publish_pkg() {
  WAVE+=("$*")
}

# npm name (without @cleocode/) of a queued "<dir> [npmName]" entry.
_wave_entry_name() {
  local dir name
  read -r dir name <<< "$1"
  echo "${name:-${dir##*/}}"
}

# `run_wave <label>` publishes the queued packages concurrently, waits for all
# of them, prints each one's log in queue order, then halts later waves if any
# package in this wave (or an earlier one) failed.
run_wave() {
  local label="$1"
  local entry
  if [[ "$PUBLISH_HALTED" == "1" ]]; then
    echo "=== wave ${label}: NOT ATTEMPTED (an earlier wave failed): ${WAVE[*]} ==="
    for entry in "${WAVE[@]}"; do
      printf '%s\tNOT-ATTEMPTED\t\t\n' "$(_wave_entry_name "$entry")" >> "$PUBLISH_LOG"
    done
    WAVE=()
    return 0
  fi
  local -a pids=()
  local -a entries=()
  local i=0
  echo "=== wave ${label}: ${WAVE[*]} ==="
  for entry in "${WAVE[@]}"; do
    # shellcheck disable=SC2086 # "<dir> [npmName]" splits into args
    ( _publish_one $entry ) > "${WAVE_LOG_DIR}/publish-wave-${label}-${i}.log" 2>&1 &
    pids+=("$!")
    entries+=("$entry")
    i=$((i + 1))
  done
  local j rc name
  for ((j = 0; j < i; j++)); do
    rc=0
    wait "${pids[$j]}" || rc=$?
    if [[ $rc -ne 0 ]]; then
      name="$(_wave_entry_name "${entries[$j]}")"
      echo "$name" >> "$FAILED_LOG"
      printf '%s\tCRASH(exit %s)\t\t\n' "$name" "$rc" >> "$PUBLISH_LOG"
      echo "✗ CRASH: @cleocode/$name publish exited $rc without a classified outcome" \
        >> "${WAVE_LOG_DIR}/publish-wave-${label}-${j}.log"
    fi
  done
  for ((j = 0; j < i; j++)); do
    cat "${WAVE_LOG_DIR}/publish-wave-${label}-${j}.log"
  done
  WAVE=()
  if [[ -s "$FAILED_LOG" ]]; then
    PUBLISH_HALTED=1
    echo "::error::wave ${label} had publish failures ($(sort -u "$FAILED_LOG" | tr '\n' ' ')); later waves will NOT be published."
  fi
  return 0
}
