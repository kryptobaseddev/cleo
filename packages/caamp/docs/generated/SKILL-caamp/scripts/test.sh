#!/usr/bin/env bash
# Run caamp test suite
set -euo pipefail
npx caamp test "$@"
