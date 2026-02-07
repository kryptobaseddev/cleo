#!/usr/bin/env bash
###CLEO
# command: init
# category: maintenance
# synopsis: Initialize project (.cleo/ directory) with automatic agent docs injection
# relevance: low
# flags: --format,--quiet,--force,--confirm-wipe
# exits: 0,3,101
# json-output: true
###END
# CLEO Init Script
# Initialize the todo system in a project directory
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source paths.sh for path resolution functions
if [[ -f "$CLEO_HOME/lib/paths.sh" ]]; then
    source "$CLEO_HOME/lib/paths.sh"
elif [[ -f "$SCRIPT_DIR/../lib/paths.sh" ]]; then
    source "$SCRIPT_DIR/../lib/paths.sh"
fi

# Source version from central location
if [[ -f "$CLEO_HOME/VERSION" ]]; then
  VERSION="$(head -n 1 "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(head -n 1 "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="unknown"
fi

# Unset any existing log functions to prevent conflicts on re-initialization
unset -f log_info log_error log_warn log_debug 2>/dev/null || true

# Guard for re-sourcing libraries
if [[ -n "${_INIT_LOGGING_SOURCED:-}" ]]; then
    # Already sourced, skip
    :
else
    # Source library functions
    if [[ -f "$CLEO_HOME/lib/logging.sh" ]]; then
        source "$CLEO_HOME/lib/logging.sh"
        _INIT_LOGGING_SOURCED=true
    fi
fi

# Always define console logging functions (lib/logging.sh provides task logging, not console output)
log_info()    { echo "[INFO] $1"; }
log_warn()    { echo "[WARN] $1" >&2; }
log_success() { echo "[SUCCESS] $1"; }
# Only define log_error if not already defined by library
type -t log_error &>/dev/null || log_error() { echo "[ERROR] $1" >&2; }

# Optional: source other libraries if needed (with guards)
if [[ -z "${_INIT_FILE_OPS_SOURCED:-}" ]]; then
    [[ -f "$CLEO_HOME/lib/file-ops.sh" ]] && source "$CLEO_HOME/lib/file-ops.sh" && _INIT_FILE_OPS_SOURCED=true || true
fi
if [[ -z "${_INIT_VALIDATION_SOURCED:-}" ]]; then
    [[ -f "$CLEO_HOME/lib/validation.sh" ]] && source "$CLEO_HOME/lib/validation.sh" && _INIT_VALIDATION_SOURCED=true || true
fi
if [[ -z "${_INIT_BACKUP_SOURCED:-}" ]]; then
    [[ -f "$CLEO_HOME/lib/backup.sh" ]] && source "$CLEO_HOME/lib/backup.sh" && _INIT_BACKUP_SOURCED=true || true
fi
if [[ -z "${_INIT_AGENTS_INSTALL_SOURCED:-}" ]]; then
    [[ -f "$CLEO_HOME/lib/agents-install.sh" ]] && source "$CLEO_HOME/lib/agents-install.sh" && _INIT_AGENTS_INSTALL_SOURCED=true || true
fi

# Defaults
FORCE=false
CONFIRM_WIPE=false
UPDATE_DOCS=false
COPY_AGENTS=false
PROJECT_NAME=""
FORMAT=""
QUIET=false
COMMAND_NAME="init"
DRY_RUN=false
DETECT_MODE=false

# Source required libraries for LLM-Agent-First compliance
LIB_DIR="$CLEO_HOME/lib"
if [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
    source "$LIB_DIR/exit-codes.sh"
fi
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
    source "$LIB_DIR/error-json.sh"
fi

# Source output formatting and error libraries
LIB_DIR="$CLEO_HOME/lib"
if [[ -f "$LIB_DIR/output-format.sh" ]]; then
  source "$LIB_DIR/output-format.sh"
fi
if [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  source "$LIB_DIR/exit-codes.sh"
fi
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  source "$LIB_DIR/error-json.sh"
fi

# Source centralized flag parsing
if [[ -f "$LIB_DIR/flags.sh" ]]; then
  source "$LIB_DIR/flags.sh"
fi

usage() {
  cat << EOF
Usage: cleo init [PROJECT_NAME] [OPTIONS]

Initialize CLEO in the current directory.

Options:
  --force             Signal intent to reinitialize (requires --confirm-wipe)
  --confirm-wipe      Confirm data destruction when used with --force
  --update-docs       Update agent docs only (CLAUDE.md, AGENTS.md, GEMINI.md)
                      Safe to run on existing projects - does not touch task data
  --copy-agents       Install agents via copy instead of symlink
                      (default: symlink for auto-updating)
  --detect            Auto-detect project type and test framework
  --dry-run           Show detection results without writing files (requires --detect)
  -f, --format FMT    Output format: text, json (default: auto-detect)
  --human             Force human-readable text output
  --json              Force JSON output
  -q, --quiet         Suppress non-essential output
  -h, --help          Show this help

AGENT INSTALLATION:
  By default, agents are installed via symlinks to ~/.cleo/templates/agents/
  This allows automatic updates when CLEO is updated. Use --copy-agents to
  install as regular files if your editor doesn't support symlinks.

AGENT DOCUMENTATION UPDATE:
  Use --update-docs to create or update agent documentation files without
  affecting existing task data. Creates files if missing, updates if outdated.
  Also refreshes agent symlinks to ~/.claude/agents/

  Example: cleo init --update-docs

DESTRUCTIVE REINITIALIZE:
  Both --force AND --confirm-wipe are required to reinitialize an existing
  project. This will:
  1. Create a safety backup of ALL existing data files
  2. PERMANENTLY WIPE: todo.json, todo-archive.json, config.json, todo-log.json
  3. Initialize fresh data files

  Example: cleo init --force --confirm-wipe

Exit Codes:
  0   - Success
  101 - Project already initialized (use --force --confirm-wipe to reinitialize)
  102 - No changes needed (agent docs already up-to-date)
  2   - Invalid input (--force without --confirm-wipe)

Creates:
  .cleo/todo.json         Active tasks
  .cleo/todo-archive.json Completed tasks
  .cleo/config.json       Configuration
  .cleo/todo-log.json     Change history
  .cleo/sessions.json     Multi-session management
  .cleo/schemas/          JSON Schema files
  .cleo/templates/        Injection templates for @-references
  .cleo/.backups/         Backup directory
  ~/.claude/agents/       Agent definitions (symlinks by default)

JSON Output:
  {
    "_meta": {"command": "init", "timestamp": "..."},
    "success": true,
    "initialized": {"directory": ".cleo", "files": ["todo.json", ...]}
  }

Examples:
  cleo init                    # Initialize in current directory
  cleo init my-project         # Initialize with project name
  cleo init --detect --dry-run # Preview project detection without writing files
  cleo init --detect           # Initialize with auto-detected configuration
  cleo init --update-docs      # Update agent docs on existing project
  cleo init --copy-agents      # Install agents as files instead of symlinks
  cleo init --json             # JSON output for scripting
EOF
  exit 0
}

calculate_checksum() {
  # Calculate SHA-256 checksum of empty tasks array, truncated to 16 chars
  # Must match validate.sh: jq -c '.tasks' outputs with newline
  echo '[]' | sha256sum | cut -c1-16
}

generate_timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# Generate project-context.json for LLM agent consumption
# Called after successful detection
generate_project_context() {
    local project_type="$1"
    local framework="$2"
    local monorepo="$3"

    local context_file="${TODO_DIR}/project-context.json"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Determine file extension and test style hints based on framework
    local file_ext test_style common_patterns avoid_patterns
    case "$framework" in
        bats)
            file_ext=".bats"
            test_style="BATS with @test blocks"
            common_patterns='["Use setup/teardown for test fixtures","Use load for helper imports","Test one behavior per @test block"]'
            avoid_patterns='["Avoid complex bash in tests","Avoid hardcoded paths","Avoid testing implementation details"]'
            ;;
        jest|vitest)
            file_ext=".test.ts"
            test_style="$framework with describe/it blocks"
            common_patterns='["Use async/await over promises","Mock external dependencies","Group related tests in describe blocks"]'
            avoid_patterns='["Avoid require() in ESM projects","Avoid any type in strict mode","Avoid testing private functions"]'
            ;;
        playwright)
            file_ext=".spec.ts"
            test_style="Playwright with test() blocks"
            common_patterns='["Use page fixtures","Use expect assertions","Use data-testid selectors"]'
            avoid_patterns='["Avoid hardcoded timeouts","Avoid flaky selectors","Avoid testing implementation"]'
            ;;
        pytest)
            file_ext="_test.py"
            test_style="pytest with test_ prefix functions"
            common_patterns='["Use fixtures for setup","Use parametrize for data-driven tests","Use pytest.mark for test organization"]'
            avoid_patterns='["Avoid unittest style","Avoid print debugging","Avoid testing private methods"]'
            ;;
        go)
            file_ext="_test.go"
            test_style="go test with TestXxx functions"
            common_patterns='["Use table-driven tests","Use t.Helper for test helpers","Use subtests with t.Run"]'
            avoid_patterns='["Avoid global state","Avoid testing private functions","Avoid complex setup"]'
            ;;
        cargo)
            file_ext=".rs"
            test_style="cargo test with #[test] attributes"
            common_patterns='["Use assert! and assert_eq! macros","Use mod tests for unit tests","Use #[should_panic] for error tests"]'
            avoid_patterns='["Avoid unwrap in production code","Avoid println debugging","Avoid testing private functions"]'
            ;;
        *)
            file_ext=".test.js"
            test_style="Custom test framework"
            common_patterns='[]'
            avoid_patterns='[]'
            ;;
    esac

    # Determine type system hint
    local type_system="none"
    if [[ -f "tsconfig.json" ]]; then
        type_system="TypeScript"
        if grep -q '"strict": true' tsconfig.json 2>/dev/null; then
            type_system="TypeScript strict mode"
        fi
    elif [[ "$project_type" == "python" ]]; then
        type_system="Python with type hints"
    elif [[ "$project_type" == "rust" ]]; then
        type_system="Rust (statically typed)"
    elif [[ "$project_type" == "go" ]]; then
        type_system="Go (statically typed)"
    fi

    # Determine file naming convention
    local file_naming="kebab-case"
    if [[ "$project_type" == "python" ]]; then
        file_naming="snake_case"
    elif [[ "$project_type" == "go" || "$project_type" == "rust" ]]; then
        file_naming="snake_case"
    fi

    # Generate project-context.json
    cat > "$context_file" << EOF
{
  "\$schema": "https://cleo-dev.com/schemas/v1/project-context.schema.json",
  "schemaVersion": "1.0.0",
  "detectedAt": "$timestamp",
  "projectTypes": ["$project_type"],
  "primaryType": "$project_type",
  "monorepo": $monorepo,
  "testing": {
    "framework": "$framework",
    "testFilePatterns": ["**/*$file_ext"],
    "directories": {
      "unit": "tests/unit",
      "integration": "tests/integration"
    }
  },
  "conventions": {
    "fileNaming": "$file_naming",
    "typeSystem": "$type_system"
  },
  "llmHints": {
    "preferredTestStyle": "$test_style",
    "typeSystem": "$type_system",
    "commonPatterns": $common_patterns,
    "avoidPatterns": $avoid_patterns
  }
}
EOF

    log_info "Generated project-context.json"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --force) FORCE=true; shift ;;
    --confirm-wipe) CONFIRM_WIPE=true; shift ;;
    --update-docs) UPDATE_DOCS=true; shift ;;
    --copy-agents) COPY_AGENTS=true; shift ;;
    --detect) DETECT_MODE=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -f|--format) FORMAT="$2"; shift 2 ;;
    --human) FORMAT="text"; shift ;;
    --json) FORMAT="json"; shift ;;
    -q|--quiet) QUIET=true; shift ;;
    -h|--help) usage ;;
    -*)
      if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
        output_error "$E_INPUT_INVALID" "Unknown option: $1" "${EXIT_INVALID_INPUT:-1}" true "Run 'cleo init --help' for usage"
      else
        output_error "$E_INPUT_INVALID" "Unknown option: $1"
      fi
      exit "${EXIT_INVALID_INPUT:-1}"
      ;;
    *) PROJECT_NAME="$1"; shift ;;
  esac
