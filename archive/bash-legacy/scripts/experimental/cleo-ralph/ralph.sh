#!/usr/bin/env bash

#####################################################################
# ralph.sh - Ralph-Wiggum Loop Integration for CLEO
#
# Generates an optimized Ralph loop prompt for working through
# cleo epics/task trees with proper dependency handling.
#
# Usage:
#   cleo ralph <epic-id> [OPTIONS]
#   cleo ralph start <epic-id> [OPTIONS]
#   cleo ralph status
#   cleo ralph cancel
#
# Options:
#   --max-iterations N   Maximum iterations (default: 25)
#   --promise TEXT       Custom completion promise (default: "EPIC COMPLETE")
#   --dry-run            Show generated prompt without creating state file
#   -h, --help           Show this help message
#
# Integration:
#   - Automatically starts a cleo session for the epic
#   - Generates prompt optimized for cleo's command structure
#   - Uses ct (cleo) commands familiar to the LLM
#
# Version: 0.1.0
#####################################################################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
LIB_DIR="${CLEO_HOME}/lib"

# Source libraries
[[ -f "$LIB_DIR/data/file-ops.sh" ]] && source "$LIB_DIR/data/file-ops.sh"
[[ -f "$LIB_DIR/core/logging.sh" ]] && source "$LIB_DIR/core/logging.sh"
[[ -f "$LIB_DIR/core/exit-codes.sh" ]] && source "$LIB_DIR/core/exit-codes.sh"
[[ -f "$LIB_DIR/core/error-json.sh" ]] && source "$LIB_DIR/core/error-json.sh"

VERSION="0.1.0"
RALPH_STATE_FILE=".claude/ralph-loop.local.md"

# Defaults
MAX_ITERATIONS=25
COMPLETION_PROMISE="EPIC COMPLETE"
DRY_RUN=false

show_help() {
    cat << 'EOF'
cleo ralph - Ralph-Wiggum Loop Integration

USAGE:
    cleo ralph <epic-id> [OPTIONS]     Start Ralph loop for epic
    cleo ralph start <epic-id>         Alias for above
    cleo ralph status                  Show current Ralph loop status
    cleo ralph cancel                  Cancel active Ralph loop

OPTIONS:
    --max-iterations N   Maximum iterations before auto-stop (default: 25)
    --promise TEXT       Completion promise phrase (default: "EPIC COMPLETE")
    --dry-run            Preview prompt without creating state file
    -h, --help           Show this help

EXAMPLES:
    cleo ralph T001                    # Start Ralph on epic T001
    cleo ralph T001 --max-iterations 50
    cleo ralph status                  # Check if Ralph is active
    cleo ralph cancel                  # Stop active loop

HOW IT WORKS:
    1. Verifies epic exists and has child tasks
    2. Starts a cleo session scoped to the epic
    3. Generates an LLM-optimized prompt with cleo workflow
    4. Creates .claude/ralph-loop.local.md state file
    5. Ralph's stop hook then drives the iterative loop

The generated prompt instructs the LLM to:
    - Use 'ct tree' to check task status
    - Use 'ct next' to find available work (respects dependencies)
    - Use 'ct focus set <ID>' to mark tasks active
    - Complete the actual implementation work
    - Use 'ct complete <ID>' to mark tasks done
    - Output <promise>EPIC COMPLETE</promise> when all done

EOF
}

