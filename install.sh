#!/usr/bin/env bash
#
# CLEO Installer - Universal entry point
#
# CLEO is a TypeScript/Node.js package published as @cleocode/cleo.
#
# Install methods:
#   1. npm (recommended): npm install -g @cleocode/cleo
#   2. Local repo:        ./install.sh (delegates to installer/install.sh)
#   3. Remote:            curl ... | bash (installs via npm)
#   4. Dev mode:          ./install.sh --dev (builds + symlinks for development)
#
# Usage:
#   npm install -g @cleocode/cleo               # End user install (recommended)
#   curl -fsSL https://cleo.sh/install | bash    # End user install (curl pipe)
#   ./install.sh                                  # Interactive (from repo)
#   ./install.sh --dev                            # Developer mode
#

set -euo pipefail

# Configuration
GITHUB_REPO="kryptobaseddev/cleo"
NPM_PACKAGE="@cleocode/cleo"
NODE_MIN_VERSION=20
INSTALL_DIR="${CLEO_HOME:-$HOME/.cleo}"

# Detect script location (empty if piped)
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" ]] && [[ "${BASH_SOURCE[0]}" != "bash" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || true
fi

# Colors (disabled if not TTY or NO_COLOR set)
if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
    BOLD='\033[1m'
    DIM='\033[2m'
    BLUE='\033[34m'
    GREEN='\033[32m'
    YELLOW='\033[33m'
    CYAN='\033[36m'
    RED='\033[31m'
    RESET='\033[0m'
else
    BOLD='' DIM='' BLUE='' GREEN='' YELLOW='' CYAN='' RED='' RESET=''
fi

info()  { echo -e "${CYAN}[INFO]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${RESET} $*"; }
error() { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
success() { echo -e "${GREEN}[OK]${RESET} $*"; }

show_banner() {
    echo -e "${BOLD}${BLUE}"
    cat << 'EOF'
   _____ _      ______ ____
  / ____| |    |  ____/ __ \
 | |    | |    | |__ | |  | |
 | |    | |    |  __|| |  | |
 | |____| |____| |___| |__| |
  \_____|______|______\____/
EOF
    echo -e "${RESET}"
    echo -e "${DIM}Command Line Entity Orchestrator${RESET}"
    echo ""
}

show_help() {
    cat << 'EOF'
CLEO Installer

Usage:
  npm install -g @cleocode/cleo                      # Recommended
  curl -fsSL https://cleo.sh/install | bash           # Via curl pipe
  ./install.sh [OPTIONS]                              # From cloned repo

Prerequisites:
  Node.js >= 20       https://nodejs.org/
  npm                 (included with Node.js)

Installation Modes:
  (default)         Install via npm (recommended)
  --dev             Development mode (builds + symlinks to local repo)

Options:
  --force           Overwrite existing installation
  --skip-profile    Skip shell profile updates
  --skip-skills     Skip skills installation
  --version VER     Install specific version (e.g., 2026.2.0)

Information:
  --check-deps      Check dependencies only
  --status          Show installation status
  --help            Show this help

Recovery:
  --recover         Recover from interrupted installation
  --rollback        Rollback to previous backup
  --uninstall       Remove CLEO installation

Dev Install:
  git clone https://github.com/cleocode/cleo.git
  cd cleo
  npm install
  npm run dev:setup

Examples:
  npm install -g @cleocode/cleo      # Quick install (recommended)
  curl ... | bash                     # Quick install (curl pipe)
  ./install.sh                        # Interactive (from cloned repo)
  ./install.sh --dev                  # Developer mode

EOF
}

# Detect package manager
detect_pkg_manager() {
    if command -v apt-get &>/dev/null; then echo "apt"
    elif command -v dnf &>/dev/null; then echo "dnf"
    elif command -v yum &>/dev/null; then echo "yum"
    elif command -v brew &>/dev/null; then echo "brew"
    elif command -v pacman &>/dev/null; then echo "pacman"
    elif command -v apk &>/dev/null; then echo "apk"
    else echo "unknown"
    fi
}

# Try to auto-install missing dependencies
auto_install_deps() {
    local pkg_manager="$1"
    shift
    local deps=("$@")

    local install_cmd=""
    case "$pkg_manager" in
        apt)    install_cmd="sudo apt-get update && sudo apt-get install -y" ;;
        dnf)    install_cmd="sudo dnf install -y" ;;
        yum)    install_cmd="sudo yum install -y" ;;
        brew)   install_cmd="brew install" ;;
        pacman) install_cmd="sudo pacman -S --noconfirm" ;;
        apk)    install_cmd="apk add" ;;
        *)      return 1 ;;
    esac

    info "Installing: ${deps[*]}"
    if eval "$install_cmd ${deps[*]}"; then
        success "Dependencies installed"
        return 0
    else
        return 1
    fi
}

# Check Node.js version meets minimum requirement
# Returns: 0 if meets requirements, 1 otherwise
check_node_version() {
    if ! command -v node >/dev/null 2>&1; then
        return 1
    fi

    local node_version
    node_version=$(node -v 2>/dev/null | sed 's/^v//')
    local node_major
    node_major=$(echo "$node_version" | cut -d. -f1)

    if [[ "$node_major" -ge "$NODE_MIN_VERSION" ]]; then
        return 0
    else
        return 1
    fi
}

