#!/usr/bin/env bash
#
# check-core-purity.sh — Verify src/core/ never imports from src/cli/, src/mcp/, or src/dispatch/.
#
# Exit 0 if clean, exit 1 with details if violations found.
# Test files (__tests__/) are excluded since integration tests legitimately
# cross layer boundaries.
#
# @task T5715
# @epic T5701

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CORE_DIR="$PROJECT_ROOT/src/core"

if [[ ! -d "$CORE_DIR" ]]; then
  echo "ERROR: src/core/ directory not found at $CORE_DIR"
  exit 1
fi

FORBIDDEN_PATTERNS=(
  "from ['\"](\\.\\./)*\\.\\./(cli)/"
  "from ['\"](\\.\\./)*\\.\\./(mcp)/"
  "from ['\"](\\.\\./)*\\.\\./(dispatch)/"
)

VIOLATIONS=0
VIOLATION_FILES=()

for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
  # Search production source files only (exclude __tests__ and test files)
  while IFS= read -r match; do
    if [[ -n "$match" ]]; then
      VIOLATIONS=$((VIOLATIONS + 1))
      VIOLATION_FILES+=("$match")
    fi
  done < <(grep -rn --include="*.ts" -E "$pattern" "$CORE_DIR" \
    | grep -v '__tests__/' \
    | grep -v '\.test\.ts:' \
    | grep -v '\.integration\.test\.ts:' \
    || true)
done

if [[ $VIOLATIONS -eq 0 ]]; then
  echo "core-purity: PASS — src/core/ has no upward imports to cli/mcp/dispatch"
  exit 0
fi

echo "core-purity: FAIL — found $VIOLATIONS upward import(s) in src/core/"
echo ""
echo "src/core/ must not import from src/cli/, src/mcp/, or src/dispatch/."
echo "Move shared types/functions to src/core/ or packages/contracts/."
echo ""
echo "Violations:"
for v in "${VIOLATION_FILES[@]}"; do
  echo "  $v"
done

exit 1
