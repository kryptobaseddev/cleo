#!/usr/bin/env bash
# CLAUDE-TODO Global Installer
# Installs the claude-todo system to ~/.claude-todo
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(cat "$SCRIPT_DIR/VERSION" | tr -d '[:space:]')"
INSTALL_DIR="${CLAUDE_TODO_HOME:-$HOME/.claude-todo}"

# Parse arguments
FORCE=false
for arg in "$@"; do
  case "$arg" in
    -f|--force|-y|--yes)
      FORCE=true
      ;;
    -h|--help)
      echo "Usage: ./install.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  -f, --force, -y, --yes   Skip confirmation prompts"
      echo "  -h, --help               Show this help"
      exit 0
      ;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }
log_step()  { echo -e "${BLUE}[STEP]${NC} $1"; }

# Compare semantic versions: returns 0 if v1 < v2, 1 if v1 == v2, 2 if v1 > v2
compare_versions() {
  local v1="$1" v2="$2"

  # Parse version components
  local v1_major v1_minor v1_patch v2_major v2_minor v2_patch
  IFS='.' read -r v1_major v1_minor v1_patch <<< "$v1"
  IFS='.' read -r v2_major v2_minor v2_patch <<< "$v2"

  # Default to 0 if empty
  v1_major=${v1_major:-0}; v1_minor=${v1_minor:-0}; v1_patch=${v1_patch:-0}
  v2_major=${v2_major:-0}; v2_minor=${v2_minor:-0}; v2_patch=${v2_patch:-0}

  # Compare major
  if (( v1_major < v2_major )); then return 0; fi
  if (( v1_major > v2_major )); then return 2; fi

  # Compare minor
  if (( v1_minor < v2_minor )); then return 0; fi
  if (( v1_minor > v2_minor )); then return 2; fi

  # Compare patch
  if (( v1_patch < v2_patch )); then return 0; fi
  if (( v1_patch > v2_patch )); then return 2; fi

  return 1  # Equal
}

# Check for existing installation
if [[ -d "$INSTALL_DIR" ]]; then
  EXISTING_VERSION=""
  [[ -f "$INSTALL_DIR/VERSION" ]] && EXISTING_VERSION=$(cat "$INSTALL_DIR/VERSION" | tr -d '[:space:]')

  echo ""

  if [[ -z "$EXISTING_VERSION" ]]; then
    # No version file - old installation, just upgrade
    log_info "Upgrading legacy installation (no version file)"
  else
    # Compare versions
    set +e
    compare_versions "$EXISTING_VERSION" "$VERSION"
    CMP_RESULT=$?
    set -e

    if [[ $CMP_RESULT -eq 0 ]]; then
      # Existing < New: Auto-upgrade
      log_info "Upgrading: $EXISTING_VERSION → $VERSION"
    elif [[ $CMP_RESULT -eq 1 ]]; then
      # Equal versions
      if [[ "$FORCE" == "true" ]]; then
        log_info "Reinstalling v$VERSION (forced)"
      else
        log_info "Already at version $VERSION"
        echo "  Use --force to reinstall"
        exit 0
      fi
    else
      # Existing > New: Downgrade warning
      log_warn "Downgrade detected: $EXISTING_VERSION → $VERSION"
      if [[ "$FORCE" != "true" ]]; then
        read -p "Continue with downgrade? (y/N) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
          echo "Installation cancelled."
          exit 0
        fi
      fi
    fi
  fi

  rm -rf "$INSTALL_DIR"
fi

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   CLAUDE-TODO Installer v$VERSION      ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""

# Determine script directory (where this installer is located)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Create directory structure
log_step "Creating directory structure..."
mkdir -p "$INSTALL_DIR"/{schemas,templates,scripts,lib,docs}

# Write version
echo "$VERSION" > "$INSTALL_DIR/VERSION"

# ============================================
# SCHEMAS
# ============================================
log_step "Installing schemas..."

# Copy all schema files from repo
if [[ -d "$SCRIPT_DIR/schemas" ]]; then
  cp -r "$SCRIPT_DIR/schemas/"* "$INSTALL_DIR/schemas/"
  log_info "Schemas installed ($(ls -1 "$INSTALL_DIR/schemas" | wc -l) files)"
