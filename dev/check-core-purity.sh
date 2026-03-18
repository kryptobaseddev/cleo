#!/usr/bin/env bash
#
# check-core-purity.sh — Verify src/core/ never imports from src/cli/, src/mcp/, or src/dispatch/.
#
# Exit 0 if clean (or only known exceptions), exit 1 with details if new violations found.
# Test files (__tests__/) are excluded since integration tests legitimately
# cross layer boundaries.
#
# @task T5715
# @epic T5701

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CORE_DIR="$PROJECT_ROOT/src/core"
PKG_CORE_DIR="$PROJECT_ROOT/packages/core/src"

if [[ ! -d "$CORE_DIR" ]]; then
  echo "ERROR: src/core/ directory not found at $CORE_DIR"
  exit 1
fi

# Known exceptions: files that legitimately need dispatch types.
# Each entry is a grep-style pattern matching file:line prefix.
# These should be fixed incrementally by moving types to core/contracts.
KNOWN_EXCEPTIONS=(
  "src/core/validation/param-utils.ts"
)

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
      # Check if this match is a known exception
      is_exception=false
      for exception in "${KNOWN_EXCEPTIONS[@]}"; do
        if [[ "$match" == *"$exception"* ]]; then
          is_exception=true
          break
        fi
      done

      if [[ "$is_exception" == "false" ]]; then
        VIOLATIONS=$((VIOLATIONS + 1))
        VIOLATION_FILES+=("$match")
      fi
    fi
  done < <(grep -rn --include="*.ts" -E "$pattern" "$CORE_DIR" \
    | grep -v '__tests__/' \
    | grep -v '\.test\.ts:' \
    | grep -v '\.integration\.test\.ts:' \
    || true)
done

# Also check packages/core/src/ for upward imports (T5716)
if [[ -d "$PKG_CORE_DIR" ]]; then
  PKG_FORBIDDEN_PATTERNS=(
    "from ['\"].*src/(cli)/"
    "from ['\"].*src/(mcp)/"
    "from ['\"].*src/(dispatch)/"
  )

  for pattern in "${PKG_FORBIDDEN_PATTERNS[@]}"; do
    while IFS= read -r match; do
      if [[ -n "$match" ]]; then
        is_exception=false
        for exception in "${KNOWN_EXCEPTIONS[@]}"; do
          if [[ "$match" == *"$exception"* ]]; then
            is_exception=true
            break
          fi
        done

        if [[ "$is_exception" == "false" ]]; then
          VIOLATIONS=$((VIOLATIONS + 1))
          VIOLATION_FILES+=("$match")
        fi
      fi
    done < <(grep -rn --include="*.ts" -E "$pattern" "$PKG_CORE_DIR" \
      | grep -v '__tests__/' \
      | grep -v '\.test\.ts:' \
      | grep -v '\.integration\.test\.ts:' \
      || true)
  done
fi

if [[ $VIOLATIONS -eq 0 ]]; then
  echo "core-purity: PASS — src/core/ and packages/core/src/ have no upward imports to cli/mcp/dispatch"
  if [[ ${#KNOWN_EXCEPTIONS[@]} -gt 0 ]]; then
    echo "  (${#KNOWN_EXCEPTIONS[@]} known exception(s) suppressed — fix incrementally)"
  fi
  exit 0
fi

echo "core-purity: FAIL — found $VIOLATIONS NEW upward import(s) in src/core/ or packages/core/src/"
echo ""
echo "Core must not import from src/cli/, src/mcp/, or src/dispatch/."
echo "Move shared types/functions to src/core/ or packages/contracts/."
echo ""
echo "Violations:"
for v in "${VIOLATION_FILES[@]}"; do
  echo "  $v"
done

exit 1
