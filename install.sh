#!/usr/bin/env bash
# CLEO Global Installer (formerly claude-todo)
# Installs the CLEO task management system to ~/.cleo
# TRUE CLEAN BREAK: NO claude-todo symlink, NO legacy fallback
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(cat "$SCRIPT_DIR/VERSION" | tr -d '[:space:]')"
INSTALL_DIR="${CLEO_HOME:-$HOME/.cleo}"
LEGACY_INSTALL_DIR="$HOME/.claude-todo"

# Parse arguments
FORCE=false
CHECK_DEPS_ONLY=false
INSTALL_DEPS=false
for arg in "$@"; do
  case "$arg" in
    -f|--force|-y|--yes)
      FORCE=true
      ;;
    --check-deps)
      CHECK_DEPS_ONLY=true
      ;;
    --install-deps)
      INSTALL_DEPS=true
      ;;
    -h|--help)
      echo "Usage: ./install.sh [OPTIONS]"
      echo ""
      echo "CLEO Installer - Task management for AI agents"
      echo ""
      echo "Options:"
      echo "  -f, --force, -y, --yes   Skip confirmation prompts"
      echo "  --check-deps             Check dependencies only, don't install"
      echo "  --install-deps           Attempt to install missing dependencies"
      echo "  -h, --help               Show this help"
      echo ""
      echo "Installation:"
      echo "  Default location: ~/.cleo"
      echo "  Commands: 'cleo' (primary), 'ct' (shortcut)"
      echo ""
      echo "Migration from claude-todo:"
      echo "  If you have an existing ~/.claude-todo installation,"
      echo "  run 'cleo claude-migrate --global' after installing."
      echo ""
      echo "Dependencies:"
      echo "  Critical: jq, bash 4+"
      echo "  Required: sha256sum/shasum, tar, flock, date, find"
      echo "  Optional: numfmt, ajv, jsonschema"
      exit 0
      ;;
  esac
done

# Handle --check-deps mode
if [[ "$CHECK_DEPS_ONLY" == "true" ]]; then
  echo "Checking CLEO dependencies..."
  echo ""
  if [[ -f "$SCRIPT_DIR/lib/dependency-check.sh" ]]; then
    source "$SCRIPT_DIR/lib/dependency-check.sh"
    validate_all_dependencies
    exit $?
  else
    echo "ERROR: dependency-check.sh not found" >&2
    exit 1
  fi
fi

