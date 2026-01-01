#!/usr/bin/env bash
# size-weighting.sh - Task size weighting for analyze leverage scoring
#
# LAYER: 3 (Domain Logic)
# DEPENDENCIES: config.sh
# PROVIDES: calculate_size_weight, get_size_strategy

#=== SOURCE GUARD ================================================
[[ -n "${_SIZE_WEIGHTING_LOADED:-}" ]] && return 0
declare -r _SIZE_WEIGHTING_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source config.sh for get_config_value
if [[ -f "$_LIB_DIR/config.sh" ]]; then
    source "$_LIB_DIR/config.sh"
else
    echo "ERROR: Cannot find config.sh in $_LIB_DIR" >&2
    exit 1
fi

# ============================================================================
# STRATEGY HELPER FUNCTIONS
# ============================================================================

# Get current size strategy from config
# Returns: strategy name (quick-wins|big-impact|balanced)
get_size_strategy() {
    get_config_value "analyze.sizeStrategy" "balanced"
}

# ============================================================================
# SIZE WEIGHT CALCULATION
# ============================================================================

# Calculate weight multiplier for a task based on size and strategy
# Args: $1 = task_size (small|medium|large)
#       $2 = strategy (optional, defaults to config value)
# Returns: numeric weight multiplier (1, 2, or 3)
# Exit: 0 on success
calculate_size_weight() {
    local task_size="$1"
    local strategy="${2:-}"

    # If no strategy provided, get from config
    if [[ -z "$strategy" ]]; then
        strategy=$(get_size_strategy)
    fi

    # Validate strategy (use balanced for invalid values)
    case "$strategy" in
        quick-wins|big-impact|balanced)
            # Valid strategy
            ;;
        *)
            # Invalid strategy, default to balanced
            strategy="balanced"
            ;;
    esac

    # Strategy weights matrix
    # Format: strategy:size = weight
    local weight=1

    case "$strategy:$task_size" in
        # quick-wins: favor small tasks (3), penalize large (1)
        quick-wins:small)
            weight=3
            ;;
        quick-wins:medium)
            weight=2
            ;;
        quick-wins:large)
            weight=1
            ;;

        # big-impact: favor large tasks (3), penalize small (1)
        big-impact:small)
            weight=1
            ;;
        big-impact:medium)
            weight=2
            ;;
        big-impact:large)
            weight=3
            ;;

        # balanced: all equal (1)
        balanced:small|balanced:medium|balanced:large)
            weight=1
            ;;

        # Unknown/invalid size: default to 1
        *)
            weight=1
            ;;
    esac

    echo "$weight"
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f get_size_strategy
export -f calculate_size_weight
