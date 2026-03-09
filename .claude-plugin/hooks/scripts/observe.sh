#!/usr/bin/env bash
# PostToolUse: capture tool observations into CLEO brain.db
# Best-effort — always exits 0 so it never blocks Claude Code
set -euo pipefail

CLEO_BIN="${HOME}/.cleo/bin/cleo"
[ ! -x "$CLEO_BIN" ] && exit 0
[ ! -d ".cleo" ] && exit 0

# Read stdin (tool use JSON from Claude Code)
INPUT=$(cat) || exit 0
TOOL=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_name','unknown'))" 2>/dev/null || echo "unknown")

# Only observe meaningful tools (skip trivial ones)
case "$TOOL" in
  Read|Write|Edit|Bash|Glob|Grep|Agent) ;;
  *) exit 0 ;;
esac

# Extract a short summary
SUMMARY=$(echo "$INPUT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
tool = d.get('tool_name', 'unknown')
inp = d.get('tool_input', {})
if tool == 'Bash':
    print(f'Bash: {str(inp.get(\"command\",\"\"))[:80]}')
elif tool in ('Read','Write','Edit'):
    print(f'{tool}: {inp.get(\"file_path\",inp.get(\"path\",\"\"))[:80]}')
elif tool == 'Grep':
    print(f'Grep: {inp.get(\"pattern\",\"\")[:40]} in {inp.get(\"path\",\".\")[:40]}')
elif tool == 'Glob':
    print(f'Glob: {inp.get(\"pattern\",\"\")[:60]}')
elif tool == 'Agent':
    print(f'Agent: {str(inp.get(\"prompt\",\"\"))[:80]}')
else:
    print(f'{tool} called')
" 2>/dev/null || echo "$TOOL called")

"$CLEO_BIN" memory observe "$SUMMARY" --title "[hook] $TOOL" >/dev/null 2>&1 || true
exit 0