done

# Resolve output format (CLI > env > config > TTY-aware default)
if declare -f resolve_format &>/dev/null; then
  FORMAT=$(resolve_format "$FORMAT")
else
  FORMAT="${FORMAT:-text}"
fi

# Redefine log functions to respect FORMAT
log_info()    { [[ "$QUIET" != true && "$FORMAT" != "json" ]] && echo "[INFO] $1" || true; }
log_warn()    { [[ "$FORMAT" != "json" ]] && echo "[WARN] $1" >&2 || true; }
log_success() { [[ "$FORMAT" != "json" ]] && echo "[SUCCESS] $1" || true; }
log_error()   { [[ "$FORMAT" != "json" ]] && echo "[ERROR] $1" >&2 || true; }

# Determine project name
[[ -z "$PROJECT_NAME" ]] && PROJECT_NAME=$(basename "$PWD")
PROJECT_NAME=$(echo "$PROJECT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')

# ============================================================================
# DETECTION MODE (--detect / --dry-run)
# ============================================================================

# Validate --dry-run requires --detect
if [[ "$DRY_RUN" == true ]] && [[ "$DETECT_MODE" != true ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
        output_error "$E_INPUT_INVALID" "--dry-run requires --detect flag" "${EXIT_INVALID_INPUT:-2}" true "Run 'cleo init --detect --dry-run' to preview detection results"
    else
        log_error "--dry-run requires --detect flag"
        log_info "Usage: cleo init --detect --dry-run"
    fi
    exit "${EXIT_INVALID_INPUT:-2}"
fi

# Run detection mode if requested
if [[ "$DETECT_MODE" == true ]]; then
    # Source project detection library
    if [[ -f "$CLEO_HOME/lib/project-detect.sh" ]]; then
        source "$CLEO_HOME/lib/project-detect.sh"
    elif [[ -f "$SCRIPT_DIR/../lib/project-detect.sh" ]]; then
        source "$SCRIPT_DIR/../lib/project-detect.sh"
    else
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_FILE_NOT_FOUND" "Project detection library not found" "${EXIT_FILE_ERROR:-4}" true "Ensure CLEO is properly installed"
        else
            log_error "Project detection library not found at $CLEO_HOME/lib/project-detect.sh"
        fi
        exit "${EXIT_FILE_ERROR:-4}"
    fi

    log_info "Detecting project configuration..."

    # Run full detection
    detection_result=$(run_full_detection)

    # Extract results
    project_type=$(echo "$detection_result" | jq -r '.projectType')
    framework=$(echo "$detection_result" | jq -r '.framework')
    confidence=$(echo "$detection_result" | jq -r '.confidence')
    detected_from=$(echo "$detection_result" | jq -r '.detectedFrom')
    monorepo=$(echo "$detection_result" | jq -r '.monorepo')

    # Dry-run mode - show results and exit
    if [[ "$DRY_RUN" == true ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            jq -nc \
                --arg version "$VERSION" \
                --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
                --arg projectType "$project_type" \
                --arg framework "$framework" \
                --arg confidence "$confidence" \
                --arg detectedFrom "$detected_from" \
                --argjson monorepo "$monorepo" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "format": "json",
                        "command": "init --detect --dry-run",
                        "timestamp": $timestamp,
                        "version": $version
                    },
                    "success": true,
                    "dryRun": true,
                    "detection": {
                        "projectType": $projectType,
                        "framework": $framework,
                        "confidence": $confidence,
                        "detectedFrom": $detectedFrom,
                        "monorepo": $monorepo
                    },
                    "suggestedActions": [
                        "Review detection results above",
                        "Run without --dry-run to apply configuration",
                        "Use --force --confirm-wipe to reinitialize existing projects"
                    ]
                }'
        else
            log_info "Dry-run mode - no files will be written"
            echo ""
            echo "Detection Results:"
            echo "  Project Type:    $project_type"
            echo "  Test Framework:  $framework"
            echo "  Confidence:      $confidence"
            echo "  Detected From:   $detected_from"
            echo "  Monorepo:        $monorepo"
            echo ""
            echo "Suggested Actions:"
            echo "  1. Review detection results above"
            echo "  2. Run without --dry-run to apply configuration"
            echo "  3. Use --force --confirm-wipe to reinitialize existing projects"
        fi
        exit 0
    fi

    # Normal detection mode - continue with initialization using detected values
    log_info "Project Type:    $project_type"
    log_info "Test Framework:  $framework"
    log_info "Confidence:      $confidence"
    log_info "Detected From:   $detected_from"
    log_info "Monorepo:        $monorepo"
    echo ""

    # Store detection results for later use
    DETECTED_PROJECT_TYPE="$project_type"
    DETECTED_FRAMEWORK="$framework"
    DETECTED_MONOREPO="$monorepo"

    # TODO: Apply detection results to config.json
    # This will be implemented in subsequent tasks (T2782, T2783)
fi

# ============================================================================
# CHECK FOR EXISTING INITIALIZATION (with proper safeguards)
# ============================================================================

# List of data files that would be wiped during reinitialize
DATA_FILES=("todo.json" "todo-archive.json" "config.json" "todo-log.json")
TODO_DIR=".cleo"

# Check if project is already initialized
_project_initialized() {
    [[ -f "$TODO_DIR/todo.json" ]]
}

# Count existing data files for reporting
_count_existing_files() {
    local count=0
    for file in "${DATA_FILES[@]}"; do
        [[ -f "$TODO_DIR/$file" ]] && ((count++))
    done
    echo "$count"
}

# Create safety backup of ALL data files before destructive reinit
_create_init_safety_backup() {
    local backup_timestamp
    backup_timestamp=$(date +"%Y%m%d_%H%M%S")
    local backup_id="safety_${backup_timestamp}_init_reinitialize"
    local backup_path="$TODO_DIR/backups/safety/$backup_id"
    local files_backed_up=0
    local total_size=0

    # Ensure backup directory exists
    mkdir -p "$backup_path" 2>/dev/null || {
        log_error "Failed to create backup directory: $backup_path"
        return 1
    }

    # Backup each existing data file
    for file in "${DATA_FILES[@]}"; do
        local source_file="$TODO_DIR/$file"
        if [[ -f "$source_file" ]]; then
            cp "$source_file" "$backup_path/$file" || {
                log_error "Failed to backup $file"
                return 1
            }
            ((files_backed_up++))
            # Get file size
            if command -v stat &>/dev/null; then
                local fsize
                fsize=$(stat -c%s "$source_file" 2>/dev/null || stat -f%z "$source_file" 2>/dev/null || echo 0)
                total_size=$((total_size + fsize))
            fi
        fi
    done

    # Create metadata.json for the backup
    if command -v jq &>/dev/null; then
        local ts_iso
        ts_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        jq -nc \
            --arg type "safety" \
            --arg ts "$ts_iso" \
            --arg ver "$VERSION" \
            --arg trigger "init_reinitialize" \
            --arg op "reinitialize" \
            --argjson size "$total_size" \
            --argjson count "$files_backed_up" \
            '{
                backupType: $type,
                timestamp: $ts,
                version: $ver,
                trigger: $trigger,
                operation: $op,
                totalSize: $size,
                fileCount: $count,
                files: [],
                neverDelete: false
            }' > "$backup_path/metadata.json"
    fi

    echo "$backup_path"
    return 0
}

if _project_initialized; then
    existing_count=$(_count_existing_files)

    # Handle --update-docs flag (safe operation, doesn't touch task data)
    if [[ "$UPDATE_DOCS" == true ]]; then
        # Refresh agent symlinks first (remove and recreate)
        if declare -f uninstall_agents &>/dev/null && declare -f install_agents &>/dev/null; then
            log_info "Refreshing agent symlinks..."
            uninstall_agents "log_info"
            install_agents "symlink" "log_info"
        fi

        # Source injection library
        if [[ -f "$CLEO_HOME/lib/injection.sh" ]]; then
            source "$CLEO_HOME/lib/injection.sh"

            result=$(injection_update_all ".")
            updated=$(echo "$result" | jq -r '.updated')
            skipped=$(echo "$result" | jq -r '.skipped')
            failed=$(echo "$result" | jq -r '.failed')

            if [[ "$FORMAT" == "json" ]]; then
                jq -nc \
                    --arg version "$VERSION" \
                    --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
                    --argjson updated "$updated" \
                    --argjson skipped "$skipped" \
                    --argjson failed "$failed" \
                    '{
                        "_meta": {
                            "format": "json",
                            "version": $version,
                            "command": "init --update-docs",
                            "timestamp": $timestamp
                        },
                        "success": ($failed == 0),
                        "agentDocs": {
                            "updated": $updated,
                            "skipped": $skipped,
                            "failed": $failed,
                            "targets": ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]
                        }
                    }'
            else
                if [[ "$updated" -gt 0 ]]; then
                    log_success "Updated $updated agent doc file(s)"
                elif [[ "$skipped" -gt 0 ]]; then
                    log_info "Agent docs already up-to-date ($skipped file(s))"
                fi
                if [[ "$failed" -gt 0 ]]; then
                    log_warn "Failed to update $failed agent doc file(s)"
                fi
            fi

            # Exit codes: 0 = updated, 102 = no changes needed, 1 = failures
            if [[ "$failed" -gt 0 ]]; then
                exit 1
            elif [[ "$updated" -eq 0 ]] && [[ "$skipped" -gt 0 ]]; then
                exit "${EXIT_NO_CHANGE:-102}"
            else
                exit 0
            fi
        else
            log_error "Injection library not found at $CLEO_HOME/lib/injection.sh"
            exit 1
        fi
    fi

    if [[ "$FORCE" != true ]]; then
        # Project exists, --force not provided
        # Exit with EXIT_ALREADY_EXISTS (101) per LLM-Agent-First spec
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            jq -nc \
                --arg version "$VERSION" \
                --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
                --argjson existingFiles "$existing_count" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/error.schema.json",
                    "_meta": {
                        "format": "json",
                        "version": $version,
                        "command": "init",
                        "timestamp": $timestamp
                    },
                    "success": false,
                    "error": {
                        "code": "E_ALREADY_INITIALIZED",
                        "message": "Project already initialized at .cleo/todo.json",
                        "exitCode": 101,
                        "recoverable": true,
                        "suggestion": "Use --force --confirm-wipe to reinitialize (DESTRUCTIVE: will wipe all existing data after creating safety backup)",
                        "context": {
                            "existingFiles": $existingFiles,
                            "dataDirectory": ".cleo",
                            "affectedFiles": ["todo.json", "todo-archive.json", "config.json", "todo-log.json"]
                        }
                    }
                }'
        else
            log_warn "Project already initialized at .cleo/todo.json"
            log_warn "Found $existing_count data file(s) that would be WIPED:"
            for file in "${DATA_FILES[@]}"; do
                [[ -f "$TODO_DIR/$file" ]] && log_warn "  - $TODO_DIR/$file"
            done
            log_warn ""
            log_warn "To reinitialize, use BOTH flags: --force --confirm-wipe"
            log_warn "This will create a safety backup before wiping ALL existing data."
        fi
        exit "${EXIT_ALREADY_EXISTS:-101}"
    fi

    if [[ "$CONFIRM_WIPE" != true ]]; then
        # --force provided but --confirm-wipe not provided
        # Exit with EXIT_INVALID_INPUT (2) - missing required confirmation
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            jq -nc \
                --arg version "$VERSION" \
                --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
                --argjson existingFiles "$existing_count" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/error.schema.json",
                    "_meta": {
                        "format": "json",
                        "version": $version,
                        "command": "init",
                        "timestamp": $timestamp
                    },
                    "success": false,
                    "error": {
                        "code": "E_CONFIRMATION_REQUIRED",
                        "message": "--force requires --confirm-wipe to proceed with destructive reinitialize",
                        "exitCode": 2,
                        "recoverable": true,
                        "suggestion": "Add --confirm-wipe to confirm you want to WIPE all existing data (a safety backup will be created first)",
                        "context": {
                            "existingFiles": $existingFiles,
                            "dataDirectory": ".cleo",
                            "affectedFiles": ["todo.json", "todo-archive.json", "config.json", "todo-log.json"],
                            "safetyBackupLocation": ".cleo/backups/safety/"
                        }
                    }
                }'
        else
            log_error "--force requires --confirm-wipe for destructive reinitialize"
            log_warn ""
            log_warn "⚠️  DESTRUCTIVE OPERATION WARNING ⚠️"
            log_warn "This will PERMANENTLY WIPE $existing_count data file(s):"
            for file in "${DATA_FILES[@]}"; do
                [[ -f "$TODO_DIR/$file" ]] && log_warn "  - $TODO_DIR/$file"
            done
            log_warn ""
            log_warn "A safety backup will be created at: .cleo/backups/safety/"
            log_warn ""
            log_warn "To proceed, run: cleo init --force --confirm-wipe"
        fi
        exit "${EXIT_INVALID_INPUT:-2}"
    fi

    # Both --force and --confirm-wipe provided - proceed with backup then wipe
    log_info "Creating safety backup before reinitialize..."
    backup_path=$(_create_init_safety_backup)
    backup_result=$?

    if [[ $backup_result -ne 0 ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "E_FILE_WRITE_ERROR" "Failed to create safety backup - aborting reinitialize" "${EXIT_FILE_ERROR:-3}" false "Check disk space and permissions for .cleo/backups/safety/"
        else
            log_error "Failed to create safety backup - aborting reinitialize"
            log_error "Existing data has NOT been modified."
        fi
        exit "${EXIT_FILE_ERROR:-3}"
    fi

    log_info "Safety backup created at: $backup_path"
    log_warn "Proceeding with DESTRUCTIVE reinitialize - wiping existing data..."

    # Remove existing data files (backup already created)
    for file in "${DATA_FILES[@]}"; do
        [[ -f "$TODO_DIR/$file" ]] && rm -f "$TODO_DIR/$file"
    done
fi

TIMESTAMP=$(generate_timestamp)
CHECKSUM=$(calculate_checksum)
# TODO_DIR already set above in the safeguard section

# Determine templates and schemas directories (installed or source)
if [[ -d "$CLEO_HOME/templates" ]]; then
  TEMPLATES_DIR="$CLEO_HOME/templates"
elif [[ -d "$SCRIPT_DIR/../templates" ]]; then
  TEMPLATES_DIR="$SCRIPT_DIR/../templates"
else
  if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
    output_error "$E_FILE_NOT_FOUND" "Templates directory not found at $CLEO_HOME/templates/ or $SCRIPT_DIR/../templates/" "${EXIT_FILE_ERROR:-4}" true "Run install.sh to set up CLEO globally, or run from source directory."
  else
    output_error "$E_FILE_NOT_FOUND" "Templates directory not found at $CLEO_HOME/templates/ or $SCRIPT_DIR/../templates/"
    log_error "Run install.sh to set up CLEO globally, or run from source directory."
  fi
  exit "${EXIT_FILE_ERROR:-1}"
fi

if [[ -d "$CLEO_HOME/schemas" ]]; then
  SCHEMAS_DIR="$CLEO_HOME/schemas"
elif [[ -d "$SCRIPT_DIR/../schemas" ]]; then
  SCHEMAS_DIR="$SCRIPT_DIR/../schemas"
else
  SCHEMAS_DIR=""
fi

log_info "Initializing CLEO for project: $PROJECT_NAME"

# Create .cleo directory structure
mkdir -p "$TODO_DIR"
mkdir -p "$TODO_DIR/schemas"

# Copy backup directory structure from templates
if [[ -d "$TEMPLATES_DIR/backups" ]]; then
  # Create backups directory first
  mkdir -p "$TODO_DIR/backups"
  # Copy backup type directories and .gitkeep files
  for backup_type in snapshot safety incremental archive migration; do
    if [[ -d "$TEMPLATES_DIR/backups/$backup_type" ]]; then
      mkdir -p "$TODO_DIR/backups/$backup_type"
      # Copy .gitkeep if it exists
      if [[ -f "$TEMPLATES_DIR/backups/$backup_type/.gitkeep" ]]; then
        cp "$TEMPLATES_DIR/backups/$backup_type/.gitkeep" "$TODO_DIR/backups/$backup_type/"
      fi
    fi
  done
  log_info "Created $TODO_DIR/ directory with backup type subdirectories from templates"
else
  # Fallback: create directories manually if templates not available
  mkdir -p "$TODO_DIR/backups/snapshot"
  mkdir -p "$TODO_DIR/backups/safety"
  mkdir -p "$TODO_DIR/backups/incremental"
  mkdir -p "$TODO_DIR/backups/archive"
  mkdir -p "$TODO_DIR/backups/migration"
  # Create .gitkeep files to preserve directory structure in git
  touch "$TODO_DIR/backups/snapshot/.gitkeep"
  touch "$TODO_DIR/backups/safety/.gitkeep"
  touch "$TODO_DIR/backups/incremental/.gitkeep"
  touch "$TODO_DIR/backups/archive/.gitkeep"
  touch "$TODO_DIR/backups/migration/.gitkeep"
  log_info "Created $TODO_DIR/ directory with backup type subdirectories"
fi

# Copy schemas for local validation
if [[ -n "$SCHEMAS_DIR" ]]; then
  cp "$SCHEMAS_DIR/"*.json "$TODO_DIR/schemas/"
  log_info "Copied schemas to $TODO_DIR/schemas/"
else
  log_warn "Schemas not found (schema validation may fail)"
fi

# Create templates directory and copy injection template
mkdir -p "$TODO_DIR/templates"
if [[ -f "$TEMPLATES_DIR/AGENT-INJECTION.md" ]]; then
    cp "$TEMPLATES_DIR/AGENT-INJECTION.md" "$TODO_DIR/templates/" && \
        log_info "Copied AGENT-INJECTION.md template to $TODO_DIR/templates/"
else
    log_warn "AGENT-INJECTION.md template not found at $TEMPLATES_DIR/AGENT-INJECTION.md"
fi

# Migrate research-outputs to agent-outputs if needed (T2366)
# Part of Cross-Agent Communication Protocol Unification (T2348)
# This must happen BEFORE creating agent-outputs to preserve existing data
if type check_agent_outputs_migration_needed &>/dev/null; then
    if check_agent_outputs_migration_needed "."; then
        log_info "Detected existing research-outputs directory, migrating to agent-outputs..."
        migration_result=0
        migrate_agent_outputs_dir "." || migration_result=$?
        case $migration_result in
            0)
                log_info "Successfully migrated research-outputs/ to agent-outputs/"
                ;;
            100)
                # Already migrated or nothing to do - not an error
                log_info "Agent outputs directory already in correct location"
                ;;
            *)
                log_warn "Agent outputs migration failed (exit code: $migration_result)"
                log_warn "Manual migration may be required: mv claudedocs/research-outputs claudedocs/agent-outputs"
                ;;
        esac
    fi
