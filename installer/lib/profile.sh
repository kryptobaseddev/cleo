#!/usr/bin/env bash
# CLEO Installer - Shell Configuration
# Detects shell and modifies profile for PATH and aliases
#
# Version: 1.0.0
# Task: T1860
# Based on: claudedocs/research-outputs/2026-01-20_modular-installer-architecture.md
#
# LAYER: 2 (Operations)
# DEPENDENCIES: core.sh
# PROVIDES: installer_profile_detect_shell, installer_profile_backup,
#           installer_profile_update, installer_profile_remove, installer_profile_verify

# ============================================
# GUARD: Prevent double-sourcing
# ============================================
[[ -n "${_INSTALLER_PROFILE_LOADED:-}" ]] && return 0
readonly _INSTALLER_PROFILE_LOADED=1

# ============================================
# DEPENDENCIES
# ============================================
INSTALLER_LIB_DIR="${INSTALLER_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
source "${INSTALLER_LIB_DIR}/core.sh"

# ============================================
# CONSTANTS
# ============================================
readonly PROFILE_BIN_DIR="${CLEO_BIN_DIR:-$HOME/.local/bin}"
readonly PROFILE_BACKUP_SUFFIX=".cleo-backup"

# Markers for identifying CLEO modifications
readonly PROFILE_START_MARKER="# >>> CLEO installer >>>"
readonly PROFILE_END_MARKER="# <<< CLEO installer <<<"

# ============================================
# SHELL DETECTION
# ============================================

# Detect current shell type
# Returns: bash, zsh, fish, sh, unknown
installer_profile_detect_shell() {
    local shell_name

    # Try to get from SHELL environment variable
    if [[ -n "$SHELL" ]]; then
        shell_name=$(basename "$SHELL")
    else
        # Fallback to ps
        shell_name=$(ps -p $$ -o comm= 2>/dev/null | sed 's/^-//')
    fi

    case "$shell_name" in
        bash)   echo "bash" ;;
        zsh)    echo "zsh" ;;
        fish)   echo "fish" ;;
        sh)     echo "sh" ;;
        *)      echo "unknown" ;;
    esac
}

# Detect the appropriate shell configuration file
# Args: [shell_type]
# Returns: Path to shell config file
installer_profile_detect_config_file() {
    local shell_type="${1:-$(installer_profile_detect_shell)}"

    case "$shell_type" in
        bash)
            # Prefer .bashrc for interactive shells
            if [[ -f "$HOME/.bashrc" ]]; then
                echo "$HOME/.bashrc"
            elif [[ -f "$HOME/.bash_profile" ]]; then
                echo "$HOME/.bash_profile"
            else
                echo "$HOME/.bashrc"  # Will be created
            fi
            ;;
        zsh)
            if [[ -f "$HOME/.zshrc" ]]; then
                echo "$HOME/.zshrc"
            else
                echo "$HOME/.zshrc"  # Will be created
            fi
            ;;
        fish)
            local fish_config="$HOME/.config/fish/config.fish"
            echo "$fish_config"
            ;;
        *)
            # Fallback to profile
            if [[ -f "$HOME/.profile" ]]; then
                echo "$HOME/.profile"
            else
                echo "$HOME/.profile"  # Will be created
            fi
            ;;
    esac
}

# Check if running as a login shell
# Returns: 0 if login shell, 1 otherwise
installer_profile_is_login_shell() {
    # Check if $0 starts with - (login shell indicator)
    [[ "$0" == -* ]] && return 0

    # Check shopt (bash-specific)
    if [[ -n "${BASH_VERSION:-}" ]]; then
        shopt -q login_shell 2>/dev/null && return 0
    fi

    return 1
}

# ============================================
# BACKUP OPERATIONS
# ============================================