# ============================================
# AUTO-INSTALL DEPENDENCIES (T169)
# ============================================
install_missing_deps() {
  local platform
  case "$(uname -s)" in
    Linux*)  platform="linux" ;;
    Darwin*) platform="macos" ;;
    *)       platform="unknown" ;;
  esac

  echo "Attempting to install missing dependencies..."
  echo "Platform detected: $platform"
  echo ""

  local install_cmd=""
  local sudo_needed=true

  case "$platform" in
    linux)
      if command -v apt-get &>/dev/null; then
        install_cmd="apt-get install -y"
      elif command -v dnf &>/dev/null; then
        install_cmd="dnf install -y"
      elif command -v yum &>/dev/null; then
        install_cmd="yum install -y"
      elif command -v pacman &>/dev/null; then
        install_cmd="pacman -S --noconfirm"
      else
        echo "ERROR: No supported package manager found (apt, dnf, yum, pacman)" >&2
        return 1
      fi
      ;;
    macos)
      if command -v brew &>/dev/null; then
        install_cmd="brew install"
        sudo_needed=false
      else
        echo "ERROR: Homebrew not found. Install it from https://brew.sh" >&2
        return 1
      fi
      ;;
    *)
      echo "ERROR: Unsupported platform for auto-install" >&2
      return 1
      ;;
  esac

  # Check what's missing
  local missing=()
  command -v jq &>/dev/null || missing+=("jq")
  command -v flock &>/dev/null || {
    [[ "$platform" == "macos" ]] && missing+=("flock") || missing+=("util-linux")
  }

  # coreutils provides sha256sum, numfmt on Linux (usually pre-installed)
  # On macOS, coreutils provides gsha256sum, gnumfmt
  if [[ "$platform" == "macos" ]]; then
    if ! command -v sha256sum &>/dev/null && ! command -v shasum &>/dev/null; then
      missing+=("coreutils")
    fi
    if ! command -v numfmt &>/dev/null && ! command -v gnumfmt &>/dev/null; then
      [[ ! " ${missing[*]} " =~ " coreutils " ]] && missing+=("coreutils")
    fi
  fi

  if [[ ${#missing[@]} -eq 0 ]]; then
    echo "All dependencies are already installed!"
    return 0
  fi

  echo "Will install: ${missing[*]}"
  echo ""

  if [[ "$FORCE" != "true" ]]; then
    read -p "Continue? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo "Installation cancelled."
      return 1
    fi
  fi

  # Run install command
  local full_cmd="$install_cmd ${missing[*]}"
  if [[ "$sudo_needed" == "true" ]]; then
    echo "Running: sudo $full_cmd"
    sudo $full_cmd
  else
    echo "Running: $full_cmd"
    $full_cmd
  fi

  local result=$?
  if [[ $result -eq 0 ]]; then
    echo ""
    echo "Dependencies installed successfully!"
  else
    echo ""
    echo "ERROR: Failed to install some dependencies" >&2
  fi
  return $result
}

# Handle --install-deps mode
if [[ "$INSTALL_DEPS" == "true" ]]; then
  install_missing_deps
  exit $?
fi

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

  # Targeted cleanup: Remove only managed code directories (T1522)
  # Preserves: config.json, projects-registry.json, plugins/, and other user data
  log_info "Cleaning up old managed files..."
  for dir in scripts lib schemas templates docs completions; do
    if [[ -d "$INSTALL_DIR/$dir" ]]; then
      rm -rf "$INSTALL_DIR/$dir"
    fi
  done
fi

# ============================================
# CHECK FOR LEGACY INSTALLATION
# ============================================
if [[ -d "$LEGACY_INSTALL_DIR" ]]; then
  echo ""
  log_warn "Legacy claude-todo installation detected at $LEGACY_INSTALL_DIR"
  echo ""
  echo "  After installation, run: cleo claude-migrate --global"
  echo "  This will migrate your data from ~/.claude-todo to ~/.cleo"
  echo ""
  if [[ "$FORCE" != "true" ]]; then
    read -p "Continue with CLEO installation? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo "Installation cancelled."
      exit 0
    fi
  fi
fi

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   CLEO Installer v$VERSION             ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""

# Determine script directory (where this installer is located)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# ============================================
# PRE-INSTALL DEPENDENCY CHECK (T166)
# ============================================
log_step "Checking system dependencies..."

# Source dependency check module if available
if [[ -f "$SCRIPT_DIR/lib/dependency-check.sh" ]]; then
  source "$SCRIPT_DIR/lib/dependency-check.sh"

  # Run comprehensive dependency validation
  if ! validate_all_dependencies; then
    echo ""
    log_error "Missing dependencies detected. Installation cannot continue."
    echo ""
    echo "Please install the missing dependencies listed above, then re-run this installer."
    echo ""
    echo "Quick install commands for common systems:"
    echo "  Ubuntu/Debian: sudo apt install jq coreutils util-linux"
    echo "  Fedora/RHEL:   sudo dnf install jq coreutils util-linux"
    echo "  macOS:         brew install jq coreutils flock"
    echo ""
    exit 1
  fi
  echo ""
else
  # Minimal fallback checks if module not available
  log_warn "Dependency check module not found, performing minimal validation..."

  # Check jq (critical)
  if ! command -v jq &>/dev/null; then
    log_error "jq is required but not installed."
    echo "Install with: sudo apt install jq (Debian/Ubuntu) or brew install jq (macOS)"
    exit 1
  fi
  log_info "jq: OK"

  # Check bash version (critical)
  if (( BASH_VERSINFO[0] < 4 )); then
    log_error "Bash 4+ is required (found: $BASH_VERSION)"
    echo "Install with: brew install bash (macOS) or upgrade your system bash"
    exit 1
  fi
  log_info "bash: OK ($BASH_VERSION)"

  # Check sha256sum or shasum (required)
  if ! command -v sha256sum &>/dev/null && ! command -v shasum &>/dev/null; then
    log_warn "sha256sum/shasum not found - checksum verification will be skipped"
  else
    log_info "sha256sum: OK"
  fi

  # Check tar (required)
  if ! command -v tar &>/dev/null; then
    log_warn "tar not found - backup features may be limited"
  else
    log_info "tar: OK"
  fi

  # Check flock (required)
  if ! command -v flock &>/dev/null; then
    log_warn "flock not found - file locking may not work properly"
  else
    log_info "flock: OK"
  fi

  echo ""
fi

# Create directory structure
log_step "Creating directory structure..."
mkdir -p "$INSTALL_DIR"/{schemas,templates,scripts,lib,docs,plugins}

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

  # Update CLEO:START version markers in templates to match installed version
  # This ensures templates always reference the current installed version
  for template in "$INSTALL_DIR/templates/"*.md "$INSTALL_DIR/templates/agents/"*.md; do
    [[ ! -f "$template" ]] && continue
    if grep -q "CLEO:START v" "$template" 2>/dev/null; then
      # Replace any CLEO:START vX.X.X with current VERSION
      sed -i "s/CLEO:START v[0-9.]\+/CLEO:START v$VERSION/g" "$template"
    fi
  done

  log_info "Templates installed ($(ls -1 "$INSTALL_DIR/templates" | wc -l) files)"
else
  log_error "Templates directory not found at $SCRIPT_DIR/templates"
  exit 1
fi

# ============================================
# SKILLS
# ============================================
log_step "Installing skills..."

# Copy skills directory for orchestrator and other skills
if [[ -d "$SCRIPT_DIR/skills" ]]; then
  mkdir -p "$INSTALL_DIR/skills"
  cp -r "$SCRIPT_DIR/skills/"* "$INSTALL_DIR/skills/"
  log_info "Skills installed ($(find "$INSTALL_DIR/skills" -type f | wc -l) files)"
else
  log_warn "Skills directory not found at $SCRIPT_DIR/skills (optional)"
fi

# ============================================
# SCRIPTS
# ============================================
log_step "Installing scripts..."

# Create wrapper script for PATH
cat > "$INSTALL_DIR/scripts/cleo" << 'WRAPPER_EOF'
#!/usr/bin/env bash
# CLEO CLI Wrapper v4 - Task management for AI agents
# TRUE CLEAN BREAK: Uses CLEO_* env vars only, NO claude-todo fallback
set -uo pipefail

CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
SCRIPT_DIR="$CLEO_HOME/scripts"
LIB_DIR="$CLEO_HOME/lib"
PLUGIN_DIR="$CLEO_HOME/plugins"
GLOBAL_CONFIG="$CLEO_HOME/config.json"

# ============================================
# CONFIG-DRIVEN DEBUG MODE
# Priority: CLEO_DEBUG env var > cli.debug.enabled config > default (0)
# ============================================
load_debug_mode() {
  # If env var is explicitly set, use it (highest priority)
  if [[ -n "${CLEO_DEBUG:-}" ]]; then
    DEBUG="$CLEO_DEBUG"
    return
  fi

  # Try to read from config
  if [[ -f "$GLOBAL_CONFIG" ]] && command -v jq &>/dev/null; then
    local config_debug
    config_debug=$(jq -r '.cli.debug.enabled // false' "$GLOBAL_CONFIG" 2>/dev/null)
    if [[ "$config_debug" == "true" ]]; then
      DEBUG=1
    else
      DEBUG=0
    fi
  else
    DEBUG=0
  fi

  # Export for child scripts
  export CLEO_DEBUG="$DEBUG"
}

# Initialize debug mode early
DEBUG=0
load_debug_mode

# ============================================
# COMMAND TO SCRIPT MAPPING (Core Commands)
# ============================================
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
  [export-tasks]="export-tasks.sh"
  [import-tasks]="import-tasks.sh"
  [migrate]="migrate.sh"
  [reorganize-backups]="reorganize-backups.sh"
  [update]="update-task.sh"
  [dash]="dash.sh"
  [next]="next.sh"
  [labels]="labels.sh"
  [deps]="deps-command.sh"
  [blockers]="blockers-command.sh"
  [phases]="phases.sh"
  [phase]="phase.sh"
  [exists]="exists.sh"
  [history]="history.sh"
  [show]="show.sh"
  [sync]="sync-todowrite.sh"
  [analyze]="analyze.sh"
  [config]="config.sh"
  [find]="find.sh"
  [commands]="commands.sh"
  [research]="research.sh"
  [reparent]="reparent.sh"
  [promote]="promote.sh"
  [unarchive]="unarchive.sh"
  [archive-stats]="archive-stats.sh"
  [delete]="delete.sh"
  [uncancel]="uncancel.sh"
  [reopen]="reopen.sh"
  [claude-migrate]="claude-migrate.sh"
  [populate-hierarchy]="populate-hierarchy.sh"
  [verify]="verify.sh"
  [upgrade]="upgrade.sh"
  [roadmap]="roadmap.sh"
  [context]="context.sh"
  [safestop]="safestop.sh"
  [sequence]="sequence.sh"
  [reorder]="reorder.sh"
  [swap]="reorder.sh"
  [doctor]="doctor.sh"
  [setup-agents]="setup-agents.sh"
  [orchestrator]="orchestrator.sh"
)

# Brief descriptions for main help
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
  [export-tasks]="Export tasks to portable cross-project format"
  [import-tasks]="Import tasks from another cleo project"
  [migrate]="Migrate todo files to current schema version"
  [reorganize-backups]="Reorganize legacy backups to unified taxonomy"
  [update]="Update existing task fields"
  [dash]="Show project dashboard (status, focus, phases, activity)"
  [next]="Suggest next task based on priority and dependencies"
  [labels]="List and analyze task labels/tags"
  [deps]="Visualize task dependency graphs and relationships"
  [blockers]="Analyze blocked tasks and dependency chains"
  [phases]="Manage project phases (list/show/stats)"
  [phase]="Manage project phase lifecycle (show/set/start/complete/advance)"
  [exists]="Check if a task ID exists"
  [history]="Show completion history and timeline analytics"
  [show]="Show detailed view of a single task"
  [sync]="Sync tasks with TodoWrite (inject/extract/status)"
  [analyze]="Task triage with leverage scoring and bottleneck detection"
  [config]="View and modify configuration settings"
  [find]="Fuzzy search tasks by title, ID, or labels"
  [commands]="List and query available commands (JSON by default)"
  [research]="Multi-source web research aggregation (Tavily, Context7, Reddit)"
  [reparent]="Move a task to a different parent task"
  [promote]="Remove parent from a task (make it root-level)"
  [unarchive]="Restore archived tasks back to todo.json"
  [archive-stats]="Generate analytics and reports from archived tasks"
  [delete]="Cancel/delete a task with child handling strategies"
  [uncancel]="Restore cancelled tasks back to pending status"
  [reopen]="Restore completed tasks back to pending status"
  [claude-migrate]="Migrate legacy .claude/ and ~/.claude-todo to CLEO"
  [populate-hierarchy]="Populate hierarchy fields (type, parentId) for migrated tasks"
  [verify]="View/set verification gates for task quality control"
  [upgrade]="Upgrade project schemas, fix issues, update docs (unified)"
  [roadmap]="Generate roadmap from epics and CHANGELOG"
  [context]="Monitor context window usage for agent safeguard"
  [safestop]="Graceful shutdown for agents at context limits"
  [sequence]="Inspect and manage task ID sequence (show/check/repair)"
  [reorder]="Change task position within sibling group"
  [swap]="Exchange positions of two sibling tasks"
  [doctor]="Comprehensive health check for CLEO installation and projects"
  [setup-agents]="Setup global agent configurations (CLAUDE.md, AGENTS.md, GEMINI.md)"
  [orchestrator]="Orchestrator Protocol CLI for multi-agent delegation workflows"
)