get_epic_info() {
    local epic_id="$1"
    local todo_file="${TODO_FILE:-.cleo/todo.json}"

    if [[ ! -f "$todo_file" ]]; then
        echo "ERROR: No todo.json found" >&2
        return 1
    fi

    # Get epic title and child count
    local info
    info=$(jq -r --arg id "$epic_id" '
        .tasks[] | select(.id == $id) |
        { title: .title, type: (.type // "task"), childCount: 0 }
    ' "$todo_file" 2>/dev/null)

    if [[ -z "$info" || "$info" == "null" ]]; then
        echo "ERROR: Epic $epic_id not found" >&2
        return 1
    fi

    # Count children
    local child_count
    child_count=$(jq -r --arg id "$epic_id" '
        [.tasks[] | select(.parentId == $id)] | length
    ' "$todo_file" 2>/dev/null)

    local title
    title=$(echo "$info" | jq -r '.title')

    echo "$title|$child_count"
}

get_task_tree_summary() {
    local epic_id="$1"
    local todo_file="${TODO_FILE:-.cleo/todo.json}"

    # Get child tasks with their status, dependencies, and titles
    jq -r --arg id "$epic_id" '
        .tasks[] | select(.parentId == $id) |
        "| \(.id) | \(.title[:40]) | \(.status) | \((.dependsOn // []) | join(",")) |"
    ' "$todo_file" 2>/dev/null
}

generate_ralph_prompt() {
    local epic_id="$1"
    local epic_title="$2"
    local child_count="$3"
    local task_table="$4"

    cat << PROMPT_EOF
# Cleo Epic Work Loop: $epic_id

**Epic**: $epic_title
**Tasks**: $child_count child tasks to complete

## Your Mission

Complete all tasks in epic $epic_id, working through them in dependency order.
Use cleo CLI commands (ct alias) for all task operations.

## Workflow (Each Iteration)

1. **Check Status**
   \`\`\`bash
   ct tree --parent $epic_id
   \`\`\`
   See which tasks are done (✓), active (◉), or pending (○)

2. **Find Available Work**
   \`\`\`bash
   ct next
   \`\`\`
   Returns the next task with satisfied dependencies

3. **Start Task**
   \`\`\`bash
   ct focus set <TASK_ID>
   \`\`\`
   Marks the task as active

4. **Do the Work**
   - Read task description: \`ct show <TASK_ID>\`
   - Implement what the task requires
   - Create files, write code, run tests as needed

5. **Complete Task**
   \`\`\`bash
   ct complete <TASK_ID> --notes "Brief description of what was done"
   \`\`\`

6. **Repeat** until all tasks show ✓ done

## Task Overview

| ID | Title | Status | Depends On |
|----|-------|--------|------------|
$task_table

## Completion Signal

When \`ct tree --parent $epic_id\` shows ALL child tasks with ✓ status, output:

<promise>$COMPLETION_PROMISE</promise>

## Important Rules

- **Dependencies**: Tasks blocked by incomplete dependencies won't appear in \`ct next\`
- **One at a time**: Focus on one task, complete it, then move to next
- **Real work**: Create actual working implementations, not stubs
- **Notes required**: \`ct complete\` requires --notes describing what was done
- **Verify**: Test your work before marking complete

## Useful Commands

| Command | Purpose |
|---------|---------|
| \`ct tree --parent $epic_id\` | View epic's task hierarchy |
| \`ct next\` | Get next suggested task |
| \`ct focus set ID\` | Mark task as active |
| \`ct focus show\` | See current focus |
| \`ct show ID\` | View task details and description |
| \`ct complete ID --notes "..."\` | Mark task done with notes |
| \`ct deps ID\` | Check task dependencies |
PROMPT_EOF
}

create_ralph_state() {
    local epic_id="$1"
    local prompt="$2"

    mkdir -p .claude

    cat > "$RALPH_STATE_FILE" << STATE_EOF
---
active: true
iteration: 1
max_iterations: $MAX_ITERATIONS
completion_promise: "$COMPLETION_PROMISE"
started_at: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
epic_id: "$epic_id"
cleo_integration: true
---

$prompt
STATE_EOF
}

cmd_start() {
    local epic_id="$1"

    # Validate epic exists
    local epic_info
    if ! epic_info=$(get_epic_info "$epic_id"); then
        exit 1
    fi

    local epic_title child_count
    epic_title=$(echo "$epic_info" | cut -d'|' -f1)
    child_count=$(echo "$epic_info" | cut -d'|' -f2)

    if [[ "$child_count" -eq 0 ]]; then
        echo "WARNING: Epic $epic_id has no child tasks" >&2
    fi

    # Get task table
    local task_table
    task_table=$(get_task_tree_summary "$epic_id")

    # Generate prompt
    local prompt
    prompt=$(generate_ralph_prompt "$epic_id" "$epic_title" "$child_count" "$task_table")

    if [[ "$DRY_RUN" == "true" ]]; then
        echo "=== DRY RUN - Generated Prompt ==="
        echo ""
        echo "$prompt"
        echo ""
        echo "=== State File Would Be: $RALPH_STATE_FILE ==="
        return 0
    fi

    # Check for existing Ralph loop
    if [[ -f "$RALPH_STATE_FILE" ]]; then
        local existing_epic
        existing_epic=$(grep '^epic_id:' "$RALPH_STATE_FILE" | sed 's/epic_id: *//' | tr -d '"' || echo "unknown")
        echo "WARNING: Ralph loop already active for epic $existing_epic"
        echo "Use 'cleo ralph cancel' first, or continue with existing loop"
        read -p "Override existing loop? [y/N] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 0
        fi
    fi

    # Start cleo session if not already in one
    if ! ct session status &>/dev/null; then
        echo "[INFO] Starting cleo session for epic $epic_id..."
        ct session start --scope "epic:$epic_id" --name "Ralph: $epic_title" --auto-focus 2>/dev/null || true
    fi

    # Create state file
    create_ralph_state "$epic_id" "$prompt"

    echo "✅ Ralph loop configured for epic $epic_id"
    echo ""
    echo "📋 Epic: $epic_title"
    echo "📝 Tasks: $child_count"
    echo "🔄 Max iterations: $MAX_ITERATIONS"
    echo "🎯 Completion promise: $COMPLETION_PROMISE"
    echo ""
    echo "The Ralph stop hook is now active. When Claude tries to exit,"
    echo "the prompt will be re-fed automatically."
    echo ""
    echo "To cancel: cleo ralph cancel"
}

cmd_status() {
    if [[ ! -f "$RALPH_STATE_FILE" ]]; then
        echo "No active Ralph loop"
        exit 0
    fi

    local iteration max_iter epic_id promise
    iteration=$(grep '^iteration:' "$RALPH_STATE_FILE" | sed 's/iteration: *//')
    max_iter=$(grep '^max_iterations:' "$RALPH_STATE_FILE" | sed 's/max_iterations: *//')
    epic_id=$(grep '^epic_id:' "$RALPH_STATE_FILE" | sed 's/epic_id: *//' | tr -d '"')
    promise=$(grep '^completion_promise:' "$RALPH_STATE_FILE" | sed 's/completion_promise: *//' | tr -d '"')

    echo "Ralph Loop Status"
    echo "═════════════════"
    echo "Epic: $epic_id"
    echo "Iteration: $iteration / $max_iter"
    echo "Promise: $promise"
    echo ""
    echo "State file: $RALPH_STATE_FILE"
}

cmd_cancel() {
    if [[ ! -f "$RALPH_STATE_FILE" ]]; then
        echo "No active Ralph loop to cancel"
        exit 0
    fi

    local iteration epic_id
    iteration=$(grep '^iteration:' "$RALPH_STATE_FILE" | sed 's/iteration: *//')
    epic_id=$(grep '^epic_id:' "$RALPH_STATE_FILE" | sed 's/epic_id: *//' | tr -d '"')

    rm -f "$RALPH_STATE_FILE"

    echo "🛑 Ralph loop cancelled"
    echo "   Epic: $epic_id"
    echo "   Iterations completed: $iteration"
}

# Parse arguments
EPIC_ID=""
SUBCOMMAND=""

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        --max-iterations)
            MAX_ITERATIONS="$2"
            shift 2
            ;;
        --promise)
            COMPLETION_PROMISE="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        start|status|cancel)
            SUBCOMMAND="$1"
            shift
            ;;
        T[0-9]*)
            EPIC_ID="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# Route to subcommand
case "${SUBCOMMAND:-start}" in
    start)
        if [[ -z "$EPIC_ID" ]]; then
            echo "ERROR: Epic ID required" >&2
            echo "Usage: cleo ralph <epic-id>" >&2
            exit 1
        fi
        cmd_start "$EPIC_ID"
        ;;
    status)
        cmd_status
        ;;
    cancel)
        cmd_cancel
        ;;
    *)
        echo "Unknown subcommand: $SUBCOMMAND" >&2
        exit 1
        ;;
esac