# Create backup of shell configuration file
# Args: config_file
# Returns: 0 on success, backup path on stdout
installer_profile_backup() {
    local config_file="$1"
    local backup_file="${config_file}${PROFILE_BACKUP_SUFFIX}.$(date +%Y%m%d%H%M%S)"

    if [[ -f "$config_file" ]]; then
        cp "$config_file" "$backup_file" || {
            installer_log_error "Failed to backup: $config_file"
            return 1
        }
        installer_log_debug "Created backup: $backup_file"
        echo "$backup_file"
    else
        installer_log_debug "No existing config to backup: $config_file"
        echo ""
    fi

    return 0
}

# Restore shell config from most recent backup
# Args: config_file
# Returns: 0 on success
installer_profile_restore() {
    local config_file="$1"
    local backup_dir
    backup_dir=$(dirname "$config_file")
    local config_name
    config_name=$(basename "$config_file")

    # Find most recent backup
    local latest_backup
    latest_backup=$(ls -t "${config_file}${PROFILE_BACKUP_SUFFIX}."* 2>/dev/null | head -1)

    if [[ -n "$latest_backup" && -f "$latest_backup" ]]; then
        cp "$latest_backup" "$config_file"
        installer_log_info "Restored config from: $latest_backup"
        return 0
    else
        installer_log_error "No backup found for: $config_file"
        return 1
    fi
}

# ============================================
# PATH CONFIGURATION
# ============================================

# Check if PATH already contains CLEO bin directory
# Returns: 0 if in PATH, 1 otherwise
installer_profile_check_path() {
    [[ ":$PATH:" == *":$PROFILE_BIN_DIR:"* ]]
}

# Generate PATH export command for shell type
# Args: shell_type
# Returns: Command string to add PATH
installer_profile_get_path_cmd() {
    local shell_type="${1:-$(installer_profile_detect_shell)}"

    case "$shell_type" in
        fish)
            echo "set -gx PATH \"$PROFILE_BIN_DIR\" \$PATH"
            ;;
        *)
            echo "export PATH=\"$PROFILE_BIN_DIR:\$PATH\""
            ;;
    esac
}

# Check if CLEO section already exists in config
# Args: config_file
# Returns: 0 if exists, 1 otherwise
installer_profile_has_cleo_section() {
    local config_file="$1"

    [[ -f "$config_file" ]] && grep -q "$PROFILE_START_MARKER" "$config_file"
}

# ============================================
# PROFILE UPDATE
# ============================================

# Update shell profile with CLEO configuration
# Args: [config_file]
# Returns: 0 on success, EXIT_PROFILE_FAILED on error
installer_profile_update() {
    local config_file="${1:-$(installer_profile_detect_config_file)}"
    local shell_type
    shell_type=$(installer_profile_detect_shell)

    installer_log_info "Updating shell profile: $config_file"

    # Check if already configured
    if installer_profile_has_cleo_section "$config_file"; then
        installer_log_debug "CLEO section already exists in profile"
        return 0
    fi

    # Create backup
    installer_profile_backup "$config_file" >/dev/null || {
        installer_log_error "Failed to create backup"
        return $EXIT_PROFILE_FAILED
    }

    # Create config file if it doesn't exist
    if [[ ! -f "$config_file" ]]; then
        touch "$config_file" || {
            installer_log_error "Failed to create config file: $config_file"
            return $EXIT_PROFILE_FAILED
        }
    fi

    # Generate content to add
    local path_cmd
    path_cmd=$(installer_profile_get_path_cmd "$shell_type")

    local cleo_block
    cleo_block=$(cat <<EOF

$PROFILE_START_MARKER
# Added by CLEO installer ($(date -u +%Y-%m-%dT%H:%M:%SZ))
# CLEO task management CLI
if [[ -d "$PROFILE_BIN_DIR" ]]; then
    $path_cmd
fi
$PROFILE_END_MARKER
EOF
)

    # Append to config file
    echo "$cleo_block" >> "$config_file" || {
        installer_log_error "Failed to update profile"
        return $EXIT_PROFILE_FAILED
    }

    installer_log_info "Profile updated: $config_file"
    installer_log_info "Please restart your shell or run: source $config_file"

    return 0
}

