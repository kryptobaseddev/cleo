#!/usr/bin/env bash
# Run caamp build pipeline
set -euo pipefail
npx caamp build "$@"
