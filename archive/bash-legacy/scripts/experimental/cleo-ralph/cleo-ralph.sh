#!/bin/bash
# cleo-ralph.sh - Start Ralph loop for a cleo epic
# Usage: .claude/scripts/cleo-ralph.sh <EPIC_ID> [MAX_ITERATIONS]
#
# This bypasses shell quoting issues by writing the state file directly.

set -euo pipefail

EPIC_ID="${1:-}"
MAX_ITERATIONS="${2:-20}"
COMPLETION_PROMISE="EPIC COMPLETE"

if [[ -z "$EPIC_ID" ]]; then
    echo "Usage: $0 <EPIC_ID> [MAX_ITERATIONS]"
    echo ""
    echo "Examples:"
    echo "  $0 T001           # Work on epic T001, max 20 iterations"
    echo "  $0 T001 30        # Work on epic T001, max 30 iterations"
    exit 1
fi

# Verify epic exists
if ! ct exists "$EPIC_ID" --quiet 2>/dev/null; then
    echo "❌ Error: Epic $EPIC_ID not found"
    echo "   Use 'ct tree' to see available epics"
    exit 1
fi

# Get epic title for context (parse from human-readable output)
EPIC_TITLE=$(ct show "$EPIC_ID" 2>/dev/null | grep -A1 "$EPIC_ID" | tail -1 | sed 's/^│  //' | xargs)
EPIC_TITLE="${EPIC_TITLE:-Epic $EPIC_ID}"

mkdir -p .claude

cat > .claude/ralph-loop.local.md << RALPH_EOF
---
active: true
iteration: 1
max_iterations: $MAX_ITERATIONS
completion_promise: "$COMPLETION_PROMISE"
started_at: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
---

# Work on Cleo Epic: $EPIC_ID

**Epic**: $EPIC_TITLE

Complete all tasks in this epic, working through them in dependency order.

## Workflow Each Iteration

1. **Check Status**: Run \`ct tree --parent $EPIC_ID\` to see current task status
2. **Find Work**: Run \`ct next\` to find the next available task (respects dependencies)
3. **Start Task**: Run \`ct focus set <ID>\` to mark the task as active
4. **Do the Work**: Implement what the task requires (create files, write code, etc.)
5. **Complete Task**: Run \`ct complete <ID>\` when finished
6. **Repeat**: Continue until all tasks show ✓ (done)

## Completion Signal

When \`ct tree --parent $EPIC_ID\` shows ALL child tasks with ✓ status, output:

<promise>$COMPLETION_PROMISE</promise>

## Helpful Commands

| Command | Purpose |
|---------|---------|
| \`ct tree --parent $EPIC_ID\` | View epic's task hierarchy |
| \`ct next\` | Get next suggested task |
| \`ct focus set ID\` | Mark task as active |
| \`ct complete ID\` | Mark task as done |
| \`ct show ID\` | View task details |
| \`ct deps ID\` | Check dependencies |

## Important Notes

- Tasks with unmet dependencies will be skipped by \`ct next\`
- Focus on one task at a time
- Create real, working implementations
- Test your work before marking complete
RALPH_EOF

echo "✅ Ralph loop configured for epic $EPIC_ID"
echo ""
echo "📋 Epic: $EPIC_TITLE"
echo "🔄 Max iterations: $MAX_ITERATIONS"
echo "🎯 Completion promise: $COMPLETION_PROMISE"
echo ""
echo "The stop hook is now active. When Claude tries to exit,"
echo "the prompt will be re-fed automatically."
echo ""
echo "To cancel: /cancel-ralph or delete .claude/ralph-loop.local.md"