# Remove CLEO configuration from shell profile
# Args: [config_file]
# Returns: 0 on success
installer_profile_remove() {
    local config_file="${1:-$(installer_profile_detect_config_file)}"

    if [[ ! -f "$config_file" ]]; then
        installer_log_debug "Config file not found: $config_file"
        return 0
    fi

    if ! installer_profile_has_cleo_section "$config_file"; then
        installer_log_debug "No CLEO section in config file"
        return 0
    fi

    installer_log_info "Removing CLEO from profile: $config_file"

    # Create backup first
    installer_profile_backup "$config_file" >/dev/null

    # Remove CLEO section
    local temp_file="${config_file}.tmp.$$"

    # Use sed to remove section between markers
    sed "/$PROFILE_START_MARKER/,/$PROFILE_END_MARKER/d" "$config_file" > "$temp_file"
    mv "$temp_file" "$config_file"

    installer_log_info "CLEO configuration removed from profile"
    return 0
}

# ============================================
# VERIFICATION
# ============================================

# Verify shell profile is correctly configured
# Returns: 0 if valid, 1 otherwise
installer_profile_verify() {
    local config_file
    config_file=$(installer_profile_detect_config_file)
    local shell_type
    shell_type=$(installer_profile_detect_shell)
    local issues=0

    installer_log_info "Verifying shell profile configuration..."

    # Check if config file exists
    if [[ ! -f "$config_file" ]]; then
        installer_log_warn "Shell config file not found: $config_file"
        ((issues++))
    fi

    # Check if CLEO section exists
    if ! installer_profile_has_cleo_section "$config_file"; then
        installer_log_warn "CLEO section not found in profile"
        ((issues++))
    fi

    # Check if bin dir is in current PATH
    if ! installer_profile_check_path; then
        installer_log_warn "CLEO bin directory not in current PATH: $PROFILE_BIN_DIR"
        installer_log_warn "Restart your shell or run: source $config_file"
        ((issues++))
    fi

    # Check if CLI is executable
    if command -v cleo &>/dev/null; then
        installer_log_debug "CLI found in PATH"
    else
        installer_log_warn "cleo command not found in PATH"
        ((issues++))
    fi

    if [[ $issues -gt 0 ]]; then
        installer_log_warn "Profile verification found $issues issue(s)"
        return 1
    fi

    installer_log_info "Shell profile configuration verified"
    return 0
}

# ============================================
# GLOBAL CONFIG INITIALIZATION
# ============================================

# Initialize global CLEO configuration
# Args: install_dir
# Returns: 0 on success
installer_profile_init_global_config() {
    local install_dir="${1:-$INSTALL_DIR}"
    local global_config="$HOME/.claude/cleo-global-config.json"
    local template="$install_dir/templates/global-config.template.json"

    # Only create if doesn't exist
    if [[ -f "$global_config" ]]; then
        installer_log_debug "Global config already exists: $global_config"
        return 0
    fi

    # Ensure directory exists
    mkdir -p "$(dirname "$global_config")"

    if [[ -f "$template" ]]; then
        cp "$template" "$global_config"
        installer_log_info "Initialized global config: $global_config"
    else
        # Create minimal config
        echo '{"version": "1.0.0", "projects": []}' > "$global_config"
        installer_log_debug "Created minimal global config"
    fi

    return 0
}

