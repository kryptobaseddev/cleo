#!/usr/bin/env bash
# CLEO Development Setup
#
# Sets up local development environment using `npm link` so that `cleo`,
# `ct`, and `cleo-mcp` commands resolve through npm's global bin — the same
# mechanism production `npm install -g` uses.
#
# This ensures dev mode exercises the same binary resolution path as
# production, avoiding symlink-chain bugs that only appear on install.
#
# Usage:
#   npm run dev:setup              # Via npm script
#   bash dev/setup-ts-dev.sh       # Direct invocation
#   bash dev/setup-ts-dev.sh --clean  # Remove old manual symlinks first
#
# Teardown:
#   bash dev/teardown-dev.sh       # Unlink and optionally install production
#
# @task T4583

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
NODE_MIN_VERSION=20

# Colors (disabled if not TTY or NO_COLOR set)
if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
    GREEN='\033[32m'
    YELLOW='\033[33m'
    CYAN='\033[36m'
    RED='\033[31m'
    RESET='\033[0m'
else
    GREEN='' YELLOW='' CYAN='' RED='' RESET=''
fi

info()    { echo -e "${CYAN}[INFO]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET} $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
success() { echo -e "${GREEN}[OK]${RESET} $*"; }

# --- Prerequisites -----------------------------------------------------------

check_prerequisites() {
    if ! command -v node >/dev/null 2>&1; then
        error "Node.js is required but not found"
        echo "Install: https://nodejs.org/ (>= ${NODE_MIN_VERSION})"
        exit 1
    fi

    local node_version node_major
    node_version=$(node -v 2>/dev/null | sed 's/^v//')
    node_major=$(echo "$node_version" | cut -d. -f1)

    if [[ "$node_major" -lt "$NODE_MIN_VERSION" ]]; then
        error "Node.js v${node_version} is too old. Need >= ${NODE_MIN_VERSION}."
        exit 1
    fi

    if ! command -v npm >/dev/null 2>&1; then
        error "npm is required but not found"
        exit 1
    fi

    if [[ ! -f "$REPO_DIR/package.json" ]]; then
        error "package.json not found in $REPO_DIR"
        echo "Are you running this from the CLEO repository?"
        exit 1
    fi

    success "Prerequisites: Node.js v${node_version}, npm $(npm -v)"
}

# --- Clean up legacy manual symlinks -----------------------------------------

clean_legacy_symlinks() {
    local cleaned=false

    # Remove old manual symlinks in ~/.local/bin that bypass npm
    for bin in "$HOME/.local/bin/cleo" "$HOME/.local/bin/ct" "$HOME/.local/bin/cleo-mcp"; do
        if [[ -L "$bin" ]]; then
            local target
            target=$(readlink "$bin" 2>/dev/null || true)
            # Only remove if it points to ~/.cleo/bin (old manual chain)
            if [[ "$target" == *".cleo/bin"* ]]; then
                rm -f "$bin"
                cleaned=true
                info "Removed legacy symlink: $bin -> $target"
            fi
        fi
    done

    # Remove old ~/.cleo/bin directory (no longer needed)
    if [[ -d "$CLEO_HOME/bin" ]]; then
        rm -rf "$CLEO_HOME/bin"
        cleaned=true
        info "Removed legacy ~/.cleo/bin directory"
    fi

    if $cleaned; then
        success "Legacy manual symlinks cleaned up"
    fi
}

# --- Install & Build ---------------------------------------------------------

install_deps() {
    info "Installing npm dependencies..."
    cd "$REPO_DIR"
    if [[ ! -d "node_modules" ]]; then
        npm install
    else
        info "node_modules exists, skipping npm install (use 'npm install' to refresh)"
    fi
}

build() {
    info "Building TypeScript system..."
    cd "$REPO_DIR" && npm run build

    if [[ ! -f "$REPO_DIR/dist/cli/index.js" ]]; then
        error "Build failed: dist/cli/index.js not found"
        exit 1
    fi
    if [[ ! -f "$REPO_DIR/dist/mcp/index.js" ]]; then
        error "Build failed: dist/mcp/index.js not found"
        exit 1
    fi

    success "Build complete"
}

# --- npm link (replaces manual symlinks) -------------------------------------

setup_npm_link() {
    info "Linking package globally via npm link..."
    cd "$REPO_DIR"

    # npm link creates symlinks in the npm global bin directory for each
    # entry in package.json "bin". This is the same mechanism that
    # `npm install -g @cleocode/cleo` uses, ensuring dev == production.
    npm link 2>&1 | while IFS= read -r line; do
        info "  $line"
    done

    local npm_bin
    npm_bin=$(npm config get prefix)/bin

    success "npm link complete (binaries in $npm_bin)"
}

# --- VERSION marker ----------------------------------------------------------

write_version() {
    local version
    version=$(node -e "import('$REPO_DIR/package.json', { with: { type: 'json' } }).then(m => console.log(m.default.version))" 2>/dev/null || \
              node -e "console.log(require('$REPO_DIR/package.json').version)" 2>/dev/null || \
              echo "unknown")

    mkdir -p "$CLEO_HOME"
    cat > "$CLEO_HOME/VERSION" << EOF
${version}
mode=dev
source=${REPO_DIR}
installed=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

    success "VERSION: ${version} (dev mode, npm link)"
}

# --- Verify ------------------------------------------------------------------

verify() {
    info "Verifying installation..."

    local ok=true
    local npm_bin
    npm_bin=$(npm config get prefix)/bin

    for cmd in cleo ct cleo-mcp; do
        local cmd_path
        cmd_path=$(command -v "$cmd" 2>/dev/null || true)
        if [[ -n "$cmd_path" ]]; then
            # Check it resolves through npm global (not old ~/.local/bin)
            if [[ "$cmd_path" == *"$npm_bin"* ]] || [[ "$(readlink -f "$cmd_path" 2>/dev/null)" == *"$REPO_DIR"* ]]; then
                success "$cmd -> $cmd_path (dev)"
            else
                warn "$cmd found at $cmd_path but does NOT point to this repo"
                warn "  You may have a production install shadowing dev mode"
                warn "  Run: npm uninstall -g @cleocode/cleo && npm run dev:setup"
                ok=false
            fi
        else
            warn "$cmd not found in PATH"
            if [[ ":$PATH:" != *":$npm_bin:"* ]]; then
                warn "  npm global bin ($npm_bin) is not in your PATH"
                warn "  Add to shell profile: export PATH=\"$npm_bin:\$PATH\""
            fi
            ok=false
        fi
    done

    echo ""
    if $ok; then
        success "Dev mode active. Run 'cleo version' to verify."
        echo ""
        info "Workflow:"
        info "  Edit source in src/ -> npm run build -> changes are live"
        info "  Or use: npm run dev:watch  (auto-rebuild on change)"
        echo ""
        info "To switch to production: bash dev/teardown-dev.sh"
    else
        warn "Some binaries not found. Restart your shell and try again."
    fi
}

# --- Main --------------------------------------------------------------------

main() {
    local clean=false
    for arg in "$@"; do
        case "$arg" in
            --clean) clean=true ;;
            --help|-h)
                echo "Usage: bash dev/setup-ts-dev.sh [--clean]"
                echo ""
                echo "Options:"
                echo "  --clean   Remove legacy manual symlinks before setup"
                echo ""
                echo "Sets up dev mode using npm link (same path as production npm install -g)."
                exit 0
                ;;
        esac
    done

    echo ""
    info "CLEO Development Setup (npm link)"
    echo ""

    check_prerequisites

    # Always clean legacy symlinks on first run or with --clean
    if $clean || [[ -d "$CLEO_HOME/bin" ]]; then
        clean_legacy_symlinks
    fi

    install_deps
    build
    setup_npm_link
    write_version
    verify
}

main "$@"
