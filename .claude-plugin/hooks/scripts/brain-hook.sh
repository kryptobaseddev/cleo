#!/usr/bin/env bash
# Fire-and-forget: send hook event to brain worker
# Always exits 0 — never blocks Claude Code
EVENT="$1"
WORKER_PORT=37778

# Read stdin
INPUT=$(cat 2>/dev/null || echo '{}')

# Non-blocking curl to worker
curl -sf --max-time 5 \
  -X POST "http://127.0.0.1:${WORKER_PORT}/hook" \
  -H "Content-Type: application/json" \
  -d "{\"event\":\"${EVENT}\",\"data\":$(echo "$INPUT" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)))' 2>/dev/null || echo '\"{}\"')}" \
  >/dev/null 2>&1 || true

exit 0
