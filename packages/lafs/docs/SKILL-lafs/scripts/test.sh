#!/usr/bin/env bash
# Run lafs-conformance test suite
set -euo pipefail
npx lafs-conformance test "$@"
