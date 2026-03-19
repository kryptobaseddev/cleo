#!/usr/bin/env bash
# Validate TSDoc coverage with agent-friendly JSON output
# Usage: ./check.sh [--mvi minimal|standard|full] [additional args]
set -euo pipefail
npx forge-ts check --json --mvi "${MVI_LEVEL:-full}" "$@"