# ============================================
# DEFAULT ALIASES (can be overridden in config)
# ============================================
declare -A CMD_ALIASES=(
  [ls]="list"
  [done]="complete"
  [new]="add"
  [edit]="update"
  [rm]="archive"
  [check]="validate"
  [cfg]="config"
  [overview]="dash"
  [tags]="labels"
  [search]="find"
  [dig]="research"
  [tree]="list --tree"
  [cancel]="delete"
  [restore-cancelled]="uncancel"
  [restore-done]="reopen"
)

# Aliases that include flags (need special handling in resolve_command)
# Format: alias -> "command flag1 flag2..."
declare -A ALIASED_FLAGS=(
  [tree]="--tree"
)

# ============================================
# LOAD CONFIG OVERRIDES (if global config exists)
# ============================================
load_config_aliases() {
  if [[ -f "$GLOBAL_CONFIG" ]] && command -v jq &>/dev/null; then
    # Load custom aliases from config (merge with defaults)
    local config_aliases
    config_aliases=$(jq -r '.cli.aliases // {} | to_entries[] | "\(.key)=\(.value)"' "$GLOBAL_CONFIG" 2>/dev/null)
    while IFS='=' read -r alias target; do
      if [[ -n "$alias" && -n "$target" ]]; then
        CMD_ALIASES["$alias"]="$target"
        [[ "$DEBUG" == "1" ]] && echo "[DEBUG] Config alias: $alias -> $target" >&2
      fi
    done <<< "$config_aliases"
  fi
}

