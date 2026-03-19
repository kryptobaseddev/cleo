#!/usr/bin/env bash
# Generate all documentation artifacts (OpenAPI, MDX, llms.txt, SKILL.md)
set -euo pipefail
npx forge-ts build --json "$@"
