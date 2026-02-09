#!/usr/bin/env bash
###CLEO
# command: checkpoint
# category: maintenance
# synopsis: Git checkpoint for CLEO state files (manual trigger or status)
# relevance: low
# flags: --format,--quiet,--status,--dry-run
# exits: 0,1
# json-output: true
###END
# CLEO Checkpoint Command
# Manual git checkpoint trigger and status inspection
# @task T3147
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source libraries
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/logging.sh" ]]; then
  # shellcheck source=../lib/logging.sh
  source "$LIB_DIR/logging.sh"
fi

if [[ -f "$LIB_DIR/output-format.sh" ]]; then
  # shellcheck source=../lib/output-format.sh
  source "$LIB_DIR/output-format.sh"
fi

if [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  # shellcheck source=../lib/exit-codes.sh
  source "$LIB_DIR/exit-codes.sh"
fi

if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  # shellcheck source=../lib/error-json.sh
  source "$LIB_DIR/error-json.sh"
fi

if [[ -f "$LIB_DIR/config.sh" ]]; then
  # shellcheck source=../lib/config.sh
  source "$LIB_DIR/config.sh"
fi

if [[ -f "$LIB_DIR/flags.sh" ]]; then
  # shellcheck source=../lib/flags.sh
  source "$LIB_DIR/flags.sh"
fi

if [[ -f "$LIB_DIR/git-checkpoint.sh" ]]; then
  # shellcheck source=../lib/git-checkpoint.sh
  source "$LIB_DIR/git-checkpoint.sh"
fi

# Options
STATUS_MODE=false
DRY_RUN=false
COMMAND_NAME="checkpoint"

# Initialize flag defaults
if declare -f init_flag_defaults >/dev/null 2>&1; then
  init_flag_defaults
fi

usage() {
  cat <<EOF
Usage: cleo checkpoint [OPTIONS]

Git checkpoint for CLEO state files.

Commands:
  (default)     Force immediate checkpoint (bypass debounce)
  --status      Show configuration and last checkpoint time
  --dry-run     Show what files would be committed

Options:
  --format FORMAT    Output format (json|text)
  --quiet            Suppress non-essential output

Configuration:
  cleo config set gitCheckpoint.enabled false        # Disable (enabled by default)
  cleo config set gitCheckpoint.debounceMinutes 2    # Adjust debounce (default: 5)
  cleo config set gitCheckpoint.messagePrefix "chore(cleo):"  # Commit prefix
  cleo config set gitCheckpoint.noVerify true         # Skip pre-commit hooks (default)

Examples:
  cleo checkpoint                    # Force immediate checkpoint
  cleo checkpoint --status           # Show config and status
  cleo checkpoint --dry-run          # Preview what would be committed
EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --status)
      STATUS_MODE=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --format)
      FORMAT="${2:-json}"
      shift 2
      ;;
    --quiet|-q)
      QUIET=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit "${EXIT_INVALID_INPUT:-2}"
      ;;
  esac
done

# Detect output format
output_format="${FORMAT:-}"
if [[ -z "$output_format" ]]; then
  if declare -f detect_output_format >/dev/null 2>&1; then
    output_format=$(detect_output_format)
  else
    output_format="text"
  fi
fi

# Check that git-checkpoint library loaded
if ! declare -f git_checkpoint >/dev/null 2>&1; then
  if [[ "$output_format" == "json" ]]; then
    if declare -f output_error_json >/dev/null 2>&1; then
      output_error_json "E_LIBRARY_MISSING" "git-checkpoint.sh library not loaded" "${EXIT_INTERNAL_ERROR:-1}"
    else
      echo '{"success":false,"error":{"code":"E_LIBRARY_MISSING","message":"git-checkpoint.sh library not loaded"}}' >&2
    fi
  else
    echo "Error: git-checkpoint.sh library not loaded" >&2
  fi
  exit "${EXIT_INTERNAL_ERROR:-1}"
fi

# Status mode
if [[ "$STATUS_MODE" == "true" ]]; then
  git_checkpoint_status "$output_format"
  exit 0
fi

# Dry-run mode
if [[ "$DRY_RUN" == "true" ]]; then
  git_checkpoint_dry_run
  exit 0
fi

# Force checkpoint (manual trigger, bypasses debounce)
_load_checkpoint_config

if [[ "$_GC_ENABLED" != "true" ]]; then
  if [[ "$output_format" == "json" ]]; then
    jq -n '{success: false, message: "Git checkpoint is disabled. Enable with: cleo config set gitCheckpoint.enabled true"}'
  else
    echo "Git checkpoint is disabled."
    echo "Enable with: cleo config set gitCheckpoint.enabled true"
  fi
  exit 0
fi

# Perform forced checkpoint
git_checkpoint "manual" "" 2>/dev/null

if [[ "$output_format" == "json" ]]; then
  jq -n '{success: true, message: "Checkpoint complete"}'
else
  if [[ "${QUIET:-false}" != "true" ]]; then
    echo "Checkpoint complete."
  fi
fi

exit 0
