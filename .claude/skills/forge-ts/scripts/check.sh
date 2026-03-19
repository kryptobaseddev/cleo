#!/usr/bin/env bash
# Validate TSDoc coverage — non-TTY defaults to JSON (LAFS envelope)
# Usage: ./check.sh [--mvi minimal|standard|full] [additional args]
set -euo pipefail
npx forge-ts check --mvi "${MVI_LEVEL:-full}" "$@"
