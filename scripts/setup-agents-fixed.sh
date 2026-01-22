#!/usr/bin/env bash
# scripts/setup-agents.sh - Global agent configuration setup
# Creates/updates ~/.claude/CLAUDE.md and ~/.claude/AGENTS.md with @ references

set -euo pipefail

# Script directory resolution
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Determine library directory (local dev vs global install)
if [[ -f "$SCRIPT_DIR/../lib/exit-codes.sh" ]]; then
    # Local development (running from scripts/ directory)
    LIB_DIR="$SCRIPT_DIR/../lib"
elif [[ -f "$CLEO_HOME/lib/exit-codes.sh" ]]; then
    # Global installation
    LIB_DIR="$CLEO_HOME/lib"
else
    echo "Error: Cannot find CLEO libraries" >&2
    exit 1
fi

# Source dependencies
source "$LIB_DIR/exit-codes.sh"
source "$LIB_DIR/injection.sh"
source "$LIB_DIR/agent-config.sh"

# Source centralized flag parsing
source "$LIB_DIR/flags.sh"

# ==============================================================================
# CONFIGURATION
# ==============================================================================

AGENT_CONFIGS_REGISTRY="$CLEO_HOME/agent-configs.json"

# Parse command-line flags
DRY_RUN=false
FORCE=false
UPDATE=false
MIGRATE_LEGACY=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --update)
            UPDATE=true
            shift
            ;;
        --migrate-from-legacy)
            MIGRATE_LEGACY=true
            shift
            ;;
        --help|-h)
            cat <<EOF
Usage: cleo setup-agents [OPTIONS]

Setup/update global agent configuration files with CLEO task management instructions.
Auto-discovers installed agent CLIs and configures their documentation files.

Options:
  --dry-run              Show what would be configured without making changes
  --force                Force update even if versions match
  --update               Update all existing configs to current version
  --migrate-from-legacy  Convert old append-style configs to marker-based

Exit codes:
  0    Success
  102  No changes needed (all current)
  1    Error occurred

Examples:
  cleo setup-agents              # Setup all installed agents
  cleo setup-agents --dry-run    # Preview changes
  cleo setup-agents --update     # Force update all configs
EOF
            exit 0
            ;;
        *)
            echo "Error: Unknown flag: $1" >&2
            echo "Use --help for usage information" >&2
            exit "$EXIT_INVALID_INPUT"
            ;;
    esac
done

# ==============================================================================
# VALIDATION
# ==============================================================================

# Verify CLEO global installation
if [[ ! -d "$CLEO_HOME/docs" ]]; then
    echo "Error: Global CLEO installation not found at $CLEO_HOME/docs/" >&2
    echo "Run 'install.sh' to install CLEO globally first" >&2
    exit "$EXIT_MISSING_DEPENDENCY"
fi

# No template needed - we generate @ reference inline

# ==============================================================================
# AGENT DISCOVERY AND CONFIGURATION
# ==============================================================================

# Initialize counters
configured_count=0
skipped_count=0
updated_count=0
no_change_count=0

# Agent types to check
agent_types=("claude" "gemini" "codex" "kimi")

if [[ "$DRY_RUN" == true ]]; then
    echo "[DRY-RUN] Would setup/update:"
    echo ""
    for agent_name in "${agent_types[@]}"; do
        if is_agent_cli_installed "$agent_name"; then
            config_path=$(get_agent_config_path "$agent_name")
            if injection_has_block "$config_path" 2>/dev/null; then
                echo "  ✓ $config_path (already configured)"
            else
                echo "  📝 $config_path (new setup)"
            fi
        else
            echo "  ⏭️  Skip: $agent_name (CLI not installed)"
        fi
    done
    exit 0
fi

# Process each agent type
for agent_name in "${agent_types[@]}"; do
    # Skip if agent CLI not installed
    if ! is_agent_cli_installed "$agent_name"; then
        echo "⏭️  Skipping $agent_name: CLI not installed"
        : $((skipped_count++))
        continue
    fi

    config_path=$(get_agent_config_path "$agent_name")
    config_dir=$(dirname "$config_path")
    config_file=$(basename "$config_path")

    # Ensure agent directory exists
    mkdir -p "$config_dir"

    # Check if block already exists and is correct (idempotency check)
    if [[ -f "$config_path" ]] && injection_has_block "$config_path"; then
        # Extract current block content to check if it's already correct
        current_block=$(sed -n '/<!-- CLEO:START -->/,/<!-- CLEO:END -->/p' "$config_path" 2>/dev/null || true)
        expected_block="<!-- CLEO:START -->