fi

# Create agent-outputs directory structure
# This enables research subcommands without requiring `cleo research init`
log_info "Creating agent outputs directory structure..."
RESEARCH_OUTPUT_DIR="claudedocs/agent-outputs"
mkdir -p "$RESEARCH_OUTPUT_DIR"
mkdir -p "$RESEARCH_OUTPUT_DIR/archive"
# Create empty MANIFEST.jsonl (JSONL format - one JSON object per line)
if [[ ! -f "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl" ]]; then
    touch "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl"
    log_info "Created $RESEARCH_OUTPUT_DIR/ with MANIFEST.jsonl"
else
    log_info "Research outputs directory already exists at $RESEARCH_OUTPUT_DIR/"
fi

# NOTE: SUBAGENT_PROTOCOL.md and INJECT.md are no longer copied to output dir
# The protocol is now accessed via 'cleo research inject' command
# Legacy files in output dirs can be safely deleted

# ============================================================================
# EXTRACT SCHEMA VERSIONS FROM SOURCE OF TRUTH
# ============================================================================
# Schema files are the single source of truth for version numbers
# Extract versions before template processing

# Set SCHEMA_DIR for migrate.sh to use (must match SCHEMAS_DIR from above)
export SCHEMA_DIR="$SCHEMAS_DIR"

