#!/usr/bin/env bash
###CLEO
# name: lib-hierarchy-migrate
# description: Migrate lib/*.sh into semantic subdirectories (Track A of T2748)
# category: migration
# task: T4345
# epic: T4344
###END

# lib-hierarchy-migrate.sh - Reorganize flat lib/ into 7 semantic subdirectories
#
# Usage:
#   ./dev/migrations/lib-hierarchy-migrate.sh --dry-run      # Preview (default)
#   ./dev/migrations/lib-hierarchy-migrate.sh --execute       # Move files with git mv
#   ./dev/migrations/lib-hierarchy-migrate.sh --update-refs   # Fix source paths in all .sh files
#   ./dev/migrations/lib-hierarchy-migrate.sh --verify        # Check for broken references
#
# @task T4345
# @epic T4344

set -euo pipefail

# --- Configuration -----------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIB_DIR="$PROJECT_ROOT/lib"
LOG_FILE="$PROJECT_ROOT/.cleo/migrations/lib-hierarchy-$(date +%Y%m%d_%H%M%S).log"

# Colors (safe for non-tty)
if [[ -t 1 ]]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
    BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; NC=''
fi

# --- File-to-Directory Mapping ------------------------------------------------
# Every lib/*.sh file MUST appear exactly once. Unmapped files cause --dry-run to fail.

declare -A FILE_MAP

# core/ - Foundation: exit codes, errors, output, logging, config, platform, paths
FILE_MAP=(
    # --- core/ ---
    [exit-codes.sh]=core
    [error-json.sh]=core
    [output-format.sh]=core
    [logging.sh]=core
    [config.sh]=core
    [paths.sh]=core
    [platform-compat.sh]=core
    [version.sh]=core
    [json-output.sh]=core
    [jq-helpers.sh]=core
    [sequence.sh]=core

    # --- validation/ ---
    [validation.sh]=validation
    [protocol-validation.sh]=validation
    [protocol-validation-common.sh]=validation
    [compliance-check.sh]=validation
    [manifest-validation.sh]=validation
    [verification.sh]=validation
    [doctor-checks.sh]=validation
    [doctor-project-cache.sh]=validation
    [doctor-utils.sh]=validation
    [gap-check.sh]=validation
    [docs-sync.sh]=validation

    # --- session/ ---
    [sessions.sh]=session
    [session-enforcement.sh]=session
    [session-migration.sh]=session
    [context-alert.sh]=session
    [context-monitor.sh]=session
    [statusline-setup.sh]=session
    [lock-detection.sh]=session
    [hitl-warnings.sh]=session

    # --- tasks/ ---
    [task-mutate.sh]=tasks
    [dependency-check.sh]=tasks
    [hierarchy.sh]=tasks
    [phase-tracking.sh]=tasks
    [analysis.sh]=tasks
    [staleness.sh]=tasks
    [size-weighting.sh]=tasks
    [crossref-extract.sh]=tasks
    [graph-cache.sh]=tasks
    [graph-ops.sh]=tasks
    [graph-rag.sh]=tasks
    [cancel-ops.sh]=tasks
    [archive-cancel.sh]=tasks
    [delete-preview.sh]=tasks
    [deletion-strategy.sh]=tasks
    [todowrite-integration.sh]=tasks
    [lifecycle.sh]=tasks

    # --- skills/ ---
    [skill-discovery.sh]=skills
    [skill-dispatch.sh]=skills
    [skill-validate.sh]=skills
    [skills-install.sh]=skills
    [skills-version.sh]=skills
    [skillsmp.sh]=skills
    [agent-config.sh]=skills
    [agent-registry.sh]=skills
    [agents-install.sh]=skills
    [orchestrator-spawn.sh]=skills
    [orchestrator-startup.sh]=skills
    [orchestrator-validator.sh]=skills
    [subagent-inject.sh]=skills
    [token-inject.sh]=skills
    [contribution-protocol.sh]=skills
    [research-manifest.sh]=skills
    [test-utility.sh]=skills

    # --- data/ ---
    [file-ops.sh]=data
    [atomic-write.sh]=data
    [backup.sh]=data
    [cache.sh]=data
    [migrate.sh]=data
    [nexus-deps.sh]=data
    [nexus-permissions.sh]=data
    [nexus-query.sh]=data
    [nexus-registry.sh]=data
    [git-checkpoint.sh]=data
    [import-logging.sh]=data
    [import-remap.sh]=data
    [import-sort.sh]=data
    [export.sh]=data
    [project-detect.sh]=data
    [project-registry.sh]=data
    [files-detect.sh]=data

    # --- ui/ ---
    [flags.sh]=ui
    [command-registry.sh]=ui
    [claude-aliases.sh]=ui
    [injection.sh]=ui
    [injection-config.sh]=ui
    [injection-registry.sh]=ui
    [changelog.sh]=ui
    [mcp-config.sh]=ui
    [version-check.sh]=ui

    # --- metrics/ ---
    [metrics-aggregation.sh]=metrics
    [metrics-common.sh]=metrics
    [metrics-enums.sh]=metrics
    [otel-integration.sh]=metrics
    [token-estimation.sh]=metrics
    [ab-test.sh]=metrics

    # --- release/ ---
    [release.sh]=release
    [release-config.sh]=release
    [release-artifacts.sh]=release
    [release-ci.sh]=release
    [release-provenance.sh]=release
)