# ============================================
# CHECK CLI.PLUGINS CONFIG AND WARN IF ADVANCED FEATURES USED
# ============================================
check_plugin_config() {
  if [[ ! -f "$GLOBAL_CONFIG" ]] || ! command -v jq &>/dev/null; then
    return
  fi

  # Check if user has custom plugin directories configured
  local custom_dirs
  custom_dirs=$(jq -r '.cli.plugins.directories // [] | length' "$GLOBAL_CONFIG" 2>/dev/null)

  # Check if plugin config differs from defaults
  # Note: Use 'if .x == false then "false" else "true" end' because jq's // treats false as falsy
  local plugins_enabled
  plugins_enabled=$(jq -r 'if .cli.plugins.enabled == false then "false" else "true" end' "$GLOBAL_CONFIG" 2>/dev/null)

  local auto_discover
  auto_discover=$(jq -r 'if .cli.plugins.autoDiscover == false then "false" else "true" end' "$GLOBAL_CONFIG" 2>/dev/null)

  # Warn if plugins are disabled (non-default) - user expectation mismatch
  if [[ "$plugins_enabled" == "false" ]]; then
    echo "[WARN] cli.plugins.enabled=false in config, but plugin system is always active." >&2
    echo "       To disable plugins, remove them from plugin directories." >&2
  fi

  # Warn if autoDiscover is false (non-default)
  if [[ "$auto_discover" == "false" ]]; then
    echo "[WARN] cli.plugins.autoDiscover=false is not yet implemented." >&2
    echo "       All plugins in plugin directories are auto-discovered." >&2
  fi

  # Debug: show plugin config
  if [[ "$DEBUG" == "1" ]]; then
    echo "[DEBUG] Plugin config: enabled=$plugins_enabled autoDiscover=$auto_discover dirs=$custom_dirs" >&2
  fi
}

# ============================================
# PLUGIN DISCOVERY (Auto-discover from plugin directories)
# ============================================
declare -A PLUGIN_MAP=()
declare -A PLUGIN_DESC=()