# Migrate legacy configuration from old location
# Returns: 0 if migrated or not needed, 1 on error
installer_profile_migrate_legacy() {
    local old_location="$HOME/.claude-todo"
    local new_location="$INSTALL_DIR"

    if [[ ! -d "$old_location" ]]; then
        return 0  # Nothing to migrate
    fi

    if [[ -d "$new_location/.cleo" ]]; then
        installer_log_debug "Both old and new locations exist - skipping migration"
        return 0
    fi

    installer_log_info "Migrating from legacy location: $old_location"

    # Copy data files only
    local data_files=("todo.json" "todo-archive.json" "todo-log.json" "config.json")
    local migrated=0

    mkdir -p "$new_location/.cleo"

    for file in "${data_files[@]}"; do
        if [[ -f "$old_location/$file" ]]; then
            cp "$old_location/$file" "$new_location/.cleo/" && ((migrated++))
        fi
    done

    if [[ $migrated -gt 0 ]]; then
        installer_log_info "Migrated $migrated data file(s) from legacy location"
        installer_log_warn "Old location preserved at: $old_location"
        installer_log_warn "Remove manually after verifying migration: rm -rf $old_location"
    fi

    return 0
}

# ============================================
# CLAUDE ALIASES SETUP
# ============================================

# Check if Claude aliases are available for installation
# Returns: 0 if available, 1 otherwise
installer_profile_aliases_available() {
    local install_dir="${1:-$INSTALL_DIR}"
    [[ -f "$install_dir/lib/claude-aliases.sh" ]]
}

# Detect platform for Claude aliases
# Returns: linux, darwin, windows, unknown
installer_profile_detect_platform() {
    case "$(uname -s)" in
        Linux*)   echo "linux" ;;
        Darwin*)  echo "darwin" ;;
        CYGWIN*|MINGW*|MSYS*) echo "windows" ;;
        *)        echo "unknown" ;;
    esac
}

# Get available shells for Claude alias installation
# Returns: JSON array of shell info
installer_profile_get_alias_shells() {
    local install_dir="${1:-$INSTALL_DIR}"
    local platform
    platform=$(installer_profile_detect_platform)

    # Source the claude-aliases library if available
    if [[ -f "$install_dir/lib/claude-aliases.sh" ]]; then
        (
            source "$install_dir/lib/platform-compat.sh" 2>/dev/null || true
            source "$install_dir/lib/exit-codes.sh" 2>/dev/null || true
            source "$install_dir/lib/claude-aliases.sh" 2>/dev/null && \
            detect_available_shells
        ) 2>/dev/null || echo '[]'
    else
        echo '[]'
    fi
}