# Source migrate.sh for get_schema_version_from_file() function
if [[ -f "$CLEO_HOME/lib/migrate.sh" ]]; then
  source "$CLEO_HOME/lib/migrate.sh"
elif [[ -f "$SCRIPT_DIR/../lib/migrate.sh" ]]; then
  source "$SCRIPT_DIR/../lib/migrate.sh"
else
  log_error "migrate.sh not found - cannot extract schema versions"
  exit 1
fi

# Extract schema versions (using existing helper function)
SCHEMA_VERSION_TODO=$(get_schema_version_from_file "todo" 2>/dev/null || echo "2.6.0")
SCHEMA_VERSION_CONFIG=$(get_schema_version_from_file "config" 2>/dev/null || echo "2.4.0")
SCHEMA_VERSION_ARCHIVE=$(get_schema_version_from_file "archive" 2>/dev/null || echo "2.4.0")
SCHEMA_VERSION_LOG=$(get_schema_version_from_file "log" 2>/dev/null || echo "2.4.0")

# sessions.schema.json has schemaVersion field
SCHEMA_VERSION_SESSIONS=$(jq -r '.schemaVersion // "1.0.0"' "$SCHEMAS_DIR/sessions.schema.json" 2>/dev/null || echo "1.0.0")

# global-config.schema.json does NOT have schemaVersion field (it uses version field in the data)
# For global-config, we'll use the VERSION constant (cleo version) as fallback
SCHEMA_VERSION_GLOBAL_CONFIG="$VERSION"

