#!/usr/bin/env sh
# install.sh — one-line installer for @cleocode/cleo
#
# Usage (preferred — batteries-included curl pipe):
#   curl -fsSL https://raw.githubusercontent.com/kryptobaseddev/cleocode/main/scripts/install.sh | sh
#
# Local invocation (for --dry-run testing or CI):
#   sh scripts/install.sh [OPTIONS]
#
# Options:
#   --dry-run        Print what would happen without making any changes
#   --with-node      Auto-install Node via fnm if missing/too old (off by default)
#   --pnpm           Use pnpm global install instead of npm (if pnpm is in PATH)
#   --skip-wizard    Do not launch cleo after install (useful in CI/non-interactive)
#   --version VER    Install a specific @cleocode/cleo version (default: latest)
#
# Supported platforms: Linux (x86_64, aarch64), macOS (x86_64, arm64)
# Node floor: >=24.16.0
#   SSoT: root package.json engines.node  (see scripts/lint-installer-node-floor.mjs)
#
# This script:
#   1. Detects OS and architecture
#   2. Checks that Node >= NODE_FLOOR is present; offers --with-node opt-in if not
#   3. Runs: npm install -g @cleocode/cleo (or pnpm if --pnpm)
#   4. Verifies `cleo --version` works
#   5. On first install (no ~/.config/cleo/config.json), prints the wizard hand-off line
#
# Idempotent: safe to re-run. Re-running upgrades the package in place.
# Daemon: the postinstall hook handles daemon lifecycle per policy (#1070).
#         This script NEVER enables or starts the systemd daemon directly.
# Sudo:   npm/pnpm global install may require sudo on some setups.
#         The script detects that and prints a clear message; it NEVER calls
#         sudo silently.
#
# @task T11981
# @epic T11671 E6-ONBOARDING

set -eu

# ── SSoT: Node floor ─────────────────────────────────────────────────────────
# This constant MUST match root package.json engines.node.
# CI guard: scripts/lint-installer-node-floor.mjs enforces parity.
NODE_FLOOR_MAJOR=24
NODE_FLOOR_MINOR=16
NODE_FLOOR_PATCH=0
NODE_FLOOR="${NODE_FLOOR_MAJOR}.${NODE_FLOOR_MINOR}.${NODE_FLOOR_PATCH}"

# ── Package to install ───────────────────────────────────────────────────────
PACKAGE="@cleocode/cleo"
PACKAGE_VERSION="latest"

# ── Defaults ────────────────────────────────────────────────────────────────
DRY_RUN=0
WITH_NODE=0
USE_PNPM=0
SKIP_WIZARD=0

# ── Parse arguments ──────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)     DRY_RUN=1; shift ;;
    --with-node)   WITH_NODE=1; shift ;;
    --pnpm)        USE_PNPM=1; shift ;;
    --skip-wizard) SKIP_WIZARD=1; shift ;;
    --version)
      PACKAGE_VERSION="$2"
      shift 2 ;;
    --version=*)   PACKAGE_VERSION="${1#*=}"; shift ;;
    -h|--help)
      sed -n '2,38p' "$0"
      exit 0 ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      printf 'Run with --help for usage.\n' >&2
      exit 1 ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────────────────
info()    { printf '\033[0;32m[cleo-install]\033[0m %s\n' "$*"; }
warn()    { printf '\033[0;33m[cleo-install] WARN:\033[0m %s\n' "$*" >&2; }
error()   { printf '\033[0;31m[cleo-install] ERROR:\033[0m %s\n' "$*" >&2; }
section() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
dry()     { printf '\033[0;36m[dry-run]\033[0m %s\n' "$*"; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    dry "Would run: $*"
  else
    "$@"
  fi
}

# ── Platform detection ───────────────────────────────────────────────────────
section "Detecting platform"
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="macos" ;;
  *)
    error "Unsupported OS: $OS"
    error "Windows users: use the PowerShell installer (scripts/install.ps1)"
    error "or run under WSL2 (Ubuntu recommended)."
    exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH_NORM="x64" ;;
  aarch64|arm64) ARCH_NORM="arm64" ;;
  *)
    warn "Unrecognised architecture: $ARCH — proceeding anyway, native modules may fail."
    ARCH_NORM="$ARCH" ;;
esac

info "Platform: $PLATFORM / $ARCH_NORM"
if [ "$DRY_RUN" -eq 1 ]; then
  dry "OS=$OS ARCH=$ARCH"
fi

# ── Node.js version check ─────────────────────────────────────────────────────
section "Checking Node.js (required: >=$NODE_FLOOR)"

node_ok() {
  if ! command -v node >/dev/null 2>&1; then return 1; fi
  _NODE_RAW="$(node --version 2>/dev/null)" || return 1
  _NODE_VER="${_NODE_RAW#v}"
  _MAJOR="$(echo "$_NODE_VER" | cut -d. -f1)"
  _MINOR="$(echo "$_NODE_VER" | cut -d. -f2)"
  _PATCH="$(echo "$_NODE_VER" | cut -d. -f3)"
  if [ "$_MAJOR" -gt "$NODE_FLOOR_MAJOR" ]; then return 0; fi
  if [ "$_MAJOR" -eq "$NODE_FLOOR_MAJOR" ] && [ "$_MINOR" -gt "$NODE_FLOOR_MINOR" ]; then return 0; fi
  if [ "$_MAJOR" -eq "$NODE_FLOOR_MAJOR" ] && [ "$_MINOR" -eq "$NODE_FLOOR_MINOR" ] && [ "$_PATCH" -ge "$NODE_FLOOR_PATCH" ]; then return 0; fi
  return 1
}

