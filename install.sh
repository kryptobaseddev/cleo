#!/usr/bin/env bash
#
# CLEO Installer - Universal entry point
#
# Works in two modes:
#   1. Local repo:  ./install.sh (delegates to installer/install.sh)
#   2. Remote:      curl ... | bash (downloads release from GitHub)
#
# Usage:
#   curl -fsSL https://cleo.sh/install | bash     # End user install
#   ./install.sh                                   # Interactive (from repo)
#   ./install.sh --dev                             # Developer mode
#

set -euo pipefail

# Early Bash version check - try to find and use Bash 4+ on macOS
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

# Configuration
GITHUB_REPO="kryptobaseddev/cleo"
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
  curl -fsSL https://raw.githubusercontent.com/kryptobaseddev/cleo/main/install.sh | bash
  ./install.sh [OPTIONS]

Installation Modes:
  (default)         Standard installation from GitHub release
  --dev             Development mode (symlinks to local repo)

Options:
  --force           Overwrite existing installation
  --skip-profile    Skip shell profile updates
  --skip-skills     Skip skills installation
  --version VER     Install specific version (e.g., 0.56.0)

Information:
  --check-deps      Check dependencies only
  --status          Show installation status
  --help            Show this help

Recovery:
  --recover         Recover from interrupted installation
  --rollback        Rollback to previous backup
  --uninstall       Remove CLEO installation

Examples:
  curl ... | bash                 # Quick install (end user)
  ./install.sh                    # Interactive (from cloned repo)
  ./install.sh --dev              # Developer mode with symlinks
  ./install.sh --version 0.56.0   # Install specific version

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

# Check for required commands
check_deps() {
    local missing=()

    command -v bash >/dev/null || missing+=("bash")
    command -v jq >/dev/null || missing+=("jq")

    # Need either curl or wget for remote install
    if ! command -v curl >/dev/null && ! command -v wget >/dev/null; then
        missing+=("curl or wget")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        warn "Missing required dependencies: ${missing[*]}"

        local pkg_manager
        pkg_manager=$(detect_pkg_manager)

        if [[ "$pkg_manager" != "unknown" ]]; then
            # Ask user if they want auto-install (only if interactive)
            if [[ -t 0 ]]; then
                echo ""
                read -p "Would you like to install them automatically? [Y/n]: " confirm
                if [[ ! "${confirm,,}" =~ ^(n|no)$ ]]; then
                    if auto_install_deps "$pkg_manager" "${missing[@]}"; then
                        return 0
                    fi
                fi
            fi
        fi

        # Manual instructions if auto-install not used or failed
        error "Missing required dependencies: ${missing[*]}"
        echo ""
        echo "Install them with:"
        echo "  Ubuntu/Debian: sudo apt install ${missing[*]}"
        echo "  macOS:         brew install ${missing[*]}"
        echo "  Fedora:        sudo dnf install ${missing[*]}"
        exit 1
    fi
}

# Download a file using curl or wget
download() {
    local url="$1"
    local dest="$2"

    if command -v curl >/dev/null; then
        curl -fsSL "$url" -o "$dest"
    elif command -v wget >/dev/null; then
        wget -q "$url" -O "$dest"
    else
        error "No download tool available (need curl or wget)"
        exit 1
    fi
}

# Get latest release version from GitHub
get_latest_version() {
    local api_url="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
    local version=""

    if command -v curl >/dev/null; then
        version=$(curl -fsSL "$api_url" 2>/dev/null | jq -r '.tag_name // empty' 2>/dev/null || true)
    elif command -v wget >/dev/null; then
        version=$(wget -qO- "$api_url" 2>/dev/null | jq -r '.tag_name // empty' 2>/dev/null || true)
    fi

    # Strip 'v' prefix if present
    version="${version#v}"
    echo "$version"
}