log_info "Schema versions extracted:"
log_info "  TODO: $SCHEMA_VERSION_TODO"
log_info "  Config: $SCHEMA_VERSION_CONFIG"
log_info "  Archive: $SCHEMA_VERSION_ARCHIVE"
log_info "  Log: $SCHEMA_VERSION_LOG"
log_info "  Sessions: $SCHEMA_VERSION_SESSIONS"
log_info "  Global Config: $SCHEMA_VERSION_GLOBAL_CONFIG"

# Create todo.json from template
log_info "Creating todo.json from template..."
if [[ -f "$TEMPLATES_DIR/todo.template.json" ]]; then
  # Process template and replace all placeholders
  sed -e "s/{{PROJECT_NAME}}/$PROJECT_NAME/g" \
      -e "s/{{TIMESTAMP}}/$TIMESTAMP/g" \
      -e "s/{{CHECKSUM}}/$CHECKSUM/g" \
      -e "s/{{VERSION}}/$VERSION/g" \
      -e "s/{{SCHEMA_VERSION_TODO}}/$SCHEMA_VERSION_TODO/g" \
      -e "s/{{SCHEMA_VERSION_CONFIG}}/$SCHEMA_VERSION_CONFIG/g" \
      -e 's|"\$schema": "../schemas/todo.schema.json"|"$schema": "./schemas/todo.schema.json"|' \
      "$TEMPLATES_DIR/todo.template.json" > "$TODO_DIR/todo.json"

  # Verify no placeholders remain
  if grep -q '{{' "$TODO_DIR/todo.json"; then
    log_error "Placeholder replacement failed in todo.json"
    grep '{{' "$TODO_DIR/todo.json" >&2
    exit 1
  fi

  log_info "Created $TODO_DIR/todo.json"
else
  log_error "Template not found: $TEMPLATES_DIR/todo.template.json"
  exit 1
fi

# Create todo-archive.json from template
log_info "Creating todo-archive.json from template..."
if [[ -f "$TEMPLATES_DIR/archive.template.json" ]]; then
  # Process template and replace all placeholders
  sed -e "s/{{PROJECT_NAME}}/$PROJECT_NAME/g" \
      -e "s/{{VERSION}}/$VERSION/g" \
      -e "s/{{SCHEMA_VERSION_ARCHIVE}}/$SCHEMA_VERSION_ARCHIVE/g" \
      -e 's|"\$schema": "../schemas/archive.schema.json"|"$schema": "./schemas/archive.schema.json"|' \
      "$TEMPLATES_DIR/archive.template.json" > "$TODO_DIR/todo-archive.json"

  # Verify no placeholders remain
  if grep -q '{{' "$TODO_DIR/todo-archive.json"; then
    log_error "Placeholder replacement failed in todo-archive.json"
    grep '{{' "$TODO_DIR/todo-archive.json" >&2
    exit 1
  fi

  log_info "Created $TODO_DIR/todo-archive.json"
else
  log_error "Template not found: $TEMPLATES_DIR/archive.template.json"
  exit 1
fi

# Create config.json from template
log_info "Creating config.json from template..."
if [[ -f "$TEMPLATES_DIR/config.template.json" ]]; then
  # Process template and replace all placeholders
  sed -e "s/{{VERSION}}/$VERSION/g" \
      -e "s/{{SCHEMA_VERSION_CONFIG}}/$SCHEMA_VERSION_CONFIG/g" \
      -e "s/{{SCHEMA_VERSION_TODO}}/$SCHEMA_VERSION_TODO/g" \
      -e "s/{{SCHEMA_VERSION_ARCHIVE}}/$SCHEMA_VERSION_ARCHIVE/g" \
      -e "s/{{SCHEMA_VERSION_LOG}}/$SCHEMA_VERSION_LOG/g" \
      -e "s/{{TIMESTAMP}}/$TIMESTAMP/g" \
      -e 's|"\$schema": "../schemas/config.schema.json"|"$schema": "./schemas/config.schema.json"|' \
      "$TEMPLATES_DIR/config.template.json" > "$TODO_DIR/config.json"

  # Verify no placeholders remain
  if grep -q '{{' "$TODO_DIR/config.json"; then
    log_error "Placeholder replacement failed in config.json"
    grep '{{' "$TODO_DIR/config.json" >&2
    exit 1
  fi

  log_info "Created $TODO_DIR/config.json"