# Install Claude CLI aliases (interactive or automatic)
# Args: [--interactive] [--force] [--skip-cmd-autorun]
# Returns: 0 on success, 1 on partial, 2 on skip
installer_profile_setup_aliases() {
    local install_dir="${INSTALL_DIR:-$HOME/.cleo}"
    local interactive=false
    local force_flag=""
    local cmd_autorun=false

    # Parse options
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --interactive) interactive=true; shift ;;
            --force) force_flag="--force"; shift ;;
            --cmd-autorun) cmd_autorun=true; shift ;;
            --skip-cmd-autorun) cmd_autorun=false; shift ;;
            *) shift ;;
        esac
    done

    # Check if aliases library is available
    if ! installer_profile_aliases_available "$install_dir"; then
        installer_log_debug "Claude aliases library not found"
        return 2
    fi

    # Check if Claude CLI is installed
    if ! command -v claude &>/dev/null; then
        installer_log_warn "Claude CLI not found - skipping alias setup"
        installer_log_info "Install Claude CLI first, then run: cleo setup-claude-aliases"
        return 2
    fi

    local platform
    platform=$(installer_profile_detect_platform)

    # In interactive mode, prompt user
    if [[ "$interactive" == true ]] && [[ -t 0 ]]; then
        echo ""
        echo -e "${BOLD:-}Claude CLI Aliases Setup${RESET:-}"
        echo ""
        echo "CLEO can install optimized aliases for Claude CLI:"
        echo "  cc        - Interactive mode with optimized environment"
        echo "  ccy       - Interactive + skip permissions"
        echo "  ccr       - Resume previous session"
        echo "  ccry      - Resume + skip permissions"
        echo "  + more..."
        echo ""

        local available_shells
        available_shells=$(installer_profile_get_alias_shells "$install_dir")
        local shell_count
        shell_count=$(echo "$available_shells" | jq 'length' 2>/dev/null || echo "0")

        echo "Detected shells: $shell_count"

        # Show detected shells
        if [[ "$shell_count" -gt 0 ]]; then
            echo "$available_shells" | jq -r '.[] | "  - \(.name): \(.rcFile)"' 2>/dev/null || true
        fi
        echo ""

        # Ask about alias installation
        read -p "Install Claude CLI aliases? [Y/n]: " confirm
        if [[ "${confirm,,}" =~ ^(n|no)$ ]]; then
            installer_log_info "Skipping Claude alias installation"
            installer_log_info "Run later with: cleo setup-claude-aliases"
            return 2
        fi

        # For Windows, ask about CMD AutoRun
        if [[ "$platform" == "windows" ]]; then
            echo ""
            echo "Windows detected. CMD.exe aliases require registry setup for auto-loading."
            read -p "Configure CMD AutoRun registry? [y/N]: " cmd_confirm
            if [[ "${cmd_confirm,,}" =~ ^(y|yes)$ ]]; then
                cmd_autorun=true
            fi
        fi
    fi

    # Run the alias setup
    installer_log_info "Installing Claude CLI aliases..."

    local cmd_flag=""
    [[ "$cmd_autorun" == true ]] && cmd_flag="--cmd-autorun"

    # Source and run the setup
    if [[ -f "$install_dir/scripts/setup-claude-aliases.sh" ]]; then
        local result
        if result=$("$install_dir/scripts/setup-claude-aliases.sh" $force_flag $cmd_flag --json 2>&1); then
            local installed
            installed=$(echo "$result" | jq -r '.installed // 0' 2>/dev/null || echo "0")
            local skipped
            skipped=$(echo "$result" | jq -r '.skipped // 0' 2>/dev/null || echo "0")

            if [[ "$installed" -gt 0 ]]; then
                installer_log_info "Claude aliases installed for $installed shell(s)"
                return 0
            elif [[ "$skipped" -gt 0 ]]; then
                installer_log_debug "Claude aliases already current ($skipped shell(s))"
                return 0
            else
                installer_log_warn "No shells configured for Claude aliases"
                return 1
            fi
        else
            local exit_code=$?
            if [[ $exit_code -eq 23 ]]; then
                installer_log_warn "Existing aliases detected. Use 'cleo setup-claude-aliases --force' to override"
            else
                installer_log_warn "Claude alias setup had issues (exit $exit_code)"
            fi
            return 1
        fi
    else
        installer_log_debug "setup-claude-aliases.sh not found"
        return 2
    fi
}

# ============================================
# UTILITY FUNCTIONS
# ============================================

# Print current shell environment info
installer_profile_show_info() {
    local shell_type
    shell_type=$(installer_profile_detect_shell)
    local config_file
    config_file=$(installer_profile_detect_config_file)

    echo "Shell Information:"
    echo "  Type:        $shell_type"
    echo "  Config file: $config_file"
    echo "  Bin dir:     $PROFILE_BIN_DIR"
    echo "  In PATH:     $(installer_profile_check_path && echo "yes" || echo "no")"

    if installer_profile_has_cleo_section "$config_file"; then
        echo "  CLEO config: present"
    else
        echo "  CLEO config: not found"
    fi
}

# ============================================
# EXPORT PUBLIC API
# ============================================
export -f installer_profile_detect_shell
export -f installer_profile_detect_config_file
export -f installer_profile_is_login_shell
export -f installer_profile_backup
export -f installer_profile_restore
export -f installer_profile_check_path
export -f installer_profile_get_path_cmd
export -f installer_profile_has_cleo_section
export -f installer_profile_update
export -f installer_profile_remove
export -f installer_profile_verify
export -f installer_profile_init_global_config
export -f installer_profile_migrate_legacy
export -f installer_profile_show_info
export -f installer_profile_aliases_available
export -f installer_profile_detect_platform
export -f installer_profile_get_alias_shells
export -f installer_profile_setup_aliases