if node_ok; then
  NODE_CURRENT="$(node --version 2>/dev/null)"
  info "Node.js $NODE_CURRENT — OK (>=$NODE_FLOOR required)"
else
  FOUND_NODE="not found"
  if command -v node >/dev/null 2>&1; then
    FOUND_NODE="$(node --version 2>/dev/null)"
  fi
  warn "Node.js $FOUND_NODE does not meet the minimum requirement (>=$NODE_FLOOR)."
  warn ""
  warn "The Node floor is set to $NODE_FLOOR because it ships with SQLite 3.53.0+"
  warn "(required for WAL-reset fix) and the V8 version CLEO's native modules target."
  warn ""

  if [ "$WITH_NODE" -eq 1 ]; then
    section "Installing Node.js via fnm (--with-node)"
    if ! command -v fnm >/dev/null 2>&1; then
      info "fnm not found — installing fnm first..."
      if [ "$DRY_RUN" -eq 1 ]; then
        dry "Would run: curl -fsSL https://fnm.vercel.app/install | sh -s -- --skip-shell"
        dry "Would run: export PATH=\"\$HOME/.local/share/fnm:\$PATH\""
        dry "Would run: eval \"\$(fnm env --use-on-cd)\""
      else
        curl -fsSL https://fnm.vercel.app/install | sh -s -- --skip-shell
        # Add fnm to PATH for this session
        FNM_PATH="$HOME/.local/share/fnm"
        if [ -d "$FNM_PATH" ]; then
          export PATH="$FNM_PATH:$PATH"
          eval "$(fnm env --use-on-cd 2>/dev/null)" || true
        fi
      fi
    fi
    run fnm install "$NODE_FLOOR"
    run fnm use "$NODE_FLOOR"
    # Re-check
    if [ "$DRY_RUN" -eq 0 ] && ! node_ok; then
      error "Node $NODE_FLOOR installation via fnm failed."
      error "Please install Node manually: https://nodejs.org/en/download"
      exit 1
    fi
    info "Node.js installed via fnm."
  else
    error "Please install Node.js >= $NODE_FLOOR before running this installer."
    error ""
    error "Recommended options:"
    if [ "$PLATFORM" = "macos" ]; then
      error "  brew install node              # Homebrew"
      error "  OR:"
    fi
    if [ "$PLATFORM" = "linux" ]; then
      error "  # Ubuntu/Debian:"
      error "  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -"
      error "  sudo apt-get install -y nodejs"
      error "  # Fedora/RHEL:"
      error "  sudo dnf install nodejs"
      error "  OR:"
    fi
    error "  # fnm (fast Node manager — all platforms):"
    error "  curl -fsSL https://fnm.vercel.app/install | sh"
    error "  fnm install $NODE_FLOOR && fnm use $NODE_FLOOR"
    error ""
    error "Re-run this installer after installing Node, OR use:"
    error "  sh install.sh --with-node"
    error "to have this script install Node via fnm automatically."
    exit 1
  fi
fi

# ── git check ────────────────────────────────────────────────────────────────
section "Checking git"
if command -v git >/dev/null 2>&1; then
  info "git $(git --version | awk '{print $3}') — OK"
else
  warn "git not found. CLEO's worktree and version-control features require git."
  if [ "$PLATFORM" = "macos" ]; then
    warn "Install via: xcode-select --install   OR   brew install git"
  elif [ "$PLATFORM" = "linux" ]; then
    warn "Install via: sudo apt-get install git   (Debian/Ubuntu)"
    warn "             sudo dnf install git        (Fedora/RHEL)"
  fi
  warn "Proceeding — CLEO core will install but some features will be unavailable."
fi

# ── Package manager selection ────────────────────────────────────────────────
section "Selecting package manager"
if [ "$USE_PNPM" -eq 1 ]; then
  if command -v pnpm >/dev/null 2>&1; then
    PM_INSTALL_CMD="pnpm add -g"
    info "Using pnpm (--pnpm flag set)"
  else
    warn "pnpm not found — falling back to npm"
    PM_INSTALL_CMD="npm install -g"
  fi
else
  PM_INSTALL_CMD="npm install -g"
  if command -v npm >/dev/null 2>&1; then
    info "Using npm $(npm --version)"
  else
    error "npm not found. npm ships with Node.js — your Node installation may be broken."
    error "Try: node --version   then   npm --version"
    exit 1
  fi
fi

# ── Detect existing install ──────────────────────────────────────────────────
section "Checking for existing CLEO install"
FIRST_INSTALL=1
if command -v cleo >/dev/null 2>&1; then
  EXISTING_VER="$(cleo --version 2>/dev/null || echo 'unknown')"
  info "Found existing cleo $EXISTING_VER — will upgrade"
  FIRST_INSTALL=0
