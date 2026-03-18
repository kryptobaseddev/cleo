#!/usr/bin/env bash
exec node --disable-warning=ExperimentalWarning "$(dirname "$0")/../packages/cleoctl/dist/cli/index.js" "$@"
