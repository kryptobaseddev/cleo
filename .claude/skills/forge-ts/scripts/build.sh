#!/usr/bin/env bash
# Generate all documentation artifacts (OpenAPI, MDX, llms.txt, SKILL.md)
# Non-TTY defaults to JSON (LAFS envelope) — no --json flag needed
set -euo pipefail
npx forge-ts build "$@"