else
  log_error "Schemas directory not found at $SCRIPT_DIR/schemas"
  exit 1
fi

# ============================================
# TEMPLATES
# ============================================
log_step "Installing templates..."

# Copy all template files from repo
if [[ -d "$SCRIPT_DIR/templates" ]]; then
  cp -r "$SCRIPT_DIR/templates/"* "$INSTALL_DIR/templates/"
  log_info "Templates installed ($(ls -1 "$INSTALL_DIR/templates" | wc -l) files)"
else
  log_error "Templates directory not found at $SCRIPT_DIR/templates"
  exit 1
fi

# ============================================
# SCRIPTS
# ============================================
log_step "Installing scripts..."

# Create wrapper script for PATH
cat > "$INSTALL_DIR/scripts/claude-todo" << 'WRAPPER_EOF'
#!/usr/bin/env bash
# CLAUDE-TODO CLI Wrapper
CLAUDE_TODO_HOME="${CLAUDE_TODO_HOME:-$HOME/.claude-todo}"
SCRIPT_DIR="$CLAUDE_TODO_HOME/scripts"

# Command to script mapping
declare -A CMD_MAP=(
  [init]="init.sh"
  [validate]="validate.sh"
  [archive]="archive.sh"
  [log]="log.sh"
  [add]="add-task.sh"
  [complete]="complete-task.sh"
  [list]="list-tasks.sh"
  [stats]="stats.sh"
  [backup]="backup.sh"
  [restore]="restore.sh"
  [session]="session.sh"
  [focus]="focus.sh"
  [export]="export.sh"
  [migrate]="migrate.sh"
  [update]="update-task.sh"
)

# Brief descriptions for main help (one-liners only)
declare -A CMD_DESC=(
  [init]="Initialize todo system in current directory"
  [validate]="Validate todo.json against schema"
  [archive]="Archive completed tasks"
  [log]="Add log entry"
  [add]="Add new task"
  [complete]="Complete a task"
  [list]="List tasks"
  [stats]="Show statistics"
  [backup]="Create backup"
  [restore]="Restore from backup"
  [session]="Manage work sessions (start/end/status)"
  [focus]="Manage task focus (set/clear/note/next)"
  [export]="Export tasks to TodoWrite/JSON/Markdown format"
  [migrate]="Migrate todo files to current schema version"
  [update]="Update existing task fields"
)

show_main_help() {
  echo "CLAUDE-TODO v$(cat "$CLAUDE_TODO_HOME/VERSION")"
  echo ""
  echo "Usage: claude-todo <command> [options]"
  echo "       claude-todo help <command>    Show detailed command help"
  echo ""
  echo "Commands:"
  for cmd in init add update complete list focus session archive validate stats backup restore export migrate log; do
    printf "  %-14s %s\n" "$cmd" "${CMD_DESC[$cmd]}"
  done
  echo "  version        Show version"
  echo "  help           Show this help"
  echo ""
  echo "Run 'claude-todo help <command>' for detailed options."
  echo ""
  echo "Examples:"
  echo "  claude-todo init my-project"
  echo "  claude-todo session start"
  echo "  claude-todo add \"Implement feature\""
  echo "  claude-todo focus set <task-id>"
  echo "  claude-todo complete <task-id>"
  echo "  claude-todo session end --note \"Done for today\""
}

CMD="${1:-help}"

case "$CMD" in
  version)
    cat "$CLAUDE_TODO_HOME/VERSION"
    ;;
  help)
    if [[ -n "${2:-}" ]] && [[ -n "${CMD_MAP[$2]:-}" ]]; then
      # Delegate to script's --help
      bash "$SCRIPT_DIR/${CMD_MAP[$2]}" --help
    else
      show_main_help
    fi
    ;;
  *)
    if [[ -n "${CMD_MAP[$CMD]:-}" ]]; then
      shift
      bash "$SCRIPT_DIR/${CMD_MAP[$CMD]}" "$@"
    else
      echo "Unknown command: $CMD"
      echo "Run 'claude-todo help' for available commands."
      exit 1
    fi
    ;;
esac
WRAPPER_EOF

chmod +x "$INSTALL_DIR/scripts/claude-todo"

