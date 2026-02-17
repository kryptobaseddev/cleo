#!/usr/bin/env bash
# CLEO TypeScript Development Setup
#
# Sets up local development environment by building the TypeScript source
# and creating symlinks so that `cleo` and `cleo-mcp` commands point to
# the local build output.
#
# Usage:
#   npm run dev:setup    # Via npm script
#   bash dev/setup-ts-dev.sh   # Direct invocation
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

# Check prerequisites
check_prerequisites() {
    # Check Node.js
    if ! command -v node >/dev/null 2>&1; then
        error "Node.js is required but not found"
        echo "Install: https://nodejs.org/ (>= ${NODE_MIN_VERSION})"
        exit 1
    fi

    local node_version
    node_version=$(node -v 2>/dev/null | sed 's/^v//')
    local node_major
    node_major=$(echo "$node_version" | cut -d. -f1)

    if [[ "$node_major" -lt "$NODE_MIN_VERSION" ]]; then
        error "Node.js v${node_version} is too old. Need >= ${NODE_MIN_VERSION}."
        echo "Update: nvm install ${NODE_MIN_VERSION}"
        exit 1
    fi

    # Check npm
    if ! command -v npm >/dev/null 2>&1; then
        error "npm is required but not found"
        exit 1
    fi

    # Check package.json exists
    if [[ ! -f "$REPO_DIR/package.json" ]]; then
        error "package.json not found in $REPO_DIR"
        echo "Are you running this from the CLEO repository?"
        exit 1
    fi

    success "Prerequisites: Node.js v${node_version}, npm $(npm -v)"
}

# Detect and back up legacy bash-based installation
migrate_legacy() {
    # Check for old bash-based wrapper
    if [[ -f "$CLEO_HOME/cleo" ]] && [[ -d "$CLEO_HOME/scripts" ]] && ls "$CLEO_HOME/scripts/"*.sh >/dev/null 2>&1; then
        warn "Legacy bash-based CLEO installation detected"

        # Preserve user data files
        local data_files=("todo.json" "todo-archive.json" "todo-log.jsonl" "config.json" ".context-state.json")
        local backup_dir="$CLEO_HOME/.legacy-backup-$(date +%Y%m%d%H%M%S)"
        mkdir -p "$backup_dir"

        info "Backing up user data to $backup_dir..."
        for f in "${data_files[@]}"; do
            if [[ -f "$CLEO_HOME/$f" ]]; then
                cp "$CLEO_HOME/$f" "$backup_dir/$f"
            fi
        done

        # Back up metrics
        [[ -d "$CLEO_HOME/metrics" ]] && cp -r "$CLEO_HOME/metrics" "$backup_dir/metrics"

        # Remove old bash-specific directories
        for d in scripts lib bin; do
            [[ -d "$CLEO_HOME/$d" ]] && rm -rf "$CLEO_HOME/$d"
        done

        # Remove old bash wrapper
        [[ -f "$CLEO_HOME/cleo" ]] && rm -f "$CLEO_HOME/cleo"

        success "Legacy installation backed up and cleaned"
    fi
}

# Install npm dependencies
install_deps() {
    info "Installing npm dependencies..."
    cd "$REPO_DIR"
    if [[ ! -d "node_modules" ]]; then
        npm install
    else
        info "node_modules exists, skipping npm install (use 'npm install' to refresh)"
    fi
}

# Build TypeScript
build() {
    info "Building TypeScript system..."
    cd "$REPO_DIR" && npm run build

    # Verify build output exists
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

# Create symlinks for dev mode
setup_links() {
    info "Setting up development symlinks..."

    # Create bin directory in CLEO_HOME
    mkdir -p "$CLEO_HOME/bin"

    # Symlink built binaries into CLEO_HOME/bin
    ln -sf "$REPO_DIR/dist/cli/index.js" "$CLEO_HOME/bin/cleo"
    ln -sf "$REPO_DIR/dist/mcp/index.js" "$CLEO_HOME/bin/cleo-mcp"
    chmod +x "$CLEO_HOME/bin/cleo" "$CLEO_HOME/bin/cleo-mcp"

    # Link to PATH location
    mkdir -p "$HOME/.local/bin"
    ln -sf "$CLEO_HOME/bin/cleo" "$HOME/.local/bin/cleo"
    ln -sf "$CLEO_HOME/bin/cleo" "$HOME/.local/bin/ct"
    ln -sf "$CLEO_HOME/bin/cleo-mcp" "$HOME/.local/bin/cleo-mcp"

    # Check PATH
    if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
        warn "\$HOME/.local/bin is not in your PATH"
        echo "  Add to your shell profile: export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi

    success "Symlinks created"
}

# Write VERSION file
write_version() {
    local version
    version=$(node -e "import('$REPO_DIR/package.json', { with: { type: 'json' } }).then(m => console.log(m.default.version))" 2>/dev/null || \
              node -e "console.log(require('$REPO_DIR/package.json').version)" 2>/dev/null || \
              echo "unknown")

    cat > "$CLEO_HOME/VERSION" << EOF
${version}
mode=dev-ts
source=${REPO_DIR}
installed=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

    success "VERSION: ${version} (dev-ts mode)"
}

# Verify installation
verify() {
    info "Verifying installation..."

    local ok=true

    if command -v cleo >/dev/null 2>&1; then
        success "cleo is in PATH"
    else
        warn "cleo not found in PATH (restart shell or check PATH)"
        ok=false
    fi

    if command -v cleo-mcp >/dev/null 2>&1; then
        success "cleo-mcp is in PATH"
    else
        warn "cleo-mcp not found in PATH (restart shell or check PATH)"
        ok=false
    fi

    if command -v ct >/dev/null 2>&1; then
        success "ct alias is in PATH"
    else
        warn "ct alias not found in PATH"
    fi

    if $ok; then
        echo ""
        success "Dev mode active. Run 'cleo version' to verify."
    else
        echo ""
        warn "Some binaries not in PATH. Restart your shell and try again."
    fi
}

# Main
main() {
    echo ""
    info "CLEO TypeScript Development Setup"
    echo ""

    check_prerequisites
    migrate_legacy
    install_deps
    build
    setup_links
    write_version
    verify
}

main "$@"
