#!/usr/bin/env bash
# Stop: save session summary to CLEO brain
# Best-effort — always exits 0 so it never blocks Claude Code
set -euo pipefail

CLEO_BIN="${HOME}/.cleo/bin/cleo"
[ ! -x "$CLEO_BIN" ] && exit 0
[ ! -d ".cleo" ] && exit 0

# Get current session info if available
SESSION_INFO=$("$CLEO_BIN" session status --json 2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin)
r = d.get('result', {})
s = r.get('session', {})
if s:
    print(f'Session ended: {s.get(\"scope\",\"unknown\")} scope, task: {s.get(\"currentTask\",\"none\")}')
else:
    print('Session ended')
" 2>/dev/null || echo "Claude Code session ended")

"$CLEO_BIN" memory observe "$SESSION_INFO" --title "[hook] session-end" >/dev/null 2>&1 || true
exit 0