# Copy actual scripts from repo
if [[ -d "$SCRIPT_DIR/scripts" ]]; then
  for script in "$SCRIPT_DIR/scripts/"*.sh; do
    if [[ -f "$script" ]]; then
      cp "$script" "$INSTALL_DIR/scripts/"
      chmod +x "$INSTALL_DIR/scripts/$(basename "$script")"
    fi
  done
  log_info "Scripts installed ($(ls -1 "$INSTALL_DIR/scripts"/*.sh 2>/dev/null | wc -l) files)"
else
  log_warn "Scripts directory not found at $SCRIPT_DIR/scripts"
fi

# ============================================
# LIBRARY FUNCTIONS
# ============================================
log_step "Installing library functions..."

if [[ -d "$SCRIPT_DIR/lib" ]]; then
  for lib in "$SCRIPT_DIR/lib/"*.sh; do
    if [[ -f "$lib" ]]; then
      cp "$lib" "$INSTALL_DIR/lib/"
      chmod +x "$INSTALL_DIR/lib/$(basename "$lib")"
    fi
  done
  log_info "Library functions installed ($(ls -1 "$INSTALL_DIR/lib"/*.sh 2>/dev/null | wc -l) files)"
else
  log_error "Library directory not found at $SCRIPT_DIR/lib (CRITICAL)"
  exit 1
fi

# ============================================
# DOCUMENTATION
# ============================================
log_step "Installing documentation..."

# Copy all documentation files from docs/
if [[ -d "$SCRIPT_DIR/docs" ]]; then
  for doc in "$SCRIPT_DIR/docs/"*.md; do
    if [[ -f "$doc" ]]; then
      cp "$doc" "$INSTALL_DIR/docs/"
    fi
  done
  log_info "Documentation installed ($(ls -1 "$INSTALL_DIR/docs"/*.md 2>/dev/null | wc -l) files)"
else
  log_warn "Documentation directory not found at $SCRIPT_DIR/docs"
fi

# ============================================
# CREATE SYMLINKS IN STANDARD LOCATIONS
# ============================================
log_step "Creating symlinks for global access..."

# Create ~/.local/bin if it doesn't exist (XDG standard for user binaries)
LOCAL_BIN="$HOME/.local/bin"
mkdir -p "$LOCAL_BIN"

# Create symlink for claude-todo command
SYMLINK_TARGET="$LOCAL_BIN/claude-todo"
if [[ -L "$SYMLINK_TARGET" ]] || [[ -e "$SYMLINK_TARGET" ]]; then
  rm -f "$SYMLINK_TARGET"
fi
ln -sf "$INSTALL_DIR/scripts/claude-todo" "$SYMLINK_TARGET"
log_info "Created symlink: $SYMLINK_TARGET"

# Also create 'ct' shortcut symlink
CT_SYMLINK="$LOCAL_BIN/ct"
if [[ -L "$CT_SYMLINK" ]] || [[ -e "$CT_SYMLINK" ]]; then
  rm -f "$CT_SYMLINK"
fi
ln -sf "$INSTALL_DIR/scripts/claude-todo" "$CT_SYMLINK"
log_info "Created shortcut: $CT_SYMLINK"

# ============================================
# CONFIGURE PATH
# ============================================
log_step "Configuring shell PATH..."

# Ensure ~/.local/bin is in PATH (standard XDG location)
PATH_EXPORT="export PATH=\"\$HOME/.local/bin:\$PATH:$INSTALL_DIR/scripts\""
PATH_MARKER="# CLAUDE-TODO PATH"
SHELL_CONFIG=""
SHELL_NAME=""