else
  log_error "Template not found: $TEMPLATES_DIR/config.template.json"
  exit 1
fi

# Create todo-log.json from template
log_info "Creating todo-log.json from template..."
if [[ -f "$TEMPLATES_DIR/log.template.json" ]]; then
  # Process template and replace all placeholders
  sed -e "s/{{PROJECT_NAME}}/$PROJECT_NAME/g" \
      -e "s/{{VERSION}}/$VERSION/g" \
      -e "s/{{SCHEMA_VERSION_LOG}}/$SCHEMA_VERSION_LOG/g" \
      -e 's|"\$schema": "../schemas/log.schema.json"|"$schema": "./schemas/log.schema.json"|' \
      "$TEMPLATES_DIR/log.template.json" > "$TODO_DIR/todo-log.json"

  # Add initialization log entry
  # Generate random log ID
  LOG_ID="log_$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 12)"

  # Update meta information and add entry using jq
  if command -v jq &> /dev/null; then
    jq --arg timestamp "$TIMESTAMP" \
       --arg log_id "$LOG_ID" \
       --arg project "$PROJECT_NAME" \
       '._meta.totalEntries = 1 |
        ._meta.firstEntry = $timestamp |
        ._meta.lastEntry = $timestamp |
        .entries = [{
          "id": $log_id,
          "timestamp": $timestamp,
          "sessionId": null,
          "action": "system_initialized",
          "actor": "system",
          "taskId": null,
          "before": null,
          "after": null,
          "details": ("CLEO system initialized for project: " + $project)
        }]' "$TODO_DIR/todo-log.json" > "$TODO_DIR/todo-log.json.tmp"

    mv "$TODO_DIR/todo-log.json.tmp" "$TODO_DIR/todo-log.json"
  else
    log_warn "jq not installed - log entry not added"
  fi

  # Verify no placeholders remain
  if grep -q '{{' "$TODO_DIR/todo-log.json"; then
    log_error "Placeholder replacement failed in todo-log.json"
    grep '{{' "$TODO_DIR/todo-log.json" >&2
    exit 1
  fi

  log_info "Created $TODO_DIR/todo-log.json"
else
  log_error "Template not found: $TEMPLATES_DIR/log.template.json"
  exit 1
fi

# Create sessions.json from template (for Epic-Bound Session architecture)
log_info "Creating sessions.json from template..."
if [[ -f "$TEMPLATES_DIR/sessions.template.json" ]]; then
  # Process template and replace all placeholders
  sed -e "s/{{PROJECT_NAME}}/$PROJECT_NAME/g" \
      -e "s/{{TIMESTAMP}}/$TIMESTAMP/g" \
      -e "s/{{SCHEMA_VERSION_SESSIONS}}/$SCHEMA_VERSION_SESSIONS/g" \
      -e 's|"\$schema": "../schemas/sessions.schema.json"|"$schema": "./schemas/sessions.schema.json"|' \
      "$TEMPLATES_DIR/sessions.template.json" > "$TODO_DIR/sessions.json"

  # Verify no placeholders remain
  if grep -q '{{' "$TODO_DIR/sessions.json"; then
    log_error "Placeholder replacement failed in sessions.json"
    grep '{{' "$TODO_DIR/sessions.json" >&2
    exit 1
  fi

  log_info "Created $TODO_DIR/sessions.json"
else
  log_warn "Template not found: $TEMPLATES_DIR/sessions.template.json (multi-session will initialize on first use)"
fi

# Create migrations.json from template (for migration audit trail)
log_info "Creating migrations.json from template..."
if declare -f init_migrations_journal &>/dev/null; then
  if init_migrations_journal "$TODO_DIR"; then
    log_info "Created $TODO_DIR/migrations.json"
  else
    log_warn "Failed to create migrations.json (migration tracking will be unavailable)"
  fi
else
  log_warn "init_migrations_journal function not available (ensure lib/migrate.sh is sourced)"
fi

# Generate project-context.json if detection mode was used
if [[ "${DETECT_MODE:-false}" == true ]] && [[ -n "${DETECTED_PROJECT_TYPE:-}" ]]; then
  log_info "Generating project-context.json from detection results..."
  generate_project_context \
    "${DETECTED_PROJECT_TYPE}" \
    "${DETECTED_FRAMEWORK:-custom}" \
    "${DETECTED_MONOREPO:-false}"
fi

# Recalculate checksum from actual tasks array to ensure validity
log_info "Recalculating checksum from actual tasks array..."
if command -v jq &> /dev/null && [[ -f "$TODO_DIR/todo.json" ]]; then
  ACTUAL_TASKS=$(jq -c '.tasks' "$TODO_DIR/todo.json")
  FINAL_CHECKSUM=$(echo "$ACTUAL_TASKS" | sha256sum | cut -c1-16)

  # Update checksum in the file
  local _init_content
  _init_content=$(jq --arg cs "$FINAL_CHECKSUM" '._meta.checksum = $cs' "$TODO_DIR/todo.json")
  local _init_tmp
  _init_tmp=$(mktemp "${TODO_DIR}/todo.json.XXXXXX")
  echo "$_init_content" > "$_init_tmp" && mv "$_init_tmp" "$TODO_DIR/todo.json" || rm -f "$_init_tmp"
  log_info "Updated checksum to: $FINAL_CHECKSUM"
else
  log_warn "jq not installed - skipping checksum recalculation"
fi

# Validate created files
log_info "Validating created files..."
if command -v jq &> /dev/null; then
  # Validate JSON syntax for required files
  for file in "$TODO_DIR/todo.json" "$TODO_DIR/todo-archive.json" "$TODO_DIR/config.json" "$TODO_DIR/todo-log.json"; do
    if jq empty "$file" 2>/dev/null; then
      log_info "✓ Valid JSON: $(basename "$file")"
    else
      log_error "✗ Invalid JSON: $file"
      exit 1
    fi
  done
  # Validate optional sessions.json if it was created
  if [[ -f "$TODO_DIR/sessions.json" ]]; then
    if jq empty "$TODO_DIR/sessions.json" 2>/dev/null; then
      log_info "✓ Valid JSON: sessions.json"
    else
      log_error "✗ Invalid JSON: $TODO_DIR/sessions.json"
      exit 1
    fi
  fi
  # Validate optional migrations.json if it was created
  if [[ -f "$TODO_DIR/migrations.json" ]]; then
    if jq empty "$TODO_DIR/migrations.json" 2>/dev/null; then
      log_info "✓ Valid JSON: migrations.json"
    else
      log_error "✗ Invalid JSON: $TODO_DIR/migrations.json"
      exit 1
    fi
  fi
else
  log_warn "jq not installed - skipping JSON validation"
fi

# Initialize task ID sequence file (v0.52.0)
# Provides O(1) ID generation and prevents ID reuse after archive
log_info "Initializing task ID sequence..."
if [[ -f "$CLEO_HOME/lib/sequence.sh" ]]; then
  source "$CLEO_HOME/lib/sequence.sh"
  if init_sequence; then
    log_info "✓ Sequence file initialized"
  else
    log_warn "Failed to initialize sequence file (ID generation will use legacy scanning)"
  fi
elif [[ -f "$SCRIPT_DIR/../lib/sequence.sh" ]]; then
  source "$SCRIPT_DIR/../lib/sequence.sh"
  if init_sequence; then
    log_info "✓ Sequence file initialized"
  else
    log_warn "Failed to initialize sequence file (ID generation will use legacy scanning)"
  fi
else
  log_warn "sequence.sh not found (ID generation will use legacy scanning)"
fi