discover_plugins() {
  local plugin_dirs=("$PLUGIN_DIR" "./.cleo/plugins")

  for dir in "${plugin_dirs[@]}"; do
    [[ ! -d "$dir" ]] && continue

    for plugin in "$dir"/*.sh; do
      [[ ! -f "$plugin" ]] && continue
      [[ ! -x "$plugin" ]] && continue

      # Extract plugin name from filename
      local plugin_name=$(basename "$plugin" .sh)

      # Check for metadata block (###PLUGIN ... ###END)
      local desc="Custom plugin"
      if grep -q "^###PLUGIN" "$plugin" 2>/dev/null; then
        desc=$(sed -n '/^###PLUGIN$/,/^###END$/p' "$plugin" | grep "^# description:" | cut -d: -f2- | xargs)
        [[ -z "$desc" ]] && desc="Custom plugin"
      fi

      # Register plugin (plugins override core commands if same name)
      PLUGIN_MAP["$plugin_name"]="$plugin"
      PLUGIN_DESC["$plugin_name"]="$desc"

      [[ "$DEBUG" == "1" ]] && echo "[DEBUG] Discovered plugin: $plugin_name -> $plugin" >&2
    done
  done
}

# ============================================
# PROJECT VERSION CHECK (fast check for warnings)
# ============================================
# Commands that skip version warnings (they handle their own)
VERSION_CHECK_SKIP="upgrade|migrate|init|validate|help|version|--help|-h|--version|-v"

check_project_version() {
  local cmd="${1:-}"

  # Skip for commands that handle their own checks
  [[ "$cmd" =~ ^($VERSION_CHECK_SKIP)$ ]] && return 0

  # Skip if disabled
  [[ -n "${CLEO_SKIP_VERSION_CHECK:-}" ]] && return 0

  # Skip if not a cleo project
  [[ ! -f "./.cleo/todo.json" ]] && return 0

  # Fast check: look for legacy structure indicators
  if command -v jq &>/dev/null; then
    # Check for top-level phases (legacy structure)
    if jq -e 'has("phases")' "./.cleo/todo.json" >/dev/null 2>&1; then
      echo "[WARN] Project has legacy structure. Run: cleo upgrade" >&2
      return 0
    fi

    # Check CLAUDE.md injection version
    if [[ -f "./CLAUDE.md" ]]; then
      local injection_ver installed_ver
      injection_ver=$(grep -oP 'CLEO:START v\K[0-9.]+' "./CLAUDE.md" 2>/dev/null || echo "")
      installed_ver=$(cat "$CLEO_HOME/VERSION" 2>/dev/null || echo "")

      if [[ -n "$injection_ver" ]] && [[ -n "$installed_ver" ]] && [[ "$injection_ver" != "$installed_ver" ]]; then
        echo "[WARN] CLAUDE.md outdated ($injection_ver → $installed_ver). Run: cleo upgrade" >&2
      fi
    fi
  fi
}

# ============================================
# DEBUG VALIDATION
# ============================================
debug_validate() {
  echo "[DEBUG] Validating CLI configuration..."
  local errors=0

  # Show debug mode source
  echo "[DEBUG] Debug mode source:"
  if [[ -n "${CLEO_DEBUG:-}" ]]; then
    echo "  Source: CLEO_DEBUG environment variable"
  elif [[ -f "$GLOBAL_CONFIG" ]] && command -v jq &>/dev/null; then
    local config_debug
    config_debug=$(jq -r '.cli.debug.enabled // false' "$GLOBAL_CONFIG" 2>/dev/null)
    echo "  Source: config.json (cli.debug.enabled=$config_debug)"
  else
    echo "  Source: default (disabled)"
  fi

  # Show config file status
  echo "[DEBUG] Config files:"
  if [[ -f "$GLOBAL_CONFIG" ]]; then
    echo "  Global: $GLOBAL_CONFIG (exists)"
  else
    echo "  Global: $GLOBAL_CONFIG (not found)"
  fi

  # Check all mapped scripts exist
  echo "[DEBUG] Checking command scripts..."
  for cmd in "${!CMD_MAP[@]}"; do
    local script="$SCRIPT_DIR/${CMD_MAP[$cmd]}"
    if [[ ! -f "$script" ]]; then
      echo "[ERROR] Missing script for '$cmd': $script" >&2
      ((errors++))
    elif [[ ! -x "$script" ]]; then
      echo "[WARN] Script not executable: $script" >&2
    fi
  done

  # Check plugin directory
  if [[ -d "$PLUGIN_DIR" ]]; then
    local plugin_count=$(find "$PLUGIN_DIR" -maxdepth 1 -name "*.sh" -executable 2>/dev/null | wc -l)
    echo "[DEBUG] Plugin directory: $PLUGIN_DIR ($plugin_count plugins)"
  else
    echo "[DEBUG] Plugin directory not found: $PLUGIN_DIR"
  fi

  # Show loaded aliases (distinguish built-in vs config)
  echo "[DEBUG] Loaded aliases:"
  for alias in "${!CMD_ALIASES[@]}"; do
    echo "  $alias -> ${CMD_ALIASES[$alias]}"
  done

  # Checksum verification (if enabled)
  if [[ -f "$CLEO_HOME/checksums.sha256" ]]; then
    echo "[DEBUG] Verifying script checksums..."
    if cd "$SCRIPT_DIR" && sha256sum -c "$CLEO_HOME/checksums.sha256" --quiet 2>/dev/null; then
      echo "[DEBUG] Checksum verification: PASSED"
    else
      echo "[WARN] Checksum verification: FAILED (scripts may have been modified)" >&2
    fi
  fi

  if [[ $errors -gt 0 ]]; then
    echo "[DEBUG] Validation completed with $errors error(s)"
    return 1
  fi
  echo "[DEBUG] Validation completed successfully"
  return 0
}

# ============================================
# RESOLVE COMMAND (handles aliases and plugins)
# ============================================
# Returns: "type:command:aliased_flags" where aliased_flags may be empty
resolve_command() {
  local cmd="$1"
  local original_cmd="$cmd"
  local aliased_flags=""

  # Check if it's an alias first
  if [[ -n "${CMD_ALIASES[$cmd]:-}" ]]; then
    local alias_val="${CMD_ALIASES[$cmd]}"
    # Split alias into command and flags (first word is command)
    cmd="${alias_val%% *}"
    # Check for aliased flags (stored separately for clarity)
    if [[ -n "${ALIASED_FLAGS[$original_cmd]:-}" ]]; then
      aliased_flags="${ALIASED_FLAGS[$original_cmd]}"
    elif [[ "$alias_val" == *" "* ]]; then
      # Fallback: extract flags from alias value itself
      aliased_flags="${alias_val#* }"
    fi
  fi

  # Check plugins (plugins override core commands)
  if [[ -n "${PLUGIN_MAP[$cmd]:-}" ]]; then
    echo "plugin:${PLUGIN_MAP[$cmd]}:$aliased_flags"
    return 0
  fi

  # Check core commands
  if [[ -n "${CMD_MAP[$cmd]:-}" ]]; then
    echo "core:$cmd:$aliased_flags"
    return 0
  fi

  # Not found
  return 1
}

# ============================================
# HELP DISPLAY
# ============================================
show_main_help() {
  echo "CLEO v$(cat "$CLEO_HOME/VERSION" 2>/dev/null || echo "unknown")"
  echo ""
  echo "Usage: cleo <command> [options]"
  echo "       cleo help <command>    Show detailed command help"
  echo ""
  echo "Commands:"
  for cmd in init add update complete delete uncancel reopen list find focus session archive unarchive validate stats backup restore export migrate reorganize-backups log dash next labels deps blockers phases phase exists history show analyze config commands roadmap; do
    printf "  %-14s %s\n" "$cmd" "${CMD_DESC[$cmd]}"
  done
  echo "  version        Show version"
  echo "  help           Show this help"

  # Show aliases
  echo ""
  echo "Aliases:"
  printf "  "
  local alias_list=""
  for alias in "${!CMD_ALIASES[@]}"; do
    alias_list+="$alias->${CMD_ALIASES[$alias]}  "
  done
  echo "$alias_list"

  # Show plugins if any
  if [[ ${#PLUGIN_MAP[@]} -gt 0 ]]; then
    echo ""
    echo "Plugins:"
    for plugin in "${!PLUGIN_MAP[@]}"; do
      printf "  %-14s %s\n" "$plugin" "${PLUGIN_DESC[$plugin]:-Custom plugin}"
    done
  fi

  echo ""
  echo "Run 'cleo help <command>' for detailed options."
  echo ""
  echo "Examples:"
  echo "  cleo init my-project"
  echo "  cleo add \"Implement feature\""
  echo "  cleo ls                        # alias for list"
  echo "  cleo done T001                 # alias for complete"
  echo "  cleo focus set T001"
  echo ""
  echo "Debug:"
  echo "  CLEO_DEBUG=1 cleo <cmd>        # Enable debug via env var"
  echo "  Set cli.debug.enabled=true     # Enable debug via config"
  echo "  cleo --validate                # Validate CLI configuration"
  echo ""
  echo "Custom Aliases:"
  echo "  Add custom aliases in ~/.cleo/config.json under cli.aliases"
  echo "  Example: {\"cli\": {\"aliases\": {\"t\": \"list\", \"a\": \"add\"}}}"
}

# ============================================
# MAIN EXECUTION
# ============================================

# Load config, check plugin settings, and discover plugins
load_config_aliases
check_plugin_config
discover_plugins

# Handle special debug commands
if [[ "${1:-}" == "--validate" ]] || [[ "${1:-}" == "--debug" ]]; then
  DEBUG=1
  debug_validate
  exit $?
fi

if [[ "${1:-}" == "--list-commands" ]]; then
  echo "Core commands:"
  for cmd in "${!CMD_MAP[@]}"; do echo "  $cmd"; done
  echo "Aliases:"
  for alias in "${!CMD_ALIASES[@]}"; do echo "  $alias -> ${CMD_ALIASES[$alias]}"; done
  if [[ ${#PLUGIN_MAP[@]} -gt 0 ]]; then
    echo "Plugins:"
    for plugin in "${!PLUGIN_MAP[@]}"; do echo "  $plugin"; done
  fi
  exit 0
fi

CMD="${1:-help}"

# Debug timing
[[ "$DEBUG" == "1" ]] && START_TIME=$(date +%s%N)

case "$CMD" in
  version|--version|-v)
    cat "$CLEO_HOME/VERSION" 2>/dev/null || echo "unknown"
    ;;
  help|--help|-h)
    if [[ -n "${2:-}" ]]; then
      resolved=$(resolve_command "$2")
      if [[ $? -eq 0 ]]; then
        # Parse resolved format: type:command:aliased_flags
        IFS=':' read -r resolved_type resolved_cmd resolved_flags <<< "$resolved"
        if [[ "$resolved_type" == "plugin" ]]; then
          bash "$resolved_cmd" --help
        else
          bash "$SCRIPT_DIR/${CMD_MAP[$resolved_cmd]}" --help
        fi
      else
        echo "Unknown command: $2"
        echo "Run 'cleo help' for available commands."
        exit 1
      fi
    else
      show_main_help
    fi
    ;;
  *)
    resolved=$(resolve_command "$CMD")
    if [[ $? -eq 0 ]]; then
      shift
      # Parse resolved format: type:command:aliased_flags
      IFS=':' read -r resolved_type resolved_cmd resolved_flags <<< "$resolved"

      # Check for project version warnings (fast, non-blocking)
      check_project_version "$resolved_cmd"

      if [[ "$resolved_type" == "plugin" ]]; then
        [[ "$DEBUG" == "1" ]] && echo "[DEBUG] Executing plugin: $resolved_cmd" >&2
        # shellcheck disable=SC2086
        exec bash "$resolved_cmd" $resolved_flags "$@"
      else
        script="$SCRIPT_DIR/${CMD_MAP[$resolved_cmd]}"
        [[ "$DEBUG" == "1" ]] && echo "[DEBUG] Executing: $script $resolved_flags" >&2
        # Inject aliased flags before user arguments
        # shellcheck disable=SC2086
        exec bash "$script" $resolved_flags "$@"
      fi
    else
      echo "Unknown command: $CMD"
      echo ""

      # Collect suggestions using multiple matching strategies
      declare -a suggestions=()
      cmd_lower="${CMD,,}"
      first_char="${cmd_lower:0:1}"

      # Strategy 1: Substring match (original)
      for cmd in "${!CMD_MAP[@]}" "${!CMD_ALIASES[@]}"; do
        if [[ "$cmd" == *"$CMD"* ]] || [[ "$CMD" == *"$cmd"* ]]; then
          suggestions+=("$cmd")
        fi
      done

      # Strategy 2: Common prefix match (e.g., "fo" matches "focus")
      if [[ ${#suggestions[@]} -eq 0 ]]; then
        for cmd in "${!CMD_MAP[@]}" "${!CMD_ALIASES[@]}"; do
          if [[ "$cmd" == "$cmd_lower"* ]] || [[ "${cmd,,}" == "$cmd_lower"* ]]; then
            suggestions+=("$cmd")
          fi
        done
      fi

      # Strategy 3: First letter match
      if [[ ${#suggestions[@]} -eq 0 && -n "$first_char" ]]; then
        for cmd in "${!CMD_MAP[@]}" "${!CMD_ALIASES[@]}"; do
          if [[ "${cmd:0:1}" == "$first_char" ]]; then
            suggestions+=("$cmd")
          fi
        done
      fi

      # Strategy 4: Show common commands if still no matches
      if [[ ${#suggestions[@]} -eq 0 ]]; then
        suggestions=("list" "add" "show" "update" "complete" "focus" "help")
      fi

      # Also check plugins
      [[ ${#PLUGIN_MAP[@]} -gt 0 ]] && for plugin in "${!PLUGIN_MAP[@]}"; do
        if [[ "$plugin" == *"$CMD"* ]] || [[ "$CMD" == *"$plugin"* ]] || [[ "${plugin:0:1}" == "$first_char" ]]; then
          suggestions+=("$plugin")
        fi
      done

      # Display suggestions (deduplicated)
      if [[ ${#suggestions[@]} -gt 0 ]]; then
        echo "Did you mean one of these?"
        printf '%s\n' "${suggestions[@]}" | sort -u | while read -r s; do
          echo "  $s"
        done
      fi

      echo ""
      echo "Run 'cleo help' for available commands."
      exit 1
    fi
    ;;
esac

# Debug timing output
if [[ "$DEBUG" == "1" ]] && [[ -n "${START_TIME:-}" ]]; then
  END_TIME=$(date +%s%N)
  ELAPSED=$(( (END_TIME - START_TIME) / 1000000 ))
  echo "[DEBUG] Execution time: ${ELAPSED}ms" >&2
fi
WRAPPER_EOF

chmod +x "$INSTALL_DIR/scripts/cleo"

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

# Generate checksums for integrity verification (T170 - cross-platform)
log_step "Generating script checksums..."
SHA_CMD=""
if command -v sha256sum &>/dev/null; then
  SHA_CMD="sha256sum"
elif command -v shasum &>/dev/null; then
  SHA_CMD="shasum -a 256"
fi

if [[ -n "$SHA_CMD" ]]; then
  (cd "$INSTALL_DIR/scripts" && $SHA_CMD *.sh > "$INSTALL_DIR/checksums.sha256" 2>/dev/null)
  log_info "Checksums generated: $INSTALL_DIR/checksums.sha256"
else
  log_warn "sha256sum/shasum not found - skipping checksum generation"
fi

# ============================================
# PLUGINS DIRECTORY
# ============================================
log_step "Setting up plugins directory..."
mkdir -p "$INSTALL_DIR/plugins"

# Create example plugin template
cat > "$INSTALL_DIR/plugins/README.md" << 'PLUGIN_README'
# CLEO Plugins

Place custom command scripts here. Each `.sh` file becomes a command.

## Plugin Format

```bash
#!/usr/bin/env bash
###PLUGIN
# description: Brief description of what this plugin does
###END

# Your script implementation here
echo "Hello from my plugin!"
```

## Usage

1. Create a script: `~/.cleo/plugins/my-command.sh`
2. Make it executable: `chmod +x ~/.cleo/plugins/my-command.sh`
3. Run it: `cleo my-command`

## Project-Local Plugins

You can also place plugins in `./.cleo/plugins/` for project-specific commands.
PLUGIN_README
log_info "Plugins directory ready: $INSTALL_DIR/plugins"

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

# Copy all documentation files from docs/ including subdirectories
if [[ -d "$SCRIPT_DIR/docs" ]]; then
  # Copy root-level markdown files
  for doc in "$SCRIPT_DIR/docs/"*.md; do
    if [[ -f "$doc" ]]; then
      cp "$doc" "$INSTALL_DIR/docs/"
    fi
  done

  # Copy subdirectories (guides, getting-started, reference, commands)
  for subdir in guides getting-started reference commands; do
    if [[ -d "$SCRIPT_DIR/docs/$subdir" ]]; then
      mkdir -p "$INSTALL_DIR/docs/$subdir"
      cp -r "$SCRIPT_DIR/docs/$subdir/"* "$INSTALL_DIR/docs/$subdir/" 2>/dev/null || true
    fi
  done

  # Count total files installed
  total_docs=$(find "$INSTALL_DIR/docs" -name "*.md" 2>/dev/null | wc -l)
  log_info "Documentation installed ($total_docs files in 5 directories)"
else
  log_warn "Documentation directory not found at $SCRIPT_DIR/docs"
fi

# ============================================
# TAB COMPLETION SCRIPTS (T638)
# ============================================
log_step "Installing tab completion scripts..."

if [[ -d "$SCRIPT_DIR/completions" ]]; then
  mkdir -p "$INSTALL_DIR/completions"
  cp -r "$SCRIPT_DIR/completions/"* "$INSTALL_DIR/completions/"
  log_info "Tab completions installed: $INSTALL_DIR/completions"
else
  log_warn "Completions directory not found at $SCRIPT_DIR/completions"
fi

# ============================================
# CREATE SYMLINKS IN STANDARD LOCATIONS
# ============================================
log_step "Creating symlinks for global access..."

# Create ~/.local/bin if it doesn't exist (XDG standard for user binaries)
LOCAL_BIN="$HOME/.local/bin"
mkdir -p "$LOCAL_BIN"

# Create symlink for 'cleo' command (PRIMARY)
SYMLINK_TARGET="$LOCAL_BIN/cleo"
if [[ -L "$SYMLINK_TARGET" ]] || [[ -e "$SYMLINK_TARGET" ]]; then
  rm -f "$SYMLINK_TARGET"
fi
ln -sf "$INSTALL_DIR/scripts/cleo" "$SYMLINK_TARGET"
log_info "Created symlink: $SYMLINK_TARGET"

# Create 'ct' shortcut symlink
CT_SYMLINK="$LOCAL_BIN/ct"
if [[ -L "$CT_SYMLINK" ]] || [[ -e "$CT_SYMLINK" ]]; then
  rm -f "$CT_SYMLINK"
fi
ln -sf "$INSTALL_DIR/scripts/cleo" "$CT_SYMLINK"
log_info "Created shortcut: $CT_SYMLINK"

# Remove legacy 'claude-todo' symlink if exists (TRUE CLEAN BREAK)
LEGACY_SYMLINK="$LOCAL_BIN/claude-todo"
if [[ -L "$LEGACY_SYMLINK" ]] || [[ -e "$LEGACY_SYMLINK" ]]; then
  rm -f "$LEGACY_SYMLINK"
  log_info "Removed legacy symlink: $LEGACY_SYMLINK"
fi

# ============================================
# CONFIGURE PATH
# ============================================
log_step "Configuring shell PATH..."

# Ensure ~/.local/bin is in PATH (standard XDG location)
PATH_EXPORT="export PATH=\"\$HOME/.local/bin:\$PATH:$INSTALL_DIR/scripts\""
PATH_MARKER="# CLEO PATH"
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

# Check if PATH already configured (check both old and new)
if grep -q "cleo\|claude-todo" "$SHELL_CONFIG" 2>/dev/null; then
  log_info "PATH already configured in $SHELL_CONFIG"
else
  # Add PATH export to shell config
  echo "" >> "$SHELL_CONFIG"
  echo "$PATH_MARKER" >> "$SHELL_CONFIG"
  echo "$PATH_EXPORT" >> "$SHELL_CONFIG"
  log_info "Added PATH to $SHELL_CONFIG"
fi

# ============================================
# INJECT CLEO REFERENCE TO GLOBAL ~/.claude/CLAUDE.md
# ============================================
# Note: We inject a reference to ~/.cleo/docs/TODO_Task_Management.md
# NOT a copy. Single source of truth is in ~/.cleo/docs/
if [[ -d "$HOME/.claude" ]]; then
  log_step "Configuring global Claude Code integration..."
  CLAUDE_MD="$HOME/.claude/CLAUDE.md"
  CLEO_DOCS_REF="@~/.cleo/docs/TODO_Task_Management.md"

  # Remove legacy duplicate file if it exists (cleanup from older versions)
  if [[ -f "$HOME/.claude/TODO_Task_Management.md" ]]; then
    rm -f "$HOME/.claude/TODO_Task_Management.md"
    log_info "Removed legacy duplicate: ~/.claude/TODO_Task_Management.md"
  fi

  # Inject reference to CLAUDE.md if not already present
  if [[ -f "$CLAUDE_MD" ]]; then
    # Check for both old relative and new absolute references
    if grep -q "@.*TODO_Task_Management.md" "$CLAUDE_MD" 2>/dev/null; then
      # Update old relative reference to new absolute reference
      if grep -q "@TODO_Task_Management.md" "$CLAUDE_MD" 2>/dev/null && \
         ! grep -q "@~/.cleo/docs/TODO_Task_Management.md" "$CLAUDE_MD" 2>/dev/null; then
        sed -i "s|@TODO_Task_Management.md|$CLEO_DOCS_REF|g" "$CLAUDE_MD"
        log_info "Updated reference to $CLEO_DOCS_REF in $CLAUDE_MD"
      else
        log_info "CLEO reference already in $CLAUDE_MD"
      fi
    else
      # Add new reference
      echo "" >> "$CLAUDE_MD"
      echo "# Task Management" >> "$CLAUDE_MD"
      echo "$CLEO_DOCS_REF" >> "$CLAUDE_MD"
      log_info "Added $CLEO_DOCS_REF reference to $CLAUDE_MD"
    fi
  else
    log_warn "No CLAUDE.md found at $CLAUDE_MD - skipping reference injection"
  fi
  # DEPRECATION WARNING (v0.50.x → v0.51.0)
  echo ""
  echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${YELLOW}DEPRECATION NOTICE:${NC}"
  echo "  Automatic agent setup will be removed in v0.52.0"
  echo ""
  echo "  Please run: ${GREEN}cleo setup-agents${NC}"
  echo "  This command provides better control and supports multiple agent CLIs"
  echo ""
  echo "  What's changing:"
  echo "    • v0.50.x: Automatic setup (current) + deprecation warning"
  echo "    • v0.51.0: Manual setup required via 'cleo setup-agents'"
  echo "    • v0.52.0: Automatic agent setup code removed"
  echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
else
  log_warn "~/.claude directory not found - skipping Task Management docs install"
fi

# ============================================
# CONFIGURE ALIASES
# ============================================
log_step "Configuring convenience aliases..."

ALIAS_MARKER="# CLEO ALIASES"

# Check if aliases already configured
if grep -q "$ALIAS_MARKER" "$SHELL_CONFIG" 2>/dev/null; then
  log_info "Aliases already configured in $SHELL_CONFIG"
else
  # Add aliases to shell config
  echo "" >> "$SHELL_CONFIG"
  echo "$ALIAS_MARKER" >> "$SHELL_CONFIG"
  if [[ "$SHELL_NAME" == "fish" ]]; then
    # Fish shell alias syntax
    echo "alias ct='cleo'" >> "$SHELL_CONFIG"
    echo "alias ct-add='cleo add'" >> "$SHELL_CONFIG"
    echo "alias ct-list='cleo list'" >> "$SHELL_CONFIG"
    echo "alias ct-done='cleo complete'" >> "$SHELL_CONFIG"
    echo "alias ct-focus='cleo focus'" >> "$SHELL_CONFIG"
  else
    # Bash/Zsh alias syntax
    echo "alias ct='cleo'" >> "$SHELL_CONFIG"
    echo "alias ct-add='cleo add'" >> "$SHELL_CONFIG"
    echo "alias ct-list='cleo list'" >> "$SHELL_CONFIG"
    echo "alias ct-done='cleo complete'" >> "$SHELL_CONFIG"
    echo "alias ct-focus='cleo focus'" >> "$SHELL_CONFIG"
  fi
  log_info "Added aliases to $SHELL_CONFIG"
fi

# ============================================
# GLOBAL CONFIG INITIALIZATION
# ============================================
log_step "Initializing global configuration..."

GLOBAL_CONFIG_FILE="$INSTALL_DIR/config.json"
GLOBAL_CONFIG_TEMPLATE="$INSTALL_DIR/templates/global-config.template.json"

if [[ ! -f "$GLOBAL_CONFIG_FILE" ]]; then
  if [[ -f "$GLOBAL_CONFIG_TEMPLATE" ]]; then
    cp "$GLOBAL_CONFIG_TEMPLATE" "$GLOBAL_CONFIG_FILE"
    log_info "Created global config: $GLOBAL_CONFIG_FILE"
  else
    log_warn "Global config template not found, skipping"
  fi
else
  log_info "Global config already exists: $GLOBAL_CONFIG_FILE"
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
echo "Symlinks:     $LOCAL_BIN/cleo (primary)"
echo "              $LOCAL_BIN/ct (shortcut)"
echo "Shell config: $SHELL_CONFIG"
echo ""

# Check if ~/.local/bin is already in PATH
if echo "$PATH" | grep -q "$LOCAL_BIN"; then
  echo -e "${GREEN}✓ Ready to use immediately!${NC}"
else
  echo -e "${YELLOW}To activate now, run:${NC}"
  echo ""
  echo "  source $SHELL_CONFIG"
  echo ""
  echo "Or open a new terminal."
fi
echo ""
echo "Usage:"
echo "  cd your-project"
echo "  cleo init"
echo ""
echo "Verify installation:"
echo "  cleo version"
echo "  ct version          # shortcut"
echo ""

# Show migration info if legacy detected
if [[ -d "$LEGACY_INSTALL_DIR" ]]; then
  echo -e "${YELLOW}Migration Required:${NC}"
  echo "  cleo claude-migrate --global    # Migrate ~/.claude-todo → ~/.cleo"
  echo "  cleo claude-migrate --project   # Migrate .claude/ → .cleo/"
  echo ""
fi

echo "Tab Completion (optional):"
echo "  Bash: Add to ~/.bashrc:"
echo "    source ~/.cleo/completions/bash-completion.sh"
echo ""
echo "  Zsh: Add to ~/.zshrc:"
echo "    fpath=(~/.cleo/completions \$fpath)"
echo "    autoload -Uz compinit && compinit"
echo ""