# Install from GitHub release (for end users)
remote_install() {
    local version="${1:-}"
    local force="${2:-false}"

    show_banner
    info "Installing CLEO from GitHub..."
    echo ""

    check_deps

    # Get version
    if [[ -z "$version" ]]; then
        info "Fetching latest version..."
        version=$(get_latest_version)
        if [[ -z "$version" ]]; then
            error "Could not determine latest version"
            echo "Try specifying a version: ./install.sh --version 0.56.0"
            exit 1
        fi
    fi

    info "Installing CLEO v${version}"

    # Check existing installation
    if [[ -d "$INSTALL_DIR" ]] && [[ "$force" != "true" ]]; then
        local current=$(cat "$INSTALL_DIR/VERSION" 2>/dev/null | head -1 || echo "unknown")
        warn "Existing installation found: v${current}"

        if [[ -t 0 ]]; then
            read -p "Overwrite? [y/N]: " confirm
            if [[ ! "${confirm,,}" =~ ^(y|yes)$ ]]; then
                echo "Installation cancelled."
                exit 0
            fi
        else
            error "Use --force to overwrite existing installation"
            exit 1
        fi
    fi

    # Create temp directory
    local tmp_dir=$(mktemp -d)
    trap "rm -rf '$tmp_dir'" EXIT

    # Download release tarball (from release assets, not source archive)
    local tarball_url="https://github.com/${GITHUB_REPO}/releases/download/v${version}/cleo-${version}.tar.gz"
    local tarball="$tmp_dir/cleo.tar.gz"

    info "Downloading v${version}..."
    if ! download "$tarball_url" "$tarball"; then
        error "Failed to download release"
        echo "Check if version exists: https://github.com/${GITHUB_REPO}/releases"
        exit 1
    fi

    # Verify checksum
    local checksums_url="https://github.com/${GITHUB_REPO}/releases/download/v${version}/SHA256SUMS"
    local checksums="$tmp_dir/SHA256SUMS"
    if download "$checksums_url" "$checksums" 2>/dev/null; then
        info "Verifying checksum..."
        local expected=$(grep "cleo-${version}.tar.gz" "$checksums" | cut -d' ' -f1)
        local actual=$(sha256sum "$tarball" | cut -d' ' -f1)
        if [[ "$expected" != "$actual" ]]; then
            error "Checksum verification failed!"
            echo "Expected: $expected"
            echo "Got:      $actual"
            exit 1
        fi
        success "Checksum verified"
    fi

    # Extract
    info "Extracting..."
    tar -xzf "$tarball" -C "$tmp_dir"

    # Find extracted directory
    local src_dir=$(find "$tmp_dir" -maxdepth 1 -type d -name "cleo-*" | head -1)
    if [[ -z "$src_dir" ]] || [[ ! -d "$src_dir" ]]; then
        error "Failed to extract release"
        exit 1
    fi

    # Run the modular installer from extracted source
    local installer="$src_dir/installer/install.sh"
    if [[ -f "$installer" ]]; then
        info "Running installer..."
        chmod +x "$installer"
        exec "$installer" --force
    else
        # Fallback: manual copy if modular installer not in release
        info "Installing files..."
        mkdir -p "$INSTALL_DIR"
        cp -r "$src_dir/scripts" "$INSTALL_DIR/"
        cp -r "$src_dir/lib" "$INSTALL_DIR/"
        cp -r "$src_dir/schemas" "$INSTALL_DIR/"
        cp -r "$src_dir/templates" "$INSTALL_DIR/"
        [[ -d "$src_dir/skills" ]] && cp -r "$src_dir/skills" "$INSTALL_DIR/"
        [[ -d "$src_dir/docs" ]] && cp -r "$src_dir/docs" "$INSTALL_DIR/"
        cp "$src_dir/VERSION" "$INSTALL_DIR/"

        # Create CLI wrapper
        create_cli_wrapper

        # Setup symlinks
        setup_bin_links

        success "CLEO v${version} installed successfully!"

        # Update global agent configuration files
        echo ""
        info "Updating global agent configurations..."
        if [[ -x "$INSTALL_DIR/scripts/setup-agents.sh" ]]; then
            "$INSTALL_DIR/scripts/setup-agents.sh" --force >/dev/null 2>&1 || true
            success "Agent configurations updated"
        fi

        echo ""
        echo "Run 'cleo version' to verify installation."
        echo "Run 'cleo init' in a project directory to get started."
    fi
}

