#!/usr/bin/env bash
# experiments/setup-experiment.sh
# Sets up isolated environments for A/B testing CLEO value

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXPERIMENT_DIR="${EXPERIMENT_DIR:-/tmp/cleo-experiment}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

setup_cleo_environment() {
    log_info "Setting up CLEO environment..."
    local env_dir="$EXPERIMENT_DIR/cleo/repo"

    mkdir -p "$env_dir"

    # Copy essential files (not full clone to save space)
    cp -r "$PROJECT_ROOT/scripts" "$env_dir/"
    cp -r "$PROJECT_ROOT/lib" "$env_dir/"
    cp -r "$PROJECT_ROOT/schemas" "$env_dir/"
    cp -r "$PROJECT_ROOT/tests" "$env_dir/" 2>/dev/null || true
    cp "$PROJECT_ROOT/CLAUDE.md" "$env_dir/"
    cp -r "$PROJECT_ROOT/.cleo" "$env_dir/"

    # Initialize fresh CLEO state
    rm -f "$env_dir/.cleo/todo.json" "$env_dir/.cleo/todo-archive.json" "$env_dir/.cleo/sessions.json"
    echo "[]" > "$env_dir/.cleo/todo.json"
    echo "[]" > "$env_dir/.cleo/todo-archive.json"
    echo "[]" > "$env_dir/.cleo/sessions.json"

    log_success "CLEO environment ready: $env_dir"
}

setup_baseline_environment() {
    log_info "Setting up BASELINE environment (no task system)..."
    local env_dir="$EXPERIMENT_DIR/baseline/repo"

    mkdir -p "$env_dir"

    # Copy code only
    cp -r "$PROJECT_ROOT/scripts" "$env_dir/"
    cp -r "$PROJECT_ROOT/lib" "$env_dir/"
    cp -r "$PROJECT_ROOT/schemas" "$env_dir/"
    cp -r "$PROJECT_ROOT/tests" "$env_dir/" 2>/dev/null || true

    # Minimal CLAUDE.md
    cat > "$env_dir/CLAUDE.md" << 'EOF'
# CLEO - Task Management CLI

A bash-based task management system for developers.

## Project Structure
- `scripts/` - CLI command implementations
- `lib/` - Shared bash functions
- `schemas/` - JSON Schema definitions
- `tests/` - BATS test suite

## Coding Standards
- Bash with `set -euo pipefail`
- 4-space indentation
- Functions use snake_case
- All JSON operations use jq

## Testing
Run tests with: `bats tests/unit/*.bats`
EOF

    log_success "BASELINE environment ready: $env_dir"
}

setup_simple_todo_environment() {
    log_info "Setting up SIMPLE-TODO environment (markdown only)..."
    local env_dir="$EXPERIMENT_DIR/simple-todo/repo"

    mkdir -p "$env_dir"

    # Copy code only
    cp -r "$PROJECT_ROOT/scripts" "$env_dir/"
    cp -r "$PROJECT_ROOT/lib" "$env_dir/"
    cp -r "$PROJECT_ROOT/schemas" "$env_dir/"
    cp -r "$PROJECT_ROOT/tests" "$env_dir/" 2>/dev/null || true

    # CLAUDE.md with simple todo
    cat > "$env_dir/CLAUDE.md" << 'EOF'
# CLEO - Task Management CLI

A bash-based task management system for developers.

## Project Structure
- `scripts/` - CLI command implementations
- `lib/` - Shared bash functions
- `schemas/` - JSON Schema definitions
- `tests/` - BATS test suite

## Current Tasks
Track your work in this section:

- [ ] (Task will be assigned at runtime)

## Completed Tasks
- (None yet)

## Notes
Add implementation notes here as you work.

## Coding Standards
- Bash with `set -euo pipefail`
- 4-space indentation
- Functions use snake_case
EOF

    log_success "SIMPLE-TODO environment ready: $env_dir"
}

create_results_directory() {
    mkdir -p "$EXPERIMENT_DIR/results"

    # Create results template
    cat > "$EXPERIMENT_DIR/results/README.md" << 'EOF'
# Experiment Results

## Structure
- `{condition}_{task}_metrics.json` - Token usage per run
- `{condition}_{task}_output.txt` - Full agent output
- `all_metrics.json` - Aggregated results
- `summary.md` - Human-readable analysis

## Conditions
- `cleo` - Full CLEO task management
- `baseline` - No task system
- `simple_todo` - Markdown checklist only
EOF

    log_success "Results directory ready: $EXPERIMENT_DIR/results"
}

main() {
    log_info "Setting up CLEO Value Experiment"
    log_info "Experiment directory: $EXPERIMENT_DIR"
    echo ""

    # Clean previous experiment
    if [[ -d "$EXPERIMENT_DIR" ]]; then
        log_info "Cleaning previous experiment..."
        rm -rf "$EXPERIMENT_DIR"
    fi

    mkdir -p "$EXPERIMENT_DIR"

    setup_cleo_environment
    setup_baseline_environment
    setup_simple_todo_environment
    create_results_directory

    echo ""
    log_success "Experiment setup complete!"
    echo ""
    echo "Environments created:"
    echo "  - CLEO:       $EXPERIMENT_DIR/cleo/repo"
    echo "  - Baseline:   $EXPERIMENT_DIR/baseline/repo"
    echo "  - Simple-TODO: $EXPERIMENT_DIR/simple-todo/repo"
    echo ""
    echo "Next steps:"
    echo "  1. Run: ./experiments/run-quick-validation.sh"
    echo "  2. Or:  ./experiments/run-full-experiment.sh"
}

main "$@"