# Target subdirectories (derived from FILE_MAP values, deduplicated)
TARGET_DIRS=(core validation session tasks skills data ui metrics release)

# --- Logging ------------------------------------------------------------------

log() {
    local level="$1"; shift
    local msg="$*"
    local ts
    ts="$(date +%Y-%m-%dT%H:%M:%S%z)"
    # Ensure log directory exists
    mkdir -p "$(dirname "$LOG_FILE")"
    echo "[$ts] [$level] $msg" >> "$LOG_FILE"
    case "$level" in
        INFO)  echo -e "${GREEN}[INFO]${NC}  $msg" ;;
        WARN)  echo -e "${YELLOW}[WARN]${NC}  $msg" ;;
        ERROR) echo -e "${RED}[ERROR]${NC} $msg" ;;
        DRY)   echo -e "${CYAN}[DRY]${NC}   $msg" ;;
        MOVE)  echo -e "${BLUE}[MOVE]${NC}  $msg" ;;
    esac
}

# --- Validation ---------------------------------------------------------------

validate_mapping() {
    local errors=0
    local mapped_count=0
    local unmapped=()

    # Check every lib/*.sh file is mapped
    for f in "$LIB_DIR"/*.sh; do
        [[ -f "$f" ]] || continue
        local basename
        basename="$(basename "$f")"
        if [[ -z "${FILE_MAP[$basename]+_}" ]]; then
            unmapped+=("$basename")
            errors=$((errors + 1))
        else
            mapped_count=$((mapped_count + 1))
        fi
    done

    # Check no mapped files are missing from disk
    local missing=()
    for fname in "${!FILE_MAP[@]}"; do
        if [[ ! -f "$LIB_DIR/$fname" ]]; then
            missing+=("$fname")
            errors=$((errors + 1))
        fi
    done

    echo ""
    log INFO "Mapping validation: $mapped_count files mapped, ${#FILE_MAP[@]} entries in map"

    if [[ ${#unmapped[@]} -gt 0 ]]; then
        log ERROR "Unmapped files (${#unmapped[@]}):"
        for f in "${unmapped[@]}"; do
            log ERROR "  - $f"
        done
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        log WARN "Mapped but missing from disk (${#missing[@]}):"
        for f in "${missing[@]}"; do
            log WARN "  - $f"
        done
    fi

    return $errors
}

# --- Dry Run ------------------------------------------------------------------

do_dry_run() {
    log INFO "=== DRY RUN: lib/ hierarchy migration ==="
    log INFO "Project root: $PROJECT_ROOT"
    echo ""

    # Validate mapping completeness
    if ! validate_mapping; then
        log ERROR "Mapping validation failed. Fix unmapped files before proceeding."
        return 1
    fi

    # Show planned moves by directory
    for dir in "${TARGET_DIRS[@]}"; do
        local count=0
        local files=()
        for fname in $(echo "${!FILE_MAP[@]}" | tr ' ' '\n' | sort); do
            if [[ "${FILE_MAP[$fname]}" == "$dir" ]]; then
                files+=("$fname")
                count=$((count + 1))
            fi
        done
        echo ""
        log DRY "lib/$dir/ ($count files):"
        for f in "${files[@]}"; do
            log DRY "  git mv lib/$f lib/$dir/$f"
        done
    done

    echo ""
    log INFO "Total files to move: ${#FILE_MAP[@]}"
    log INFO "Target directories: ${#TARGET_DIRS[@]} (${TARGET_DIRS[*]})"
    log INFO "Dry run complete. Use --execute to perform migration."
}

# --- Execute ------------------------------------------------------------------

do_execute() {
    log INFO "=== EXECUTING: lib/ hierarchy migration ==="

    # Validate first
    if ! validate_mapping; then
        log ERROR "Mapping validation failed. Aborting."
        return 1
    fi

    # Safety: check we're in a git repo
    if ! git -C "$PROJECT_ROOT" rev-parse --is-inside-work-tree &>/dev/null; then
        log ERROR "Not a git repository. Aborting."
        return 1
    fi

    # Safety: check for uncommitted changes in lib/
    local dirty
    dirty="$(git -C "$PROJECT_ROOT" status --porcelain lib/ 2>/dev/null | head -5)"
    if [[ -n "$dirty" ]]; then
        log WARN "Uncommitted changes in lib/. Proceeding anyway (git mv handles staged files)."
    fi

    # Create directories
    for dir in "${TARGET_DIRS[@]}"; do
        local target="$LIB_DIR/$dir"
        if [[ ! -d "$target" ]]; then
            mkdir -p "$target"
            log INFO "Created directory: lib/$dir/"
        else
            log INFO "Directory exists: lib/$dir/"
        fi
    done

    # Move files
    local moved=0
    local skipped=0
    for fname in $(echo "${!FILE_MAP[@]}" | tr ' ' '\n' | sort); do
        local src="$LIB_DIR/$fname"
        local dest_dir="$LIB_DIR/${FILE_MAP[$fname]}"
        local dest="$dest_dir/$fname"

        if [[ ! -f "$src" ]]; then
            log WARN "Source missing, skipping: lib/$fname"
            skipped=$((skipped + 1))
            continue
        fi

        if [[ -f "$dest" ]]; then
            log WARN "Destination exists, skipping: lib/${FILE_MAP[$fname]}/$fname"
            skipped=$((skipped + 1))
            continue
        fi

        git -C "$PROJECT_ROOT" mv "lib/$fname" "lib/${FILE_MAP[$fname]}/$fname"
        log MOVE "lib/$fname -> lib/${FILE_MAP[$fname]}/$fname"
        moved=$((moved + 1))
    done

    echo ""
    log INFO "Migration complete: $moved moved, $skipped skipped"
    log INFO "Next step: --update-refs to fix source paths"
}

# --- Update References --------------------------------------------------------

do_update_refs() {
    log INFO "=== UPDATING REFERENCES: source paths in .sh files ==="

    local updated_files=0
    local total_replacements=0

    # Scan all .sh files in the project for `source` or `.` references to lib/
    # Also scan .bats test files
    local search_dirs=(
        "$PROJECT_ROOT/scripts"
        "$PROJECT_ROOT/lib"
        "$PROJECT_ROOT/dev"
        "$PROJECT_ROOT/tests"
        "$PROJECT_ROOT/skills"
        "$PROJECT_ROOT/agents"
        "$PROJECT_ROOT/install.sh"
    )

    # Build a list of all shell files to scan
    local shell_files=()
    for search in "${search_dirs[@]}"; do
        if [[ -f "$search" ]]; then
            shell_files+=("$search")
        elif [[ -d "$search" ]]; then
            while IFS= read -r -d '' f; do
                shell_files+=("$f")
            done < <(find "$search" -type f \( -name '*.sh' -o -name '*.bats' \) -print0 2>/dev/null)
        fi
    done

    log INFO "Scanning ${#shell_files[@]} shell files for lib/ references..."

    for shell_file in "${shell_files[@]}"; do
        local file_changed=false
        local replacements_in_file=0

        for fname in "${!FILE_MAP[@]}"; do
            local target_dir="${FILE_MAP[$fname]}"

            # Patterns to replace:
            #   source "...lib/foo.sh"          -> source "...lib/core/foo.sh"
            #   source '...lib/foo.sh'          -> source '...lib/core/foo.sh'
            #   . "...lib/foo.sh"               -> . "...lib/core/foo.sh"
            #   source "$LIB_DIR/foo.sh"        -> source "$LIB_DIR/core/foo.sh"
            #   source "${LIB_DIR}/foo.sh"      -> source "${LIB_DIR}/core/foo.sh"
            #   "lib/foo.sh"                    -> "lib/core/foo.sh"

            # Skip if file doesn't reference this script at all
            if ! grep -q "$fname" "$shell_file" 2>/dev/null; then
                continue
            fi

            # Replace various source patterns using sed
            # Pattern 1: lib/fname -> lib/dir/fname (bare path)
            if grep -q "lib/$fname" "$shell_file" 2>/dev/null; then
                # Avoid double-migration: skip if already has subdirectory
                if ! grep -q "lib/$target_dir/$fname" "$shell_file" 2>/dev/null; then
                    sed -i "s|lib/$fname|lib/$target_dir/$fname|g" "$shell_file"
                    file_changed=true
                    replacements_in_file=$((replacements_in_file + 1))
                fi
            fi

            # Pattern 2: LIB_DIR/fname or LIB_DIR}/fname -> LIB_DIR/dir/fname
            if grep -q "LIB_DIR[}]*/\?$fname" "$shell_file" 2>/dev/null; then
                # $LIB_DIR/fname
                if grep -q "\$LIB_DIR/$fname" "$shell_file" 2>/dev/null && \
                   ! grep -q "\$LIB_DIR/$target_dir/$fname" "$shell_file" 2>/dev/null; then
                    sed -i "s|\\\$LIB_DIR/$fname|\$LIB_DIR/$target_dir/$fname|g" "$shell_file"
                    file_changed=true
                    replacements_in_file=$((replacements_in_file + 1))
                fi
                # ${LIB_DIR}/fname
                if grep -q "\${LIB_DIR}/$fname" "$shell_file" 2>/dev/null && \
                   ! grep -q "\${LIB_DIR}/$target_dir/$fname" "$shell_file" 2>/dev/null; then
                    sed -i "s|\${LIB_DIR}/$fname|\${LIB_DIR}/$target_dir/$fname|g" "$shell_file"
                    file_changed=true
                    replacements_in_file=$((replacements_in_file + 1))
                fi
            fi
        done

        if [[ "$file_changed" == true ]]; then
            updated_files=$((updated_files + 1))
            total_replacements=$((total_replacements + replacements_in_file))
            log INFO "Updated $shell_file ($replacements_in_file replacements)"
        fi
    done

    echo ""
    log INFO "Reference update complete: $updated_files files updated, $total_replacements total replacements"
    log INFO "Next step: --verify to check for broken references"
}

