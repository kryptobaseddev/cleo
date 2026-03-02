#!/usr/bin/env bash

set -euo pipefail

# Legacy wrapper retained for compatibility.
# Canonical generator is TypeScript: dev/generate-features.ts

npx tsx dev/generate-features.ts
