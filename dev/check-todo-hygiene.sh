#!/usr/bin/env bash
set -euo pipefail

PATTERN='(^|[[:space:]])(//|#|/\*|\*)[[:space:]]*TODO\b'

if git grep -nE "$PATTERN" -- . \
  ':(exclude)docs/**' \
  ':(exclude).cleo/agent-outputs/**' \
  ':(exclude)CHANGELOG.md' \
  ':(exclude)dev/archived/**'; then
  printf '\nTODO hygiene check failed: in-scope TODO comment(s) found.\n'
  exit 1
fi

printf 'TODO hygiene check passed: zero in-scope TODO comments.\n'
