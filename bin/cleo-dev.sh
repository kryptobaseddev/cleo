#!/usr/bin/env bash
exec node --disable-warning=ExperimentalWarning "$(dirname "$0")/../packages/cleo/dist/cli/index.js" "$@"