# ==============================================================================
# AGENT DOCUMENTATION INJECTION (GLOBAL + PROJECT)
# ==============================================================================
# Inject CLEO task management instructions to agent documentation files
# - GLOBAL: ~/.claude/CLAUDE.md, ~/.gemini/GEMINI.md (via templates/CLEO-INJECTION.md)
# - PROJECT: CLAUDE.md, AGENTS.md, GEMINI.md (via templates/AGENT-INJECTION.md)

if [[ -f "$CLEO_HOME/lib/agent-registry.sh" ]]; then
  source "$CLEO_HOME/lib/agent-registry.sh"

  # Initialize counters
  global_updated=0
  global_skipped=0
  global_failed=0
  project_updated=0
  project_skipped=0
  project_failed=0

  # Load agent registry
  if ar_load_registry; then
    log_info "Processing agent injections via registry..."

    # Get ALL agents from registry - we need to always create CLAUDE.md for Claude Code
    # regardless of whether ~/.claude exists (CLEO is specifically for Claude Code users)
    all_agents=$(ar_list_agents)

    # Reset IFS to default for proper word splitting (backup.sh sets IFS=$'\n\t')
    _SAVED_IFS="$IFS"
    IFS=$' \t\n'

    for agent_id in $all_agents; do
      # Determine if agent is installed (has global directory)
      agent_is_installed=false
      ar_is_installed "$agent_id" && agent_is_installed=true

      # Skip non-Claude agents if not installed
      # Claude Code is ALWAYS processed since CLEO is specifically for Claude Code users
      if [[ "$agent_id" != "claude-code" ]] && [[ "$agent_is_installed" == "false" ]]; then
        continue
      fi

      # ==============================================================================
      # GLOBAL INJECTION (templates/CLEO-INJECTION.md → ~/.claude/CLAUDE.md)
      # ==============================================================================
      global_dir=$(ar_get_global_dir "$agent_id")
      instruction_file=$(ar_get_instruction_file "$agent_id")
      global_target="${global_dir}/${instruction_file}"

      # Ensure global directory exists
      mkdir -p "$global_dir" 2>/dev/null || true

      # Global injection content (@ reference to CLEO-INJECTION.md)
      global_reference="@~/.cleo/templates/CLEO-INJECTION.md"
      global_block="<!-- CLEO:START -->
# Task Management
${global_reference}
<!-- CLEO:END -->"

      # Check if global injection needed
      if [[ -f "$global_target" ]]; then
        # File exists - check if block current
        if grep -q "<!-- CLEO:START -->" "$global_target" 2>/dev/null; then
          current_block=$(sed -n '/<!-- CLEO:START -->/,/<!-- CLEO:END -->/p' "$global_target" 2>/dev/null || true)
          if [[ "$current_block" == "$global_block" ]]; then
            ((global_skipped++)) || true
          else
            # Update block
            temp_file=$(mktemp)
            awk '/<!-- CLEO:START/,/<!-- CLEO:END -->/ { next } { print }' "$global_target" > "$temp_file"
            echo "$global_block" | cat - "$temp_file" > "$global_target"
            rm -f "$temp_file"
            ((global_updated++)) || true
          fi
        else
          # Add block to existing file
          echo "$global_block" | cat - "$global_target" > "${global_target}.tmp"
          mv "${global_target}.tmp" "$global_target"
          ((global_updated++)) || true
        fi
      else
        # Create new file with block
        echo "$global_block" > "$global_target"
        ((global_updated++)) || true
      fi

      # ==============================================================================
      # PROJECT INJECTION (templates/AGENT-INJECTION.md → project CLAUDE.md, etc.)
      # ==============================================================================
      project_target=$(ar_get_project_instruction_path "$agent_id" ".")

      # Project injection content (@ reference to AGENT-INJECTION.md)
      project_reference="@.cleo/templates/AGENT-INJECTION.md"
      project_block="<!-- CLEO:START -->
${project_reference}
<!-- CLEO:END -->"

      # Check if project injection needed
      if [[ -f "$project_target" ]]; then
        # File exists - check if block current
        if grep -q "<!-- CLEO:START -->" "$project_target" 2>/dev/null; then
          current_block=$(sed -n '/<!-- CLEO:START -->/,/<!-- CLEO:END -->/p' "$project_target" 2>/dev/null || true)
          if [[ "$current_block" == "$project_block" ]]; then
            ((project_skipped++)) || true
          else
            # Update block
            temp_file=$(mktemp)
            awk '/<!-- CLEO:START/,/<!-- CLEO:END -->/ { next } { print }' "$project_target" > "$temp_file"
            echo "$project_block" | cat - "$temp_file" > "$project_target"
            rm -f "$temp_file"
            ((project_updated++)) || true
          fi
        else
          # Add block to existing file
          echo "$project_block" | cat - "$project_target" > "${project_target}.tmp"
          mv "${project_target}.tmp" "$project_target"
          ((project_updated++)) || true
        fi
      else
        # Create new file with block
        echo "$project_block" > "$project_target"
        ((project_updated++)) || true
      fi
    done

    # Restore IFS
    IFS="$_SAVED_IFS"

    # Report results
    if [[ "$global_updated" -gt 0 ]]; then
      log_info "Global: Updated $global_updated agent file(s)"
    fi
    if [[ "$global_skipped" -gt 0 ]]; then
      log_info "Global: Skipped $global_skipped current file(s)"
    fi
    if [[ "$project_updated" -gt 0 ]]; then
      log_info "Project: Updated $project_updated agent file(s)"
    fi
    if [[ "$project_skipped" -gt 0 ]]; then
      log_info "Project: Skipped $project_skipped current file(s)"
    fi

    total_failed=$((global_failed + project_failed))
    if [[ "$total_failed" -gt 0 ]]; then
      log_warn "Failed to update $total_failed file(s) - check permissions"
    fi
  else
    log_warn "Failed to load agent registry - agent docs not updated"
  fi
else
  log_warn "lib/agent-registry.sh not found - agent docs not updated"
fi

# ==============================================================================
# AGENT INSTALLATION (via hybrid symlink/copy model)
# ==============================================================================
# Install agent definitions to ~/.claude/agents/
# Default: symlinks for auto-propagating updates
# Option: --copy-agents for regular file installation
if declare -f install_agents &>/dev/null; then
  log_info "Installing agent definitions..."

  # Determine installation mode
  agent_mode="symlink"
  [[ "$COPY_AGENTS" == true ]] && agent_mode="copy"

  # Install agents
  if install_agents "$agent_mode" "log_info"; then
    if [[ "$agent_mode" == "symlink" ]]; then
      log_info "Installed agents via symlinks (auto-updating)"
    else
      log_info "Installed agents as files"
    fi
  else
    log_warn "Agent installation failed (agents may not be available)"
  fi
else
  log_warn "lib/agents-install.sh not found - agents not installed"
fi