# Task Management
@~/.cleo/docs/TODO_Task_Management.md
<!-- CLEO:END -->"
        
        # If block already exists and is correct, and no force/update flags, skip
        if [[ "$current_block" == "$expected_block" ]] && [[ "$FORCE" != true ]] && [[ "$UPDATE" != true ]]; then
            echo "✓ $agent_name/$config_file: Already configured (no changes needed)"
            : $((no_change_count++))
            continue
        else
            echo "↻ $agent_name/$config_file: Updating configuration"
        fi
    else
        echo "📝 $agent_name/$config_file: Initial setup"
    fi

    # Create @ reference block (NO version - content is external, always current)
    injection_content="<!-- CLEO:START -->
# Task Management
@~/.cleo/docs/TODO_Task_Management.md
<!-- CLEO:END -->"

    # Create or update file with marker-based injection
    if [[ ! -f "$config_path" ]]; then
        # Create new file
        echo "$injection_content" > "$config_path"
        action="created"
        : $((configured_count++))
    elif injection_has_block "$config_path"; then
        # Update existing block (preserve all content outside markers)
        temp_file="${config_path}.tmp"

        # Extract content before markers (everything before CLEO:START)
        before=$(awk '
            /<!-- CLEO:START/ { exit }
            { print }
        ' "$config_path")
        
        # Extract content after markers (everything after CLEO:END)
        after=$(awk '
            /<!-- CLEO:END -->/ { found = 1; next }
            found { print }
        ' "$config_path")

        # Validate that we successfully extracted content (debugging)
        if [[ -z "$before" ]] && [[ -z "$after" ]] && [[ -s "$config_path" ]]; then
            echo "WARNING: Content extraction failed for $config_path - preserving original file"
            : $((no_change_count++))
            continue
        fi

        # Reconstruct file with proper content preservation
        {
            # Add before content if it exists
            if [[ -n "$before" ]]; then
                echo "$before"
                # Add separator if we also have after content
                [[ -n "$after" ]] && echo ""
            fi
            
            # Add the CLEO injection content
            echo "$injection_content"
            
            # Add after content if it exists
            [[ -n "$after" ]] && echo "$after"
        } > "$temp_file"

        # Atomic move
        mv "$temp_file" "$config_path"
        action="updated"
        : $((updated_count++))
    elif [[ "$MIGRATE_LEGACY" == true ]]; then
        # Migrate old append-style config to marker-based
        backup_path="${config_path}.pre-migration-$(date +%Y%m%d-%H%M%S)"
        cp "$config_path" "$backup_path"
        echo "📦 Backed up legacy config: $backup_path"

        # Extract user content (everything before any @TODO_Task_Management.md references)
        user_content=$(sed '/^# Task Management$/,/^@TODO_Task_Management\.md$/d' "$config_path")

        # Create new file with user content + marker-based injection
        {
            echo "$user_content"
            echo ""
            echo "$injection_content"
        } > "${config_path}.tmp"
        mv "${config_path}.tmp" "$config_path"
        action="migrated"
        echo "↻ Converted legacy append-style to marker-based injection"
        : $((configured_count++))
    else
        # Prepend to existing file (user content comes AFTER)
        {
            echo "$injection_content"
            echo ""
            cat "$config_path"
        } > "${config_path}.tmp"
        mv "${config_path}.tmp" "$config_path"
        action="prepended"
        : $((configured_count++))
    fi

    echo "✅ $agent_name/$config_file: Done ($action)"
done

# ==============================================================================
# SUMMARY
# ==============================================================================

echo ""
echo "✅ Agent config setup complete!"
echo "   Configured: $configured_count agents"
echo "   Updated: $updated_count agents"
echo "   Already configured: $no_change_count agents"
echo "   Skipped: $skipped_count agents (CLI not installed)"
echo ""
echo "These configs reference: @~/.cleo/docs/TODO_Task_Management.md"
echo "(No version tracking - external file always has current content)"

# Exit with appropriate code
total_changes=$((configured_count + updated_count))
if [[ $total_changes -eq 0 ]] && [[ $no_change_count -gt 0 ]]; then
    exit "$EXIT_NO_CHANGE"
fi

exit 0