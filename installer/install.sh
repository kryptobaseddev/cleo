#!/usr/bin/env bash
# CLEO Installer - Entry Point
# Minimal orchestration script that sources modules and runs state machine
#
# Version: 1.0.0
# Task: T1860
# Based on: claudedocs/research-outputs/2026-01-20_modular-installer-architecture.md
#
# Usage: ./install.sh [OPTIONS]
#
# Options:
#   --help, -h              Show help message
#   --version, -v           Show installer version
#   --cleo-version VER      Install specific CLEO version (e.g., v0.55.0)
#   --list-versions         List available CLEO versions
#   --force, -f             Force reinstall (skip version check)
#   --dev                   Force development mode (symlinks to repo)
#   --no-symlinks           In dev mode, copy files instead of symlinking
#   --check-deps            Check dependencies only
#   --skip-profile          Skip shell profile modification
#   --skip-skills           Skip skills installation
#   --recover               Resume interrupted installation
#   --rollback              Rollback to previous version
#   --status                Show installation status
#   --refresh               Refresh dev mode symlinks
#   --upgrade               Upgrade to latest version
#   --upgrade=VER           Upgrade to specific version
#   --version-info          Show version information
#   --check-upgrade         Check if upgrade available (exit 0=available, 1=current)
#   --dry-run               Show what would be done
#   --verbose, -d           Enable debug output

set -euo pipefail

# ============================================
# EARLY BASH VERSION CHECK
# ============================================
# Try to find and use Bash 4+ on macOS if current bash is too old
if [[ "${BASH_VERSINFO[0]:-0}" -lt 4 ]]; then
    # Check if we haven't already tried to re-exec (prevent infinite loop)
    if [[ -z "${_CLEO_REEXEC:-}" ]]; then
        # Look for Bash 4+ in common locations (Homebrew paths)
        BASH4_PATHS=(
            "/opt/homebrew/bin/bash"  # macOS Apple Silicon
            "/usr/local/bin/bash"     # macOS Intel / Linux Homebrew
            "/home/linuxbrew/.linuxbrew/bin/bash"  # Linux Homebrew
        )

        for bash_path in "${BASH4_PATHS[@]}"; do
            if [[ -x "$bash_path" ]]; then
                # Check version of this bash
                bash_ver=$("$bash_path" -c 'echo ${BASH_VERSINFO[0]}' 2>/dev/null || echo 0)
                if [[ "$bash_ver" -ge 4 ]]; then
                    echo "Found Bash $bash_ver at $bash_path, re-executing installer..." >&2
                    export _CLEO_REEXEC=1
                    exec "$bash_path" "$0" "$@"
                fi
            fi
        done

        # No Bash 4+ found, warn and continue
        echo "WARNING: CLEO requires Bash 4.0+ to run commands." >&2
        echo "Your version: ${BASH_VERSION:-unknown}" >&2
        echo "" >&2
        echo "Installation will proceed, but you'll need Bash 4+ to use CLEO." >&2
        echo "On macOS: brew install bash" >&2
        echo "" >&2
    fi
fi

# ============================================
# PATHS
# ============================================
INSTALLER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER_LIB_DIR="$INSTALLER_DIR/lib"

# Export for modules
export INSTALLER_DIR
export INSTALLER_LIB_DIR

# ============================================
# SOURCE MODULES
# ============================================
source "$INSTALLER_LIB_DIR/core.sh"
source "$INSTALLER_LIB_DIR/deps.sh"
source "$INSTALLER_LIB_DIR/validate.sh"
source "$INSTALLER_LIB_DIR/source.sh"
source "$INSTALLER_LIB_DIR/link.sh"
source "$INSTALLER_LIB_DIR/profile.sh"
source "$INSTALLER_LIB_DIR/recover.sh"

# Source agents-install.sh from repo lib/ (not installer/lib/)
REPO_LIB_DIR="$(dirname "$INSTALLER_DIR")/lib"
if [[ -f "$REPO_LIB_DIR/skills/agents-install.sh" ]]; then
    source "$REPO_LIB_DIR/skills/agents-install.sh"
elif [[ -f "$REPO_LIB_DIR/agents-install.sh" ]]; then
    # Legacy flat path fallback
    source "$REPO_LIB_DIR/agents-install.sh"
else
    # Fallback: try relative to install.sh location
    FALLBACK_LIB="$INSTALLER_DIR/../lib/skills/agents-install.sh"
    [[ -f "$FALLBACK_LIB" ]] && source "$FALLBACK_LIB"
fi

# ============================================
# CONSTANTS
# ============================================
readonly INSTALLER_SCRIPT_VERSION="1.0.0"

# ============================================
# ARGUMENT PARSING
# ============================================
OPT_FORCE=false
OPT_CHECK_DEPS_ONLY=false
OPT_SKIP_PROFILE=false
OPT_SKIP_SKILLS=false
OPT_SKIP_ALIASES=false
OPT_RECOVER=false
OPT_ROLLBACK=false
OPT_DRY_RUN=false
OPT_VERBOSE=false
OPT_SHOW_HELP=false
OPT_SHOW_VERSION=false
OPT_DEV_MODE=false
OPT_RELEASE_MODE=false
OPT_NO_SYMLINKS=false
OPT_SHOW_STATUS=false
OPT_REFRESH=false
OPT_CLEO_VERSION=""
OPT_LIST_VERSIONS=false
OPT_UPGRADE=false
OPT_UPGRADE_VERSION=""
OPT_VERSION_INFO=false
OPT_CHECK_UPGRADE=false
OPT_WITH_PLUGIN=false
OPT_COPY_AGENTS=false

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --help|-h)
                OPT_SHOW_HELP=true
                ;;
            --version|-v)
                OPT_SHOW_VERSION=true
                ;;
            --cleo-version)
                shift
                if [[ $# -eq 0 ]]; then
                    installer_log_error "--cleo-version requires a version argument"
                    exit 1
                fi
                OPT_CLEO_VERSION="$1"
                ;;
            --list-versions)
                OPT_LIST_VERSIONS=true
                ;;
            --force|-f)
                OPT_FORCE=true
                ;;
            --dev)
                OPT_DEV_MODE=true
                export INSTALLER_DEV_MODE=1
                ;;
            --release)
                OPT_RELEASE_MODE=true
                export INSTALLER_MODE=release
                ;;
            --no-symlinks)
                OPT_NO_SYMLINKS=true
                ;;
            --check-deps)
                OPT_CHECK_DEPS_ONLY=true
                ;;
            --skip-profile)
                OPT_SKIP_PROFILE=true
                ;;
            --skip-skills)
                OPT_SKIP_SKILLS=true
                ;;
            --skip-aliases)
                OPT_SKIP_ALIASES=true
                ;;
            --recover)
                OPT_RECOVER=true
                ;;
            --rollback)
                OPT_ROLLBACK=true
                ;;
            --status)
                OPT_SHOW_STATUS=true
                ;;
            --refresh)
                OPT_REFRESH=true
                ;;
            --upgrade)
                OPT_UPGRADE=true
                OPT_UPGRADE_VERSION="latest"
                ;;
            --upgrade=*)
                OPT_UPGRADE=true
                OPT_UPGRADE_VERSION="${1#*=}"
                ;;
            --version-info)
                OPT_VERSION_INFO=true
                ;;
            --check-upgrade)
                OPT_CHECK_UPGRADE=true
                ;;
            --dry-run)
                OPT_DRY_RUN=true
                ;;
            --verbose|-d)
                OPT_VERBOSE=true
                export INSTALLER_DEBUG=1
                ;;
            --with-plugin)
                OPT_WITH_PLUGIN=true
                ;;
            --copy-agents)
                OPT_COPY_AGENTS=true
                ;;
            *)
                installer_log_error "Unknown option: $1"
                show_usage
                exit 1
                ;;
        esac
        shift
    done

    # Validate conflicting options
    if [[ "$OPT_DEV_MODE" == "true" && "$OPT_RELEASE_MODE" == "true" ]]; then
        echo "ERROR: Cannot specify both --dev and --release" >&2
        exit 1
    fi
}

show_usage() {
    cat <<EOF
CLEO Installer v${INSTALLER_SCRIPT_VERSION}

Usage: $(basename "$0") [OPTIONS]

Options:
  --help, -h              Show this help message
  --version, -v           Show installer version
  --cleo-version VER      Install specific CLEO version (e.g., v0.55.0)
  --list-versions         List available CLEO versions from GitHub
  --force, -f             Force reinstall (skip version check)
  --dev                   Force development mode (symlinks to repo)
  --release               Force release mode (download and copy files)
  --no-symlinks           In dev mode, copy files instead of symlinking
  --check-deps            Check dependencies only, don't install
  --skip-profile          Skip shell profile modification
  --skip-skills           Skip skills installation
  --skip-aliases          Skip Claude CLI alias installation
  --with-plugin           Install Claude Code plugin symlink (optional)
  --copy-agents           Copy agent files instead of symlinking (default: symlink)
  --recover               Resume interrupted installation
  --rollback              Rollback to previous version
  --status                Show current installation status
  --refresh               Refresh dev mode symlinks (if repo moved)
  --upgrade               Upgrade to latest version
  --upgrade=VER           Upgrade to specific version (e.g., --upgrade=v0.56.0)
  --version-info          Show detailed version information
  --check-upgrade         Check if upgrade available (exit 0=available, 1=current)
  --dry-run               Show what would be done (not implemented)
  --verbose, -d           Enable debug output

Environment Variables:
  CLEO_HOME               Installation directory (default: ~/.cleo)
  CLEO_BIN_DIR            Bin directory for symlinks (default: ~/.local/bin)
  CLEO_REPO               GitHub repository (default: kryptobaseddev/cleo)
  CLEO_DOWNLOAD_RETRIES   Number of download retries (default: 3)
  CLEO_DOWNLOAD_TIMEOUT   Download timeout in seconds (default: 60)
  INSTALLER_DEBUG         Enable debug output (same as --verbose)
  INSTALLER_MODE          Force specific mode: "dev" or "release"
  INSTALLER_DEV_MODE      Set to 1 to force dev mode (same as --dev)

Examples:
  ./install.sh                     # Standard installation (auto-detects mode)
  ./install.sh --cleo-version v0.55.0  # Install specific version
  ./install.sh --list-versions     # List available versions
  ./install.sh --dev               # Force dev mode with symlinks
  ./install.sh --release           # Force release mode (download from GitHub)
  ./install.sh --dev --no-symlinks # Dev mode but copy files
  ./install.sh --check-deps        # Check dependencies only
  ./install.sh --force             # Force reinstall
  ./install.sh --recover           # Resume interrupted installation
  ./install.sh --rollback          # Restore previous version
  ./install.sh --status            # Show installation status
  ./install.sh --refresh           # Refresh dev mode symlinks
  ./install.sh --upgrade           # Upgrade to latest version
  ./install.sh --upgrade=v0.56.0   # Upgrade to specific version
  ./install.sh --version-info      # Show detailed version information
  ./install.sh --check-upgrade     # Check if upgrade available (for scripting)
EOF
}

show_version() {
    echo "CLEO Installer v${INSTALLER_SCRIPT_VERSION}"
    echo "Core module v${INSTALLER_VERSION:-unknown}"
}

# ============================================
# STATE HANDLERS
# ============================================
# These functions are called by the state machine for each state

do_state_init() {
    installer_log_debug "Initializing installation"
    return 0
}

do_state_prepare() {
    installer_log_step "Preparing installation..."

    # Create temp directory for staging
    installer_create_temp_dir || return 1

    return 0
}

do_state_validate() {
    installer_log_step "Validating prerequisites..."

    # Check dependencies - try auto-install if missing
    if ! installer_deps_check_required; then
        installer_log_warn "Missing required dependencies"

        # Attempt auto-install
        if installer_deps_auto_install; then
            installer_log_success "Dependencies installed successfully"
        else
            installer_log_error "Could not install required dependencies"
            installer_deps_install_instructions
            return $EXIT_VALIDATION_FAILED
        fi
    fi

    # Check disk space
    installer_validate_disk_space "$INSTALL_DIR" || return 1

    # Check write permissions
    installer_validate_writable "$INSTALL_DIR" || return $EXIT_PERMISSION_DENIED
    installer_validate_writable "$(dirname "$HOME/.local/bin")" || return $EXIT_PERMISSION_DENIED

    return 0
}

do_state_backup() {
    installer_log_step "Creating backup..."

    # Create backup of existing installation
    installer_atomic_backup "$INSTALL_DIR" || return $EXIT_BACKUP_FAILED

    return 0
}

do_state_install() {
    installer_log_step "Installing files..."

    local mode
    mode=$(installer_source_detect_mode)

    # CRITICAL: Preserve existing data files before any destructive operation
    local data_backup_dir=""
    data_backup_dir=$(installer_source_preserve_data_files "$INSTALL_DIR")

    # Dev mode with symlinks: install directly to INSTALL_DIR (no staging)
    if [[ "$mode" == "dev" && "$OPT_NO_SYMLINKS" != "true" ]]; then
        installer_log_info "Installing in dev mode with symlinks..."

        # Ensure install directory exists
        mkdir -p "$INSTALL_DIR"

        # Fetch with symlinks directly to install dir
        installer_source_fetch_local "$INSTALL_DIR" "true" || return $EXIT_STAGING_FAILED

        # Restore preserved data files
        [[ -n "$data_backup_dir" ]] && installer_source_restore_data_files "$INSTALL_DIR" "$data_backup_dir"

        installer_log_info "Dev mode installation complete (symlinks)"
        return 0
    fi

    # Standard installation: stage to temp, then swap
    local temp_dir
    temp_dir=$(installer_get_temp_dir)

    # Fetch source files (copy mode for dev, or remote for release)
    if [[ "$mode" == "dev" ]]; then
        # Dev mode with --no-symlinks: copy files
        installer_source_fetch_local "$temp_dir" "false" || return $EXIT_STAGING_FAILED
    else
        # Release mode: fetch from remote (or fallback to local)
        installer_source_fetch "latest" "$temp_dir" || return $EXIT_STAGING_FAILED
    fi

    # Verify staging
    installer_source_verify_staging "$temp_dir" || return $EXIT_VALIDATION_FAILED

    # Atomic swap to installation directory
    if [[ -d "$INSTALL_DIR" ]]; then
        installer_atomic_swap "$temp_dir" "$INSTALL_DIR" || return $EXIT_INSTALL_FAILED
    else
        mv "$temp_dir" "$INSTALL_DIR" || return $EXIT_INSTALL_FAILED
    fi

    # Restore preserved data files after swap
    [[ -n "$data_backup_dir" ]] && installer_source_restore_data_files "$INSTALL_DIR" "$data_backup_dir"

    return 0
}

do_state_link() {
    installer_log_step "Creating symlinks..."

    # Setup CLI symlinks
    installer_link_setup_bin "$INSTALL_DIR" || return $EXIT_INSTALL_FAILED

    # Setup skills symlinks (unless skipped)
    if [[ "$OPT_SKIP_SKILLS" != "true" ]]; then
        installer_link_setup_skills "$INSTALL_DIR/skills" || true  # Non-critical
    fi

    # Setup Claude Code plugin symlink (opt-in via --with-plugin)
    if [[ "$OPT_WITH_PLUGIN" == "true" ]]; then
        installer_link_setup_plugin "$INSTALL_DIR" || true  # Non-critical
    fi

    # Setup global agent configurations (claude, gemini, codex, kimi)
    # This ensures LLM agents know about CLEO without requiring separate setup
    installer_link_setup_all_agents || true  # Non-critical

    # Install agents to ~/.claude/agents/ (hybrid: symlink or copy)
    if type -t install_agents >/dev/null 2>&1; then
        local agent_mode="symlink"
        [[ "$OPT_COPY_AGENTS" == "true" ]] && agent_mode="copy"

        # Set CLEO_REPO_ROOT for agents-install.sh
        export CLEO_REPO_ROOT="$INSTALL_DIR"

        install_agents "$agent_mode" "installer_log_info" || \
            installer_log_warn "Failed to install agents"
    else
        installer_log_warn "install_agents function not available"
    fi

    # Setup global CLEO agents directory (~/.cleo/agents/)
    installer_link_setup_global_agents "$INSTALL_DIR" || true  # Non-critical

    # Run post-install setup (plugins dir, checksums, template versions)
    installer_link_post_install "$INSTALL_DIR" || true  # Non-critical

    return 0
}

do_state_profile() {
    installer_log_step "Configuring shell profile..."

    if [[ "$OPT_SKIP_PROFILE" == "true" ]]; then
        installer_log_info "Skipping profile modification (--skip-profile)"
        return 0
    fi

    # Update shell profile
    installer_profile_update || return $EXIT_PROFILE_FAILED

    # Initialize global config
    installer_profile_init_global_config "$INSTALL_DIR" || true  # Non-critical

    # Migrate legacy config if present
    installer_profile_migrate_legacy || true  # Non-critical

    # Setup Claude CLI aliases (non-blocking, interactive if TTY)
    if [[ "$OPT_SKIP_ALIASES" != "true" ]]; then
        if [[ -t 0 ]]; then
            installer_profile_setup_aliases --interactive || true  # Non-critical
        else
            installer_profile_setup_aliases || true  # Non-critical, non-interactive
        fi
    else
        installer_log_info "Skipping Claude alias setup (--skip-aliases)"
        installer_log_info "Run later with: cleo setup-claude-aliases"
    fi

    return 0
}

do_state_verify() {
    installer_log_step "Verifying installation..."

    # Verify file structure
    installer_validate_structure "$INSTALL_DIR" || return $EXIT_VALIDATION_FAILED

    # Verify symlinks
    installer_link_verify_all "$INSTALL_DIR" || {
        installer_log_warn "Symlink verification found issues"
        # Non-critical - installation may still work
    }

    return 0
}

do_state_cleanup() {
    installer_log_step "Cleaning up..."

    # Rotate old backups
    installer_recover_rotate_backups 5

    # Clean temp files
    installer_recover_cleanup_temp

    return 0
}

do_state_complete() {
    installer_log_info ""
    installer_log_info "========================================"
    installer_log_info "  CLEO installation complete!"
    installer_log_info "========================================"
    installer_log_info ""
    installer_log_info "Installed to: $INSTALL_DIR"
    installer_log_info ""
    installer_log_info "To start using CLEO:"
    installer_log_info "  1. Restart your shell or run: source $(installer_profile_detect_config_file)"
    installer_log_info "  2. Run: cleo --help"
    installer_log_info ""
    return 0
}

# ============================================
# MAIN
# ============================================
main() {
    parse_args "$@"

    # Handle help/version first
    if [[ "$OPT_SHOW_HELP" == "true" ]]; then
        show_usage
        exit 0
    fi

    if [[ "$OPT_SHOW_VERSION" == "true" ]]; then
        show_version
        exit 0
    fi

    # Check deps only mode
    if [[ "$OPT_CHECK_DEPS_ONLY" == "true" ]]; then
        installer_deps_check_all
        installer_deps_report "text"
        exit $?
    fi

    # List available versions
    if [[ "$OPT_LIST_VERSIONS" == "true" ]]; then
        echo "Fetching available CLEO versions from GitHub..."
        local releases
        releases=$(installer_source_get_releases 10)
        if [[ -z "$releases" ]]; then
            installer_log_error "Could not fetch versions from GitHub"
            exit 1
        fi
        echo ""
        echo "Available versions:"
        echo "$releases" | nl -w2 -s") "
        echo ""
        echo "Use: ./install.sh --cleo-version <version> to install a specific version"
        exit 0
    fi

    # Handle rollback
    if [[ "$OPT_ROLLBACK" == "true" ]]; then
        installer_recover_rollback
        exit $?
    fi

    # Handle status
    if [[ "$OPT_SHOW_STATUS" == "true" ]]; then
        installer_source_dev_status "$INSTALL_DIR"
        exit $?
    fi

    # Handle refresh
    if [[ "$OPT_REFRESH" == "true" ]]; then
        if ! installer_source_is_dev_mode "$INSTALL_DIR"; then
            installer_log_error "Refresh is only available for dev mode installations"
            exit 1
        fi
        installer_source_dev_refresh "" "$INSTALL_DIR"
        exit $?
    fi

    # Handle version info (T1868)
    if [[ "$OPT_VERSION_INFO" == "true" ]]; then
        installer_source_version_info "$INSTALL_DIR"
        exit $?
    fi

    # Handle check-upgrade (T1868)
    if [[ "$OPT_CHECK_UPGRADE" == "true" ]]; then
        installer_source_check_upgrade_available "$INSTALL_DIR"
        exit $?
    fi

    # Handle upgrade (T1868)
    if [[ "$OPT_UPGRADE" == "true" ]]; then
        installer_source_upgrade "$OPT_UPGRADE_VERSION" "$INSTALL_DIR"
        exit $?
    fi

    # Setup signal handlers
    installer_trap_setup

    # Check for interrupted installation (T1862 enhanced recovery)
    if installer_recover_detect; then
        installer_log_warn "Previous installation was interrupted."

        if [[ "$OPT_RECOVER" == "true" ]]; then
            # Explicit --recover flag: attempt intelligent recovery
            installer_log_info "Attempting to recover interrupted installation..."
            installer_recover_interrupted
        elif [[ "$OPT_FORCE" == "true" ]]; then
            # Force flag: cleanup and restart fresh
            installer_log_info "Cleaning up interrupted installation (--force)..."
            installer_recover_manual_cleanup "full"
        else
            # No explicit flag: show options and exit
            local state
            state=$(installer_state_get)
            local recovery_level="${RECOVERY_LEVELS[$state]:-2}"

            if [[ "$recovery_level" -eq 0 ]]; then
                # Auto-recoverable state: cleanup and continue
                installer_log_info "Auto-recovering from safe state: $state"
                installer_recover_cleanup_temp
            else
                # Needs user action
                installer_recover_prompt "interrupted"
                installer_log_info ""
                installer_log_info "Options:"
                installer_log_info "  --recover   Resume from last checkpoint"
                installer_log_info "  --rollback  Restore from backup"
                installer_log_info "  --force     Clean restart (removes staged files)"
                exit $EXIT_INTERRUPTED
            fi
        fi
    fi

    # Acquire lock
    installer_lock_acquire || exit $EXIT_LOCK_HELD

    # Get version to install
    local version
    if [[ -n "$OPT_CLEO_VERSION" ]]; then
        # User specified version
        version="$OPT_CLEO_VERSION"
        installer_log_info "Installing user-specified version: $version"
    else
        # Auto-detect latest version
        version=$(installer_source_get_latest_version)
        version="${version:-development}"
    fi

    # Check if already installed (unless --force)
    if [[ "$OPT_FORCE" != "true" ]]; then
        local installed_version
        installed_version=$(installer_validate_get_installed_version)
        if [[ -n "$installed_version" ]]; then
            local cmp
            cmp=$(installer_validate_compare_versions "$installed_version" "$version")
            if [[ "$cmp" == "0" ]]; then
                installer_log_info "CLEO v${installed_version} is already installed"
                installer_log_info "Use --force to reinstall"
                installer_lock_release
                exit 0
            elif [[ "$cmp" == "1" ]]; then
                installer_log_warn "Installed version ($installed_version) is newer than available ($version)"
                installer_log_warn "Use --force to downgrade"
                installer_lock_release
                exit 0
            fi
        fi
    fi

    # Clear state markers on --force to ensure full reinstall
    if [[ "$OPT_FORCE" == "true" ]]; then
        installer_log_info "Clearing previous installation state (--force)..."
        rm -f "$STATE_DIR/markers/"*.done 2>/dev/null || true
    fi

    # Initialize state machine
    local options_json
    options_json=$(jq -n \
        --argjson force "$OPT_FORCE" \
        --argjson skip_profile "$OPT_SKIP_PROFILE" \
        --argjson skip_skills "$OPT_SKIP_SKILLS" \
        '{force: $force, skip_profile: $skip_profile, skip_skills: $skip_skills}')

    installer_state_init "$version" "$INSTALLER_DIR/.." "$INSTALL_DIR" "$options_json"

    installer_log_info "Starting installation state machine..."

    # Run state machine
    if installer_run_state_machine "do_state"; then
        # Check if any states were actually executed (not all skipped)
        local executed_count=0
        for state in INIT PREPARE VALIDATE BACKUP INSTALL LINK PROFILE VERIFY CLEANUP COMPLETE; do
            local marker_file="$STATE_DIR/markers/${state}.done"
            if [[ -f "$marker_file" ]]; then
                # Check if marker was created during this run (within last 60 seconds)
                local marker_age
                marker_age=$(($(date +%s) - $(stat -c %Y "$marker_file" 2>/dev/null || stat -f %m "$marker_file" 2>/dev/null || echo 0)))
                if [[ $marker_age -lt 60 ]]; then
                    ((executed_count++)) || true
                fi
            fi
        done

        if [[ $executed_count -eq 0 ]]; then
            installer_log_info ""
            installer_log_info "All installation states already complete."
            installer_log_info "CLEO is already installed at: $INSTALL_DIR"
            installer_log_info ""
            installer_log_info "To reinstall, use: ./install.sh --force"
        fi

        installer_lock_release
        exit 0
    else
        installer_log_error "Installation failed"
        installer_lock_release
        exit $EXIT_INSTALL_FAILED
    fi
}

# Run main
main "$@"