# --- Verify -------------------------------------------------------------------

do_verify() {
    log INFO "=== VERIFYING: checking for broken references ==="

    local errors=0
    local warnings=0

    # 1. Check that all target directories exist and have files
    for dir in "${TARGET_DIRS[@]}"; do
        local target="$LIB_DIR/$dir"
        if [[ ! -d "$target" ]]; then
            log ERROR "Missing directory: lib/$dir/"
            errors=$((errors + 1))
            continue
        fi
        local count
        count=$(find "$target" -maxdepth 1 -name '*.sh' -type f | wc -l)
        if [[ "$count" -eq 0 ]]; then
            log WARN "Empty directory: lib/$dir/ (0 .sh files)"
            warnings=$((warnings + 1))
        else
            log INFO "lib/$dir/: $count files"
        fi
    done

    # 2. Check no .sh files remain in lib/ root (except rcsd/ and subdirs)
    local leftover
    leftover=$(find "$LIB_DIR" -maxdepth 1 -name '*.sh' -type f | wc -l)
    if [[ "$leftover" -gt 0 ]]; then
        log WARN "$leftover .sh files still in lib/ root:"
        find "$LIB_DIR" -maxdepth 1 -name '*.sh' -type f | while read -r f; do
            log WARN "  - $(basename "$f")"
        done
        warnings=$((warnings + leftover))
    fi

    # 3. Scan for broken source references
    local broken=0
    local shell_files=()
    while IFS= read -r -d '' f; do
        shell_files+=("$f")
    done < <(find "$PROJECT_ROOT" -type f \( -name '*.sh' -o -name '*.bats' \) \
        -not -path '*/.git/*' \
        -not -path '*/node_modules/*' \
        -not -path '*/.cleo/backups/*' \
        -print0 2>/dev/null)

    for shell_file in "${shell_files[@]}"; do
        # Extract source/. references to lib/ paths
        while IFS= read -r line; do
            # Extract the path after source/. command
            local ref_path
            ref_path=$(echo "$line" | grep -oP '(?:source|\.)\s+["\x27]?\K[^"\x27\s]+lib/[^"\x27\s]+' 2>/dev/null || true)
            [[ -z "$ref_path" ]] && continue

            # Resolve variables in path for checking
            local resolved="$ref_path"
            # Replace common variables with LIB_DIR path
            resolved="${resolved//\$LIB_DIR/$LIB_DIR}"
            resolved="${resolved//\$\{LIB_DIR\}/$LIB_DIR}"
            resolved="${resolved//\$PROJECT_ROOT/$PROJECT_ROOT}"
            resolved="${resolved//\$\{PROJECT_ROOT\}/$PROJECT_ROOT}"
            resolved="${resolved//\$CLEO_ROOT/$PROJECT_ROOT}"
            resolved="${resolved//\$\{CLEO_ROOT\}/$PROJECT_ROOT}"

            # If still has unresolved variables, skip
            if [[ "$resolved" == *'$'* ]]; then
                continue
            fi

            if [[ ! -f "$resolved" ]]; then
                log ERROR "Broken reference in $(basename "$shell_file"): $ref_path"
                broken=$((broken + 1))
            fi
        done < <(grep -nE '^\s*(source|\.) ' "$shell_file" 2>/dev/null | grep 'lib/' || true)
    done

    echo ""
    if [[ "$broken" -gt 0 ]]; then
        log ERROR "Found $broken broken source references"
        errors=$((errors + broken))
    else
        log INFO "No broken source references found"
    fi

    log INFO "Verification complete: $errors errors, $warnings warnings"
    return $errors
}