# Detect user's shell and config file
detect_shell_config() {
  # Check SHELL environment variable
  case "$SHELL" in
    */zsh)
      SHELL_NAME="zsh"
      if [[ -f "$HOME/.zshrc" ]]; then
        SHELL_CONFIG="$HOME/.zshrc"
      else
        SHELL_CONFIG="$HOME/.zshrc"
        touch "$SHELL_CONFIG"
      fi
      ;;
    */bash)
      SHELL_NAME="bash"
      # Prefer .bashrc, fall back to .bash_profile
      if [[ -f "$HOME/.bashrc" ]]; then
        SHELL_CONFIG="$HOME/.bashrc"
      elif [[ -f "$HOME/.bash_profile" ]]; then
        SHELL_CONFIG="$HOME/.bash_profile"
      else
        SHELL_CONFIG="$HOME/.bashrc"
        touch "$SHELL_CONFIG"
      fi
      ;;
    */fish)
      SHELL_NAME="fish"
      SHELL_CONFIG="$HOME/.config/fish/config.fish"
      mkdir -p "$HOME/.config/fish"
      touch "$SHELL_CONFIG"
      # Fish uses different syntax
      PATH_EXPORT="set -gx PATH \$PATH $INSTALL_DIR/scripts"
      ;;
    *)
      # Default to bash
      SHELL_NAME="bash"
      SHELL_CONFIG="$HOME/.bashrc"
      [[ ! -f "$SHELL_CONFIG" ]] && touch "$SHELL_CONFIG"
      ;;
  esac
}

detect_shell_config

# Check if PATH already configured
if grep -q "claude-todo" "$SHELL_CONFIG" 2>/dev/null; then
  log_info "PATH already configured in $SHELL_CONFIG"
else
  # Add PATH export to shell config
  echo "" >> "$SHELL_CONFIG"
  echo "$PATH_MARKER" >> "$SHELL_CONFIG"
  echo "$PATH_EXPORT" >> "$SHELL_CONFIG"
  log_info "Added PATH to $SHELL_CONFIG"
fi

# ============================================
# CONFIGURE ALIASES
# ============================================
log_step "Configuring convenience aliases..."

ALIAS_MARKER="# CLAUDE-TODO ALIASES"

# Check if aliases already configured
if grep -q "$ALIAS_MARKER" "$SHELL_CONFIG" 2>/dev/null; then
  log_info "Aliases already configured in $SHELL_CONFIG"
else
  # Add aliases to shell config
  echo "" >> "$SHELL_CONFIG"
  echo "$ALIAS_MARKER" >> "$SHELL_CONFIG"
  if [[ "$SHELL_NAME" == "fish" ]]; then
    # Fish shell alias syntax
    echo "alias ct='claude-todo'" >> "$SHELL_CONFIG"
    echo "alias ct-add='claude-todo add'" >> "$SHELL_CONFIG"
    echo "alias ct-list='claude-todo list'" >> "$SHELL_CONFIG"
    echo "alias ct-done='claude-todo complete'" >> "$SHELL_CONFIG"
    echo "alias ct-focus='claude-todo focus'" >> "$SHELL_CONFIG"
  else
    # Bash/Zsh alias syntax
    echo "alias ct='claude-todo'" >> "$SHELL_CONFIG"
    echo "alias ct-add='claude-todo add'" >> "$SHELL_CONFIG"
    echo "alias ct-list='claude-todo list'" >> "$SHELL_CONFIG"
    echo "alias ct-done='claude-todo complete'" >> "$SHELL_CONFIG"
    echo "alias ct-focus='claude-todo focus'" >> "$SHELL_CONFIG"
  fi
  log_info "Added aliases to $SHELL_CONFIG"
fi

# ============================================
# FINALIZE
# ============================================
echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Installation Complete!               ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo "Installed to: $INSTALL_DIR"
echo "Symlinks:     $LOCAL_BIN/claude-todo"
echo "              $LOCAL_BIN/ct (shortcut)"
echo "Shell config: $SHELL_CONFIG"
echo ""

# Check if ~/.local/bin is already in PATH
if echo "$PATH" | grep -q "$LOCAL_BIN"; then
  echo -e "${GREEN}✓ Ready to use immediately!${NC}"
  echo "  (Claude Code and most shells already have ~/.local/bin in PATH)"
else
  echo -e "${YELLOW}To activate now, run:${NC}"
  echo ""
  if [[ "$SHELL_NAME" == "fish" ]]; then
    echo "  source $SHELL_CONFIG"
  else
    echo "  source $SHELL_CONFIG"
  fi
  echo ""
  echo "Or open a new terminal."
fi
echo ""
echo "Usage:"
echo "  cd your-project"
echo "  claude-todo init"
echo ""
echo "Verify installation:"
echo "  claude-todo version"
echo "  ct version          # shortcut"
echo ""
