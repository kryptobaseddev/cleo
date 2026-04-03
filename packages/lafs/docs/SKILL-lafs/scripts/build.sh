#!/usr/bin/env bash
# Run lafs-conformance build pipeline
set -euo pipefail
npx lafs-conformance build "$@"
