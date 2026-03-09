#!/usr/bin/env bash
# UserPromptSubmit: inject recent CLEO brain observations as context
# Claude Code reads stdout from this hook and includes it in the session context.
# Must be fast (<3s) and always exit 0.

CLEO_BIN="${HOME}/.cleo/bin/cleo"

# Bail fast if cleo not available or no .cleo dir
[[ ! -x "$CLEO_BIN" ]] && exit 0
[[ ! -d ".cleo" ]] && exit 0

# Query recent brain observations — compact format
CONTEXT=$("$CLEO_BIN" memory find "session task decision pattern learning" --limit 15 --json 2>/dev/null | \
  python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    hits = d.get('result', {}).get('results', [])
    if not hits:
        sys.exit(0)
    lines = ['## CLEO Brain Context (recent memories)\n']
    for h in hits:
        t = h.get('type', 'observation')
        icon = {'observation': 'O', 'decision': 'D', 'pattern': 'P', 'learning': 'L'}.get(t, 'O')
        title = h.get('title', '')[:90]
        date = h.get('date', '')[:10]
        lines.append(f'- [{icon}] {date} {title}')
    print('\n'.join(lines))
    print()
except Exception:
    pass
" 2>/dev/null || true)

[[ -n "$CONTEXT" ]] && echo "$CONTEXT"
exit 0