# Check for required commands
check_deps() {
    local missing=()
    local node_too_old=false

    # Node.js is required
    if ! command -v node >/dev/null 2>&1; then
        missing+=("node")
    elif ! check_node_version; then
        node_too_old=true
        local current_ver
        current_ver=$(node -v 2>/dev/null || echo "unknown")
        error "Node.js ${current_ver} is too old. CLEO requires Node.js >= ${NODE_MIN_VERSION}."
        echo ""
        echo "Update Node.js:"
        echo "  nvm:     nvm install ${NODE_MIN_VERSION} && nvm use ${NODE_MIN_VERSION}"
        echo "  Homebrew: brew install node@${NODE_MIN_VERSION}"
        echo "  Official: https://nodejs.org/"
        exit 1
    fi

    # npm is required
    if ! command -v npm >/dev/null 2>&1; then
        missing+=("npm")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        error "Missing required dependencies: ${missing[*]}"
        echo ""
        echo "CLEO requires Node.js >= ${NODE_MIN_VERSION} and npm."
        echo ""
        echo "Install Node.js:"
        echo "  nvm (recommended): curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
        echo "                     nvm install ${NODE_MIN_VERSION}"
        echo "  Homebrew:          brew install node@${NODE_MIN_VERSION}"
        echo "  Official:          https://nodejs.org/"
        exit 1
    fi
}

# Detect old bash-based CLEO installation
detect_legacy_install() {
    # Check for the old bash-based wrapper
    if [[ -f "$INSTALL_DIR/cleo" ]]; then
        # Old bash version has scripts/ directory with .sh files
        if [[ -d "$INSTALL_DIR/scripts" ]] && ls "$INSTALL_DIR/scripts/"*.sh >/dev/null 2>&1; then
            return 0  # Legacy bash installation found
        fi
    fi
    return 1  # No legacy installation
}

# Back up legacy bash installation before migration
migrate_legacy_install() {
    info "Detected legacy bash-based CLEO installation"

    # Preserve user data files
    local data_files=(
        "todo.json"
        "todo-archive.json"
        "todo-log.json"
        "config.json"
        ".context-state.json"
    )

    local backup_dir="$INSTALL_DIR/.legacy-backup-$(date +%Y%m%d%H%M%S)"
    mkdir -p "$backup_dir"

    info "Backing up user data to $backup_dir..."
    for f in "${data_files[@]}"; do
        if [[ -f "$INSTALL_DIR/$f" ]]; then
            cp "$INSTALL_DIR/$f" "$backup_dir/$f"
            success "  Backed up $f"
        fi
    done

    # Also back up metrics
    if [[ -d "$INSTALL_DIR/metrics" ]]; then
        cp -r "$INSTALL_DIR/metrics" "$backup_dir/metrics"
        success "  Backed up metrics/"
    fi

    # Remove old bash-specific directories (but NOT user data)
    local old_dirs=("scripts" "lib" "bin")
    for d in "${old_dirs[@]}"; do
        if [[ -d "$INSTALL_DIR/$d" ]]; then
            rm -rf "$INSTALL_DIR/$d"
        fi
    done

    # Remove old bash wrapper
    [[ -f "$INSTALL_DIR/cleo" ]] && rm -f "$INSTALL_DIR/cleo"

    success "Legacy installation backed up and cleaned"
    echo ""
}

# Install CLEO via npm (for end users)
npm_install() {
    local version="${1:-}"
    local force="${2:-false}"

    show_banner
    info "Installing CLEO via npm..."
    echo ""

    check_deps

    # Check for legacy bash installation
    if detect_legacy_install; then
        migrate_legacy_install
    fi

    # Build npm install command
    local npm_cmd="npm install -g ${NPM_PACKAGE}"
    if [[ -n "$version" ]]; then
        npm_cmd="npm install -g ${NPM_PACKAGE}@${version}"
    fi

    info "Running: $npm_cmd"
    echo ""

    if eval "$npm_cmd"; then
        success "CLEO installed successfully!"
    else
        error "npm install failed"
        echo ""
        echo "Common fixes:"
        echo "  Permission error: npm install -g ${NPM_PACKAGE} --prefix ~/.local"
        echo "  Or use nvm:       https://github.com/nvm-sh/nvm"
        exit 1
    fi

    # Verify installation
    echo ""
    info "Verifying installation..."

    if command -v cleo >/dev/null 2>&1; then
        local installed_ver
        installed_ver=$(cleo --version 2>/dev/null || echo "unknown")
        success "cleo is available (v${installed_ver})"
    else
        warn "cleo not found in PATH. You may need to restart your shell."
    fi

    if command -v cleo-mcp >/dev/null 2>&1; then
        success "cleo-mcp is available"
    else
        warn "cleo-mcp not found in PATH. You may need to restart your shell."
    fi

    # Create ct alias symlink if npm didn't create it
    local cleo_bin
    cleo_bin=$(command -v cleo 2>/dev/null || true)
    if [[ -n "$cleo_bin" ]] && ! command -v ct >/dev/null 2>&1; then
        local bin_dir
        bin_dir=$(dirname "$cleo_bin")
        ln -sf "$cleo_bin" "$bin_dir/ct" 2>/dev/null || true
        if command -v ct >/dev/null 2>&1; then
            success "Created ct alias"
        fi
    fi

    echo ""
    echo "Run 'cleo version' to verify installation."
    echo "Run 'cleo init' in a project directory to get started."
}

