#!/usr/bin/env bash
# SessionStart hook — starts the brain worker if not running
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/brain-worker.cjs" start 2>/dev/null &
disown 2>/dev/null || true
exit 0