# Register project in global registry using HYBRID MODEL
# Creates: 1) Minimal entry in global registry, 2) Detailed per-project file
register_project() {
    # Source required libraries
    [[ -f "$CLEO_HOME/lib/project-registry.sh" ]] && source "$CLEO_HOME/lib/project-registry.sh"
    [[ -f "$CLEO_HOME/lib/migrate.sh" ]] && source "$CLEO_HOME/lib/migrate.sh"

    local project_hash project_path project_name registry timestamp
    local todo_version config_version archive_version log_version

    project_path="$PWD"
    project_name="$(basename "$project_path")"
    project_hash=$(generate_project_hash "$project_path")
    registry="$(get_cleo_home)/projects-registry.json"
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Initialize registry if missing
    if [[ ! -f "$registry" ]]; then
        create_empty_registry "$registry" || return 1
    fi

    # Get schema versions from schema files (single source of truth)
    todo_version=$(get_schema_version_from_file "todo" 2>/dev/null || echo "unknown")
    config_version=$(get_schema_version_from_file "config" 2>/dev/null || echo "unknown")
    archive_version=$(get_schema_version_from_file "archive" 2>/dev/null || echo "unknown")
    log_version=$(get_schema_version_from_file "log" 2>/dev/null || echo "unknown")

    # Extract feature settings from config.json (sync to project-info.json)
    local config_file="${project_path}/.cleo/config.json"
    local feature_multi_session=false
    local feature_verification=false
    local feature_context_alerts=false

    if [[ -f "$config_file" ]]; then
        feature_multi_session=$(jq -r '.multiSession.enabled // false' "$config_file" 2>/dev/null)
        feature_verification=$(jq -r '.verification.enabled // false' "$config_file" 2>/dev/null)
        feature_context_alerts=$(jq -r '.contextAlerts.enabled // false' "$config_file" 2>/dev/null)
        # Normalize "null" to "false"
        [[ "$feature_multi_session" == "null" ]] && feature_multi_session=false
        [[ "$feature_verification" == "null" ]] && feature_verification=false
        [[ "$feature_context_alerts" == "null" ]] && feature_context_alerts=false
    fi

    # Get injection status for all agent files
    local injection_status
    injection_status=$(injection_check_all 2>/dev/null || echo "[]")

    # Build detailed injection object from status array
    local injection_obj
    injection_obj=$(echo "$injection_status" | jq --arg ts "$timestamp" '
        reduce .[] as $item ({};
            .[$item.target] = {
                status: $item.status,
                lastUpdated: (if $item.status == "current" then $ts else null end)
            }
        )
    ')

    # ============================================================================
    # 1. Create per-project info file (DETAILED)
    # ============================================================================
    local project_info_file="${project_path}/.cleo/project-info.json"
    local temp_info
    temp_info=$(mktemp)
    trap 'rm -f "${temp_info:-}"' RETURN

    jq -nc \
        --arg schema_version "1.0.0" \
        --arg hash "$project_hash" \
        --arg name "$project_name" \
        --arg registered_at "$timestamp" \
        --arg last_updated "$timestamp" \
        --arg cleo_version "$VERSION" \
        --arg todo_v "$todo_version" \
        --arg config_v "$config_version" \
        --arg archive_v "$archive_version" \
        --arg log_v "$log_version" \
        --argjson injection "$injection_obj" \
        --argjson feat_multi "$feature_multi_session" \
        --argjson feat_verif "$feature_verification" \
        --argjson feat_ctx "$feature_context_alerts" \
        '{
            "$schema": "./schemas/project-info.schema.json",
            "schemaVersion": $schema_version,
            "projectHash": $hash,
            "name": $name,
            "registeredAt": $registered_at,
            "lastUpdated": $last_updated,
            "cleoVersion": $cleo_version,
            "schemas": {
                "todo": { "version": $todo_v, "lastMigrated": null },
                "config": { "version": $config_v, "lastMigrated": null },
                "archive": { "version": $archive_v, "lastMigrated": null },
                "log": { "version": $log_v, "lastMigrated": null }
            },
            "injection": $injection,
            "health": {
                "status": "healthy",
                "lastCheck": $last_updated,
                "issues": [],
                "history": []
            },
            "features": {
                "multiSession": $feat_multi,
                "verification": $feat_verif,
                "contextAlerts": $feat_ctx
            }
        }' > "$temp_info"

    if ! save_json "$project_info_file" < "$temp_info"; then
        log_error "Failed to create per-project info file"
        return 1
    fi

    # ============================================================================
    # 2. Register in global registry (MINIMAL)
    # ============================================================================
    local temp_registry
    temp_registry=$(mktemp)
    trap 'rm -f "${temp_registry:-}" "${temp_info:-}"' RETURN

    jq --arg hash "$project_hash" \
       --arg path "$project_path" \
       --arg name "$project_name" \
       --arg timestamp "$timestamp" \
       '.projects[$hash] = {
           hash: $hash,
           path: $path,
           name: $name,
           registeredAt: $timestamp,
           lastSeen: $timestamp,
           healthStatus: "healthy",
           healthLastCheck: $timestamp
       } | .lastUpdated = $timestamp' "$registry" > "$temp_registry"

    if ! save_json "$registry" < "$temp_registry"; then
        log_error "Failed to register project in global registry"
        return 1
    fi

    return 0
}

# Call registration after successful initialization
if register_project; then
    [[ "$QUIET" == "false" ]] && log_info "Registered project in global registry"
else
    log_warn "Project registration failed (non-fatal)"
fi

# Check/setup Claude Code statusline integration for context monitoring
if [[ -f "$LIB_DIR/statusline-setup.sh" ]] || [[ -f "$CLEO_HOME/lib/statusline-setup.sh" ]]; then
    if [[ -f "$LIB_DIR/statusline-setup.sh" ]]; then
        source "$LIB_DIR/statusline-setup.sh"
    else
        source "$CLEO_HOME/lib/statusline-setup.sh"
    fi

    echo ""
    log_info "Checking Claude Code statusline integration..."
    install_statusline_integration "install" "true"
fi

# Build list of created files
CREATED_FILES=(
  "todo.json"
  "todo-archive.json"
  "config.json"
  "todo-log.json"
)
# Only include sessions.json if it was actually created
[[ -f "$TODO_DIR/sessions.json" ]] && CREATED_FILES+=("sessions.json")
# Only include migrations.json if it was actually created
[[ -f "$TODO_DIR/migrations.json" ]] && CREATED_FILES+=("migrations.json")

# Check if templates were created
TEMPLATES_CREATED=false
[[ -f "$TODO_DIR/templates/AGENT-INJECTION.md" ]] && TEMPLATES_CREATED=true

if [[ "$FORMAT" == "json" ]]; then
  # JSON output
  jq -nc \
    --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    --arg projectName "$PROJECT_NAME" \
    --arg directory "$TODO_DIR" \
    --arg version "$VERSION" \
    --argjson files "$(printf '%s\n' "${CREATED_FILES[@]}" | jq -R . | jq -s .)" \
    --argjson templates "$TEMPLATES_CREATED" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "command": "init",
        "timestamp": $timestamp,
        "format": "json",
        "version": $version
      },
      "success": true,
      "initialized": {
        "projectName": $projectName,
        "directory": $directory,
        "version": $version,
        "files": $files,
        "schemas": true,
        "templates": $templates,
        "backups": true
      }
    }'
else
  # Text output
  echo ""
  log_success "CLEO initialized successfully!"
  echo ""
  echo "Files created in .cleo/:"
  echo "  - .cleo/todo.json         (active tasks)"
  echo "  - .cleo/todo-archive.json (completed tasks)"
  echo "  - .cleo/config.json       (settings)"
  echo "  - .cleo/todo-log.json     (change history)"
  echo "  - .cleo/sessions.json     (multi-session management)"
  echo "  - .cleo/migrations.json   (migration audit trail)"
  echo "  - .cleo/schemas/          (JSON schemas for validation)"
  echo "  - .cleo/templates/        (injection templates for @-references)"
  echo "  - .cleo/backups/          (automatic backups)"
  echo "    ├── snapshot/             (point-in-time snapshots)"
  echo "    ├── safety/               (pre-operation backups)"
  echo "    ├── incremental/          (file version history)"
  echo "    ├── archive/              (long-term archives)"
  echo "    └── migration/            (schema migration backups)"
  echo ""
  echo "Add to .gitignore (recommended):"
  echo "  .cleo/*.json"
  echo "  .cleo/backups/"
  echo ""
  echo "Next steps:"
  echo "  1. cleo add \"Your first task\""
  echo "  2. cleo focus set <task-id>"
  echo "  3. cleo session start"
fi