# Create the CLI wrapper script
create_cli_wrapper() {
    cat > "$INSTALL_DIR/cleo" << 'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
export CLEO_HOME

cmd="${1:-}"
[[ -z "$cmd" ]] && { "$CLEO_HOME/scripts/help.sh"; exit 0; }

case "$cmd" in
    --help|-h) "$CLEO_HOME/scripts/help.sh"; exit 0 ;;
    --version|-v) cat "$CLEO_HOME/VERSION" | head -1; exit 0 ;;
    --validate) "$CLEO_HOME/scripts/validate-install.sh"; exit $? ;;
    --list-commands) "$CLEO_HOME/scripts/commands.sh"; exit $? ;;
esac

script="$CLEO_HOME/scripts/${cmd}.sh"
[[ -f "$script" ]] || script="$CLEO_HOME/scripts/${cmd}-task.sh"
[[ -f "$script" ]] || { echo "Unknown command: $cmd" >&2; exit 1; }

shift
exec "$script" "$@"
WRAPPER
    chmod +x "$INSTALL_DIR/cleo"
}

# Setup bin symlinks
setup_bin_links() {
    local bin_dir="$HOME/.local/bin"
    mkdir -p "$bin_dir"

    ln -sf "$INSTALL_DIR/cleo" "$bin_dir/cleo"
    ln -sf "$INSTALL_DIR/cleo" "$bin_dir/ct"

    # Check if bin_dir is in PATH
    if [[ ":$PATH:" != *":$bin_dir:"* ]]; then
        warn "$bin_dir is not in your PATH"
        echo ""
        echo "Add this to your shell profile (~/.bashrc or ~/.zshrc):"
        echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
        echo ""
        echo "Then run: source ~/.bashrc"
    fi
}

# Interactive install for local repo
interactive_install() {
    show_banner

    echo -e "${CYAN}Welcome to the CLEO installer!${RESET}"
    echo ""

    # Check if this looks like a git repo
    local is_git_repo=false
    [[ -d "$SCRIPT_DIR/.git" ]] && is_git_repo=true

    # Detect existing installation
    if [[ -d "$INSTALL_DIR" ]]; then
        local current_version=$(cat "$INSTALL_DIR/VERSION" 2>/dev/null | head -1 || echo "unknown")
        echo -e "${YELLOW}Existing installation detected: v${current_version}${RESET}"
        echo ""
    fi

    # Mode selection
    echo -e "${BOLD}Select installation mode:${RESET}"
    echo ""
    if $is_git_repo; then
        echo -e "  ${GREEN}1)${RESET} Development mode ${DIM}(recommended for contributors)${RESET}"
        echo "     Creates symlinks to this repository"
        echo ""
        echo -e "  ${GREEN}2)${RESET} Release mode"
        echo "     Copies files to ~/.cleo"
    else
        echo -e "  ${GREEN}1)${RESET} Standard installation ${DIM}(recommended)${RESET}"
        echo "     Downloads latest release from GitHub"
        echo ""
        echo -e "  ${GREEN}2)${RESET} Development mode"
        echo "     Requires cloning the repository first"
    fi
    echo ""

    read -p "Enter choice [1]: " choice
    choice="${choice:-1}"

    case "$choice" in
        1)
            if $is_git_repo; then
                exec "$SCRIPT_DIR/installer/install.sh" --dev
            else
                remote_install "" "true"
            fi
            ;;
        2)
            if $is_git_repo; then
                exec "$SCRIPT_DIR/installer/install.sh" --force
            else
                error "Development mode requires cloning the repository first:"
                echo ""
                echo "  git clone https://github.com/${GITHUB_REPO}.git"
                echo "  cd cleo && ./install.sh --dev"
                exit 1
            fi
            ;;
        *)
            warn "Invalid choice, using default"
            if $is_git_repo; then
                exec "$SCRIPT_DIR/installer/install.sh" --dev
            else
                remote_install "" "true"
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
    # Remote install - download from GitHub
    if $DEV_MODE; then
        error "Development mode requires cloning the repository:"
        echo ""
        echo "  git clone https://github.com/${GITHUB_REPO}.git"
        echo "  cd cleo && ./install.sh --dev"
        exit 1
    fi

    remote_install "$VERSION" "$FORCE"
fi