# Interactive install for local repo
interactive_install() {
    show_banner

    echo -e "${CYAN}Welcome to the CLEO installer!${RESET}"
    echo ""

    # Check prerequisites
    check_deps

    # Check if this looks like a git repo with package.json
    local is_repo=false
    [[ -d "$SCRIPT_DIR/.git" ]] && [[ -f "$SCRIPT_DIR/package.json" ]] && is_repo=true

    # Detect existing installation
    if command -v cleo >/dev/null 2>&1; then
        local current_version
        current_version=$(cleo --version 2>/dev/null || echo "unknown")
        echo -e "${YELLOW}Existing installation detected: v${current_version}${RESET}"
        echo ""
    fi

    # Check for legacy bash installation
    if detect_legacy_install; then
        echo -e "${YELLOW}Legacy bash-based installation detected at ${INSTALL_DIR}${RESET}"
        echo -e "${YELLOW}It will be migrated (user data preserved).${RESET}"
        echo ""
    fi

    # Mode selection
    echo -e "${BOLD}Select installation mode:${RESET}"
    echo ""
    if $is_repo; then
        echo -e "  ${GREEN}1)${RESET} Development mode ${DIM}(recommended for contributors)${RESET}"
        echo "     Builds TypeScript and creates symlinks to this repository"
        echo ""
        echo -e "  ${GREEN}2)${RESET} npm install ${DIM}(recommended for users)${RESET}"
        echo "     Installs globally via: npm install -g ${NPM_PACKAGE}"
    else
        echo -e "  ${GREEN}1)${RESET} npm install ${DIM}(recommended)${RESET}"
        echo "     Installs globally via: npm install -g ${NPM_PACKAGE}"
        echo ""
        echo -e "  ${GREEN}2)${RESET} Development mode"
        echo "     Requires cloning the repository first"
    fi
    echo ""

    read -p "Enter choice [1]: " choice
    choice="${choice:-1}"

    case "$choice" in
        1)
            if $is_repo; then
                exec "$SCRIPT_DIR/installer/install.sh" --dev
            else
                npm_install "" "true"
            fi
            ;;
        2)
            if $is_repo; then
                npm_install "" "true"
            else
                error "Development mode requires cloning the repository first:"
                echo ""
                echo "  git clone https://github.com/cleocode/cleo.git"
                echo "  cd cleo && npm install && npm run dev:setup"
                exit 1
            fi
            ;;
        *)
            warn "Invalid choice, using default"
            if $is_repo; then
                exec "$SCRIPT_DIR/installer/install.sh" --dev
            else
                npm_install "" "true"
            fi
            ;;
    esac
}

# =============================================================================
# Main
# =============================================================================

# Parse arguments
VERSION=""
FORCE=false
DEV_MODE=false
PASS_THROUGH=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h)
            show_help
            exit 0
            ;;
        --version)
            VERSION="$2"
            shift 2
            ;;
        --force|-f)
            FORCE=true
            PASS_THROUGH+=("--force")
            shift
            ;;
        --dev)
            DEV_MODE=true
            PASS_THROUGH+=("--dev")
            shift
            ;;
        --check-deps)
            check_deps
            success "All required dependencies are installed"
            info "  Node.js: $(node -v 2>/dev/null || echo 'not found')"
            info "  npm:     $(npm -v 2>/dev/null || echo 'not found')"
            exit 0
            ;;
        *)
            PASS_THROUGH+=("$1")
            shift
            ;;
    esac
done

# Determine install mode based on context
LOCAL_INSTALLER=""
if [[ -n "$SCRIPT_DIR" ]] && [[ -f "$SCRIPT_DIR/installer/install.sh" ]]; then
    LOCAL_INSTALLER="$SCRIPT_DIR/installer/install.sh"
fi

# Route to appropriate installer
if [[ -n "$LOCAL_INSTALLER" ]]; then
    # We have the full repo - use modular installer
    if [[ ${#PASS_THROUGH[@]} -gt 0 ]] || [[ ! -t 0 ]]; then
        # Non-interactive or has flags: pass through
        exec "$LOCAL_INSTALLER" "${PASS_THROUGH[@]}"
    else
        # Interactive mode
        interactive_install
    fi
else
    # Remote install via npm
    if $DEV_MODE; then
        error "Development mode requires cloning the repository:"
        echo ""
        echo "  git clone https://github.com/cleocode/cleo.git"
        echo "  cd cleo && npm install && npm run dev:setup"
        exit 1
    fi

    npm_install "$VERSION" "$FORCE"
fi