# --- Summary ------------------------------------------------------------------

show_summary() {
    echo ""
    echo -e "${GREEN}=== lib/ Hierarchy Migration Summary ===${NC}"
    echo ""
    echo "Target structure:"
    for dir in "${TARGET_DIRS[@]}"; do
        local count=0
        for fname in "${!FILE_MAP[@]}"; do
            [[ "${FILE_MAP[$fname]}" == "$dir" ]] && count=$((count + 1))
        done
        printf "  lib/%-14s %3d files\n" "$dir/" "$count"
    done
    echo "  lib/rcsd/          (unchanged - already hierarchical)"
    echo ""
    echo "Total mapped: ${#FILE_MAP[@]} files across ${#TARGET_DIRS[@]} directories"
    echo ""
    echo "Usage:"
    echo "  $0 --dry-run       Preview moves (default)"
    echo "  $0 --execute       Run git mv for all files"
    echo "  $0 --update-refs   Fix source paths in shell files"
    echo "  $0 --verify        Check for broken references"
}

# --- Main ---------------------------------------------------------------------

main() {
    local mode="${1:---dry-run}"

    case "$mode" in
        --dry-run)
            do_dry_run
            show_summary
            ;;
        --execute)
            do_execute
            ;;
        --update-refs)
            do_update_refs
            ;;
        --verify)
            do_verify
            ;;
        --summary)
            show_summary
            ;;
        --help|-h)
            show_summary
            ;;
        *)
            log ERROR "Unknown mode: $mode"
            show_summary
            return 1
            ;;
    esac
}

main "$@"
