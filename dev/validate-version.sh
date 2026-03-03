#!/usr/bin/env bash

set -euo pipefail

# Compatibility wrapper for TypeScript version sync.
exec npx tsx dev/version-sync.ts "$@"