else
  info "No existing cleo install detected — fresh install"
fi

# ── Install / upgrade ────────────────────────────────────────────────────────
section "Installing $PACKAGE"

if [ "$PACKAGE_VERSION" = "latest" ]; then
  INSTALL_SPEC="$PACKAGE"
else
  INSTALL_SPEC="${PACKAGE}@${PACKAGE_VERSION}"
fi

info "Running: $PM_INSTALL_CMD $INSTALL_SPEC"

# Attempt install; detect if sudo might be needed
if [ "$DRY_RUN" -eq 1 ]; then
  dry "Would run: $PM_INSTALL_CMD $INSTALL_SPEC"
else
  if ! $PM_INSTALL_CMD "$INSTALL_SPEC" 2>/tmp/cleo_install_err; then
    # Check if it is a permissions error
    if grep -qiE "permission denied|EACCES|EPERM" /tmp/cleo_install_err 2>/dev/null; then
      error "Permission denied during global install."
      error ""
      error "Options:"
      error "  1. Use a Node version manager (fnm/nvm) — then no sudo needed:"
      error "     fnm install $NODE_FLOOR && fnm use $NODE_FLOOR"
      error "     Then re-run this installer."
      error ""
      error "  2. Fix npm global prefix (avoids sudo permanently):"
      error "     mkdir -p \"\$HOME/.npm-global\""
      error "     npm config set prefix \"\$HOME/.npm-global\""
      error "     export PATH=\"\$HOME/.npm-global/bin:\$PATH\"  # add to your shell rc"
      error "     Then re-run this installer."
      error ""
      error "  3. As a last resort (not recommended):"
      error "     sudo $PM_INSTALL_CMD $INSTALL_SPEC"
      cat /tmp/cleo_install_err >&2
      exit 1
    fi
    error "Install failed. Output:"
    cat /tmp/cleo_install_err >&2
    exit 1
  fi
fi

# ── Verify install ───────────────────────────────────────────────────────────
section "Verifying install"
if [ "$DRY_RUN" -eq 1 ]; then
  dry "Would run: cleo --version"
  dry "Would check: cleo command is in PATH"
else
  if ! command -v cleo >/dev/null 2>&1; then
    error "cleo not found in PATH after install."
    error "Your global bin directory may not be in PATH."
    error ""
    error "Find your npm global bin with:  npm bin -g"
    error "Then add it to your shell's PATH (in ~/.bashrc or ~/.zshrc):"
    error "  export PATH=\"\$(npm bin -g):\$PATH\""
    error ""
    error "After updating PATH, open a new terminal and run: cleo --version"
    exit 1
  fi
  INSTALLED_VER="$(cleo --version 2>/dev/null)"
  info "cleo $INSTALLED_VER installed successfully."
fi

# ── First-install wizard hand-off ────────────────────────────────────────────
if [ "$FIRST_INSTALL" -eq 1 ] && [ "$SKIP_WIZARD" -eq 0 ]; then
  section "First install — starting setup wizard"
  CONFIG_FILE="$HOME/.config/cleo/config.json"
  if [ "$DRY_RUN" -eq 1 ]; then
    dry "Would check: $CONFIG_FILE exists"
    dry "Would run: cleo   (opens TUI / wizard)"
  else
    if [ ! -f "$CONFIG_FILE" ]; then
      info "No config found at $CONFIG_FILE — launching setup wizard..."
      info ""
      info "  Run:  cleo"
      info ""
      info "The TUI wizard will guide you through:"
      info "  • Connecting your Anthropic account (or API key)"
      info "  • Setting up your first project"
      info "  • Configuring CLEO for your workflow"
      info ""
      # Non-interactive environments (CI, piped install) skip the actual launch
      if [ -t 1 ] && [ "${CI:-}" = "" ]; then
        cleo
      else
        info "(Non-interactive environment detected — skipping auto-launch)"
        info "Run 'cleo' manually to start the setup wizard."
      fi
    fi
  fi
elif [ "$FIRST_INSTALL" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  info "Upgrade complete. Run 'cleo' to open the TUI or 'cleo --help' to see commands."
fi

# ── Summary ──────────────────────────────────────────────────────────────────
section "Done"
if [ "$DRY_RUN" -eq 1 ]; then
  dry "Dry run complete — no changes were made."
  dry ""
  dry "Summary of what WOULD happen:"
  dry "  Platform:  $PLATFORM / $ARCH_NORM"
  dry "  Node req:  >= $NODE_FLOOR"
  dry "  Install:   $PM_INSTALL_CMD $INSTALL_SPEC"
  dry "  Verify:    cleo --version"
  if [ "$FIRST_INSTALL" -eq 1 ] && [ "$SKIP_WIZARD" -eq 0 ]; then
    dry "  Wizard:    cleo (on first install if interactive)"
  fi
else
  info "CLEO installed. Get started:"
  info "  cleo              open TUI"
  info "  cleo --help       command reference"
  info "  cleo login        connect your account"
fi
