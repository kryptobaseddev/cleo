# CLEO Multi-File LLM Agent Instruction Injection System - Design v2.0

**Version:** 2.0.0
**Date:** 2026-01-04
**Status:** Implementation-Ready Specification
**Parent Task:** T1384

---

## Document Control

**Version History:**
- v1.0 (implicit): Initial CLAUDE.md-only injection via `init --update-claude-md`
- v1.1 (2026-01-04): Added global install concept, C+B hybrid approach
- v1.2 (2026-01-04): Added usage compliance section, new commands
- **v2.0 (2026-01-04):** Research-driven design with @ syntax, OS detection, usage metrics

**Research Foundations:**
- [T1425 Research](.cleo/research/T1425-at-syntax-research.md): @ syntax standardization
- [T1426 Research](.cleo/research/T1426-os-detection-research.md): OS-specific paths
- [T1427 Research](.cleo/research/T1427-usage-metrics-analysis.md): Feature adoption metrics

---

## Executive Summary

CLEO v2.0 injection system targets **BOTH** CLAUDE.md and AGENTS.md for maximum multi-agent compatibility. Uses **single @ reference** (`@~/.cleo/docs/TODO_Task_Management.md`) that works across Claude Code, Codex CLI, and Gemini CLI without modification. Implements **global install** (`cleo install --global`) with WSL2 requirement for Windows, following industry pattern. Enhances AGENT-INJECTION.md with **3 new sections** based on usage metrics: File Attachment Discipline, Verification Protocol, Strategic Analysis Workflows.

**Implementation Impact:**
- T1395: `lib/injection.sh` shared library
- T1396: Extend `init` command for multi-file injection
- T1397: Extend `upgrade` command for injection updates
- T1398: Extend `validate` command for injection checks
- T1428: New `cleo install --global` command
- T1429: New `cleo doctor` command

---

## Part 0: Global Install Architecture (T1426 Integration)

### 0.1 Universal Path Strategy

**Decision:** Use `~/.cleo/` for ALL platforms (Linux, macOS, WSL2)

**Rationale:**
- ALL major agents use `~/.{name}/` pattern (Claude ~/.claude/, Codex ~/.codex/, Gemini ~/.gemini/)
- Tilde expansion works identically on Linux, macOS, WSL2
- No complex OS-specific path logic needed
- Proven pattern across industry

**Implementation:**
```bash
GLOBAL_CLEO_DIR="$HOME/.cleo"
GLOBAL_DOCS_DIR="$GLOBAL_CLEO_DIR/docs"
GLOBAL_TEMPLATES_DIR="$GLOBAL_CLEO_DIR/templates"
```

### 0.2 OS Detection Strategy

**Simple uname-based detection:**
```bash
#!/usr/bin/env bash

detect_platform() {
    case "$(uname -s)" in
        Darwin*)
            echo "macos"
            ;;
        Linux*)
            # Check for WSL
            if grep -qEi "(Microsoft|WSL)" /proc/version 2>/dev/null; then
                echo "wsl"
            else
                echo "linux"
            fi
            ;;
        *)
            echo "unsupported"
            ;;
    esac
}

PLATFORM=$(detect_platform)

if [[ "$PLATFORM" == "unsupported" ]]; then
    echo "ERROR: Unsupported platform. CLEO requires Linux, macOS, or WSL2."
    echo "Windows users: Install WSL2 and run CLEO from within WSL."
    exit 1
fi
```

**Why This Works:**
- Simple, maintainable (15 lines)
- Matches Claude Code and Codex CLI patterns
- No Windows native support complexity
- Clear error messaging guides Windows users to WSL2

### 0.3 Windows Strategy: REQUIRE WSL2

**Decision:** Follow Claude/Codex pattern - REQUIRE WSL2, no native Windows support

**Rationale:**
- Claude Code and Codex CLI both require WSL2
- Gemini is ONLY agent with native Windows support
- Native Windows adds significant complexity (path handling, PowerShell vs Bash, %USERPROFILE% vs ~/)
- WSL2 provides full Linux compatibility without edge cases

**Documentation Template:**
```markdown
## Windows Installation

CLEO requires WSL2 (Windows Subsystem for Linux 2) on Windows.

### Quick Start:
1. Open PowerShell as Administrator:
   ```powershell
   wsl --install
   ```
2. Restart your computer
3. Open Ubuntu from Start menu
4. Install CLEO:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/user/cleo/main/install.sh | bash
   ```

**IMPORTANT:**
- Install CLEO within WSL2, NOT on native Windows
- Config files MUST be in Linux filesystem (~/.cleo/), NOT Windows paths (/mnt/c/...)
- For best performance, keep project files in WSL2 filesystem
```

### 0.4 update install.sh Implementation Checklist

**Required Changes to install.sh:**
```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Add platform detection (top of file, after shebang)
detect_platform() {
    # ... implementation from 0.2 ...
}

PLATFORM=$(detect_platform)

# Exit if unsupported (with helpful message)
if [[ "$PLATFORM" == "unsupported" ]]; then
    cat <<EOF
ERROR: Unsupported platform detected.

CLEO requires one of the following:
  - Linux (any modern distribution)
  - macOS 10.15+ (Catalina or newer)
  - Windows with WSL2 (Windows Subsystem for Linux 2)

Windows users: Install WSL2 first:
  1. Open PowerShell as Administrator
  2. Run: wsl --install
  3. Restart your computer
  4. Open Ubuntu from Start menu
  5. Re-run this installer from within WSL2

For more information, see: https://docs.microsoft.com/en-us/windows/wsl/install
EOF
    exit 1
fi

# 2. Continue with existing install logic...
# (rest of install.sh unchanged - ~/.cleo/ works universally)
```

---

## Part 1: Multi-File Injection Strategy (T1425 Integration)

### 1.1 Target Files: DUAL Injection

**Decision:** Inject into BOTH CLAUDE.md AND AGENTS.md

**Rationale (from T1425 research):**
- **CLAUDE.md:** Claude Code native (cannot configure to use different filename)
- **AGENTS.md:** Universal standard (60k+ repos, backed by Google/OpenAI/Factory/Sourcegraph/Cursor)
- **GEMINI.md:** NOT targeted (users can configure Gemini to use AGENTS.md via settings.json)
- **Dual strategy:** Maximizes compatibility without N-file complexity

**Implementation:**
```bash
# lib/injection.sh
TARGET_FILES=("CLAUDE.md" "AGENTS.md")

inject_all_files() {
    local project_root="$1"
    for file in "${TARGET_FILES[@]}"; do
        inject_to_file "$project_root/$file"
    done
}
```

### 1.2 @ Syntax: Single Reference Strategy

**Decision:** Use inline @ reference, NOT @import

**Format:**
```markdown
## Task Management (cleo)

Use `ct` (alias for `cleo`) for all task operations.
Full docs: @~/.cleo/docs/TODO_Task_Management.md
```

**Rationale:**
- Works across Claude Code, Codex CLI, Gemini CLI without modification
- **Avoids context bloat:** Inline @ loads content on-demand, @import embeds on every conversation start
- **Absolute path** (~/.cleo/docs/) ensures reliability
- **Future-proof:** @ syntax becoming universal standard

**Anti-Pattern (DO NOT USE):**
```markdown
<!-- ❌ WRONG: @import embeds entire file on every conversation -->
@~/.cleo/docs/TODO_Task_Management.md

<!-- ❌ WRONG: Relative path may fail depending on cwd -->
@../docs/TODO_Task_Management.md

<!-- ✅ CORRECT: Inline @ reference with absolute path -->
Full docs: @~/.cleo/docs/TODO_Task_Management.md
```

### 1.3 Marker Format: Consistent Across Files

**Markers:**
```html
<!-- CLEO:START v0.50.1 -->
[Injection content here]
<!-- CLEO:END -->
```

**Properties:**
- Same markers in both CLAUDE.md and AGENTS.md
- Version number in START marker for debugging
- Content IDENTICAL across files (single source of truth)
- Regex pattern: `<!-- CLEO:START.*?-->.*?<!-- CLEO:END -->` (dotall mode)

### 1.4 Injection Content: Condensed + @ Reference

**Template (templates/CLEO-INJECTION.md):**
```markdown
<!-- CLEO:START v{{VERSION}} -->
## Task Management (cleo)

Use `ct` (alias for `cleo`) for all task operations. Full docs: @~/.cleo/docs/TODO_Task_Management.md

### CRITICAL: Error Handling
**NEVER ignore exit codes. Failed commands mean tasks were NOT created/updated.**

[... condensed excerpt continues ...]

Full documentation: @~/.cleo/docs/TODO_Task_Management.md
<!-- CLEO:END -->
```

**Design Principles:**
- **Hybrid approach:** Condensed critical info (error handling, essential commands) + @ reference to full docs
- **150 line limit:** Keep injection small to avoid context bloat
- **@ reference appears 2x:** At start and end for discoverability
- **Version marker:** For troubleshooting injection version mismatches

---

## Part 2: Global Documentation Strategy (T1428 Implementation)

### 2.1 Directory Structure

```
~/.cleo/
├── docs/
│   ├── TODO_Task_Management.md       # Full command reference (from user global CLAUDE.md)
│   ├── DOCUMENTATION-MAINTENANCE.md  # Doc maintenance guide
│   ├── specs/
│   │   ├── LIBRARY-ARCHITECTURE-SPEC.md
│   │   └── ... other specs ...
│   └── commands/
│       ├── session.md
│       ├── focus.md
│       └── ... command-specific docs ...
├── templates/
│   ├── CLEO-INJECTION.md            # Injection template for CLAUDE.md/AGENTS.md
│   ├── AGENT-INJECTION.md           # Enhanced LLM agent-specific guidance
│   └── CLAUDE.md.template           # Blank project starter
└── .cleo-version                     # Installed version marker
```

### 2.2 `cleo install --global` Command

**Purpose:** Install CLEO documentation to `~/.cleo/docs/` for universal @ reference access

**Usage:**
```bash
# Install/update global docs
cleo install --global

# Check what would be installed (dry-run)
cleo install --global --dry-run

# Force reinstall (overwrite existing)
cleo install --global --force
```

**Implementation (scripts/install-global.sh):**
```bash
#!/usr/bin/env bash
set -euo pipefail

# Source shared library
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"

GLOBAL_CLEO_DIR="$HOME/.cleo"
GLOBAL_DOCS_DIR="$GLOBAL_CLEO_DIR/docs"
GLOBAL_TEMPLATES_DIR="$GLOBAL_CLEO_DIR/templates"
LOCAL_DOCS_DIR="$SCRIPT_DIR/../docs"
LOCAL_TEMPLATES_DIR="$SCRIPT_DIR/../templates"

# Parse flags
DRY_RUN=false
FORCE=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        --force) FORCE=true; shift ;;
        *) echo "Unknown flag: $1"; exit 1 ;;
    esac
done

# Check if already installed
if [[ -d "$GLOBAL_DOCS_DIR" ]] && [[ "$FORCE" != true ]]; then
    echo "Global docs already installed at $GLOBAL_DOCS_DIR"
    echo "Use --force to reinstall"
    exit 0
fi

if [[ "$DRY_RUN" == true ]]; then
    echo "[DRY-RUN] Would install:"
    echo "  $GLOBAL_DOCS_DIR/"
    echo "  $GLOBAL_TEMPLATES_DIR/"
    exit 0
fi

# Create directories
mkdir -p "$GLOBAL_DOCS_DIR"
mkdir -p "$GLOBAL_TEMPLATES_DIR"

# Copy docs (preserving structure)
cp -r "$LOCAL_DOCS_DIR/"* "$GLOBAL_DOCS_DIR/"

# Copy templates
cp -r "$LOCAL_TEMPLATES_DIR/"* "$GLOBAL_TEMPLATES_DIR/"

# Write version marker
echo "$(get_version)" > "$GLOBAL_CLEO_DIR/.cleo-version"

echo "✅ Global install complete!"
echo ""
echo "Installed to:"
echo "  📚 Docs: $GLOBAL_DOCS_DIR"
echo "  📄 Templates: $GLOBAL_TEMPLATES_DIR"
echo ""
echo "You can now reference CLEO docs from any project:"
echo "  @~/.cleo/docs/TODO_Task_Management.md"
```

### 2.3 `cleo doctor` Command

**Purpose:** Validate global install, check for version mismatches, verify @ reference accessibility

**Usage:**
```bash
# Run full diagnostics
cleo doctor

# Check only global install
cleo doctor --global

# JSON output for scripting
cleo doctor --format json
```

**Checks:**
1. **Global install exists:** `~/.cleo/docs/` present
2. **Version match:** `~/.cleo/.cleo-version` matches installed `cleo` version
3. **File accessibility:** TODO_Task_Management.md readable
4. **Project injection:** CLAUDE.md/AGENTS.md markers present
5. **Injection version:** Marker version matches installed version
6. **@ reference test:** Can agents read @~/.cleo/docs/TODO_Task_Management.md?

**Output Example:**
```
CLEO Doctor Report
==================

✅ Global Install
   Location: /home/user/.cleo
   Version: 0.50.1
   Docs: 15 files, 247 KB
   Templates: 3 files, 42 KB

✅ Project Injection
   CLAUDE.md: Present, v0.50.1
   AGENTS.md: Present, v0.50.1

⚠️ Warnings
   - Global docs version (0.49.0) older than CLI (0.50.1)
     Run: cleo install --global --force

📊 Summary: 2 checks passed, 0 failed, 1 warning
```

---

## Part 3: AGENT-INJECTION.md Enhancements (T1427 Integration)

### 3.1 Usage Metrics Findings (from T1427)

**Current State:**
- ✅ STRONG: 100% descriptions, 76% labels, 84% hierarchy
- ⚠️ UNDERUTILIZED: 13% file attachments (target: 40%)
- ⚠️ UNDERUTILIZED: 31% verification gates (target: 70%)
- ⚠️ NOT USED: 0% analysis commands (target: 20%)

**Root Cause:** AGENT-INJECTION.md lacks guidance on advanced features

### 3.2 New Section 1: File Attachment Discipline

**Add to AGENT-INJECTION.md:**
```markdown
## File Attachment Discipline

Link tasks to their deliverables using `--files` flag:

### When to Use --files

**Specs:**
```bash
ct add "Write API spec" \
  --files docs/specs/api-spec.md \
  --phase setup \
  --priority high
```

**Implementations:**
```bash
ct add "Implement API" \
  --files lib/api.sh \
  --depends T001 \
  --phase core
```

**Tests:**
```bash
ct add "Test API endpoints" \
  --files tests/unit/api.bats \
  --depends T002 \
  --phase testing
```

**Documentation:**
```bash
ct add "Document API usage" \
  --files docs/api-usage.md \
  --depends T002 \
  --phase polish
```

### Benefits of --files

- **Traceability:** `ct show T001` displays related files
- **Context:** No need to ask "which file for this task?"
- **Knowledge graph:** Builds natural project documentation
- **Handoff:** New agents understand what files matter

### Multiple Files

```bash
ct add "Refactor authentication" \
  --files lib/auth.sh,tests/unit/auth.bats,docs/auth.md \
  --priority high
```

**Target:** 40-50% of tasks should have file attachments.
```

### 3.3 New Section 2: Task Verification Protocol

**Add to AGENT-INJECTION.md:**
```markdown
## Task Verification Protocol

Use verification gates to ensure quality before marking tasks done.

### Verification Workflow

```bash
# 1. Complete implementation
ct complete T001
# (Sets verification.gates.implemented = true automatically)

# 2. Run tests
pytest tests/
ct verify T001 --gate testsPassed

# 3. Run security scan
bandit -r lib/
ct verify T001 --gate securityPassed

# 4. Update documentation
# ... doc updates ...
ct verify T001 --gate documented

# 5. All gates passed → verification.passed = true
ct verify T001 --all
```

### Verification Gates

| Gate | Purpose | Example Command |
|------|---------|-----------------|
| `implemented` | Code written (auto-set by complete) | N/A (automatic) |
| `testsPassed` | Tests pass | `pytest && ct verify T001 --gate testsPassed` |
| `qaPassed` | QA review done | `ct verify T001 --gate qaPassed` |
| `securityPassed` | Security scan clear | `bandit -r lib/ && ct verify T001 --gate securityPassed` |
| `documented` | Docs complete | `ct verify T001 --gate documented` |

### When Verification is REQUIRED

- Subtasks that contribute to epic completion
- Tasks with dependent children
- Before parent auto-complete
- Security-sensitive implementations
- Public API changes

### Check Verification Status

```bash
ct show T001 --verification
ct list --verification-status pending
```

**Target:** 70-80% of tasks should use verification gates.
```

### 3.4 New Section 3: Strategic Analysis Workflows

**Add to AGENT-INJECTION.md:**
```markdown
## Strategic Analysis Workflows

Use analysis commands for project insights and decision-making.

### Session Start Pattern

```bash
ct dash                  # Project overview: status, progress, blockers
ct analyze --auto-focus  # Auto-prioritize and set focus to top task
ct focus show            # Confirm focus
```

**Why:** Automated prioritization based on leverage scoring (impact/effort).

### When Stuck/Blocked Pattern

```bash
ct blockers              # What's blocking progress?
ct blockers analyze      # Critical path analysis
ct deps T001             # What depends on this task?
ct chain                 # Visualize dependency chains
```

**Why:** Identify root cause of slowdowns, find alternative paths forward.

### Phase Progress Review Pattern

```bash
ct phases                # Phase progress bars
ct phases stats          # Detailed phase analytics
ct phases show core      # Tasks in specific phase
ct next --explain        # Why this task next?
```

**Why:** Understand workflow progression, identify bottlenecks, plan phase transitions.

### Command Decision Matrix

| Scenario | Command | When to Use |
|----------|---------|-------------|
| Starting work | `ct analyze --auto-focus` | Every session start |
| Progress slows | `ct blockers analyze` | When velocity drops |
| Need direction | `ct next --explain` | When uncertain what's next |
| Phase review | `ct phases stats` | Before phase transitions |
| Dependency questions | `ct deps T001` | Before modifying task with children |
| Big picture | `ct dash` | Weekly review, stakeholder updates |

**Target:** 20-30% of sessions should use analysis commands.
```

### 3.5 Enhanced Section 4: High-Priority Task Validation

**Add to AGENT-INJECTION.md:**
```markdown
## High-Priority Task Validation

High/critical priority tasks MUST have sufficient context.

### Before Creating High-Priority Tasks

**❌ AVOID: Bare high-priority tasks**
```bash
ct add "Fix critical bug" --priority critical
```

**✅ GOOD: Contextualized high-priority task**
```bash
ct add "Fix auth bypass vulnerability" \
  --priority critical \
  --labels bug,security,auth \
  --phase core \
  --notes "CVE-2024-XXXXX: Session token not validated in lib/auth.sh:45" \
  --files lib/auth.sh,tests/unit/auth.bats
```

### High-Priority Checklist

- [ ] **Labels:** At least one label for categorization
- [ ] **Context:** Dependencies OR notes explaining rationale
- [ ] **Phase:** Assigned to appropriate workflow phase
- [ ] **Files:** References to affected/relevant files (when applicable)
- [ ] **Description:** Explains WHY high/critical, not just WHAT

### Validation Command

```bash
# Check high-priority tasks for missing context
ct list --priority high --format json | jq '[.tasks[] | select((.labels == null or .labels == []) and (.depends == null or .depends == []))]'
```

**Target:** <2% of high/critical tasks should lack labels and dependencies.
```

---

## Part 4: Command Integration Strategy

### 4.1 `init` Command Extensions (T1396)

**New Behavior:**
```bash
# Create/update injection in both CLAUDE.md and AGENTS.md
cleo init --update-claude-md

# (No flag change needed - "claude-md" is historical name, actual behavior is dual injection)
```

**Implementation:**
```bash
# scripts/init.sh

# 1. Source injection library
source "$LIB_DIR/injection.sh"

# 2. Detect project root
PROJECT_ROOT=$(detect_project_root)

# 3. Inject into both files
inject_to_file "$PROJECT_ROOT/CLAUDE.md"
inject_to_file "$PROJECT_ROOT/AGENTS.md"

# 4. Validation (verify markers present)
validate_injection "$PROJECT_ROOT/CLAUDE.md"
validate_injection "$PROJECT_ROOT/AGENTS.md"
```

### 4.2 `upgrade` Command Extensions (T1397)

**New Behavior:**
```bash
# Check if injection needs update
cleo upgrade --check-injection

# Update injection to latest version
cleo upgrade --update-injection

# Full upgrade (CLI + injection + global docs)
cleo upgrade --all
```

**Implementation:**
```bash
# scripts/upgrade.sh

upgrade_injection() {
    local project_root="$1"

    # 1. Detect current injection version
    local current_version=$(get_injection_version "$project_root/CLAUDE.md")
    local latest_version=$(get_version)

    if [[ "$current_version" == "$latest_version" ]]; then
        echo "Injection already up-to-date (v$current_version)"
        return 0
    fi

    echo "Upgrading injection: v$current_version → v$latest_version"

    # 2. Update both files
    inject_to_file "$project_root/CLAUDE.md"
    inject_to_file "$project_root/AGENTS.md"

    echo "✅ Injection upgraded to v$latest_version"
}
```

### 4.3 `validate` Command Extensions (T1398)

**New Behavior:**
```bash
# Validate injection markers present
cleo validate --check-injection

# Validate injection version matches CLI version
cleo validate --check-injection-version

# Full validation (data + injection)
cleo validate --all
```

**Implementation:**
```bash
# scripts/validate.sh

validate_injection_markers() {
    local project_root="$1"
    local errors=0

    for file in "CLAUDE.md" "AGENTS.md"; do
        local filepath="$project_root/$file"

        if [[ ! -f "$filepath" ]]; then
            echo "⚠️ $file not found (optional for multi-agent support)"
            continue
        fi

        if ! grep -q "<!-- CLEO:START" "$filepath"; then
            echo "❌ $file missing CLEO:START marker"
            ((errors++))
        fi

        if ! grep -q "<!-- CLEO:END -->" "$filepath"; then
            echo "❌ $file missing CLEO:END marker"
            ((errors++))
        fi

        local version=$(get_injection_version "$filepath")
        if [[ "$version" != "$(get_version)" ]]; then
            echo "⚠️ $file injection version ($version) != CLI version ($(get_version))"
            echo "   Run: cleo upgrade --update-injection"
        fi
    done

    return $errors
}
```

---

## Part 5: Implementation Architecture (lib/injection.sh)

### 5.1 Function API Specification

**Core Functions:**
```bash
#!/usr/bin/env bash
# lib/injection.sh - Shared injection library

# Inject CLEO instructions into target file
# Args: $1 = file path (CLAUDE.md or AGENTS.md)
# Returns: 0 on success, 1 on failure
inject_to_file() {
    local target_file="$1"
    local template_content

    # 1. Load template
    template_content=$(load_injection_template)

    # 2. Replace version placeholder
    template_content=$(echo "$template_content" | sed "s/{{VERSION}}/$(get_version)/g")

    # 3. Check if markers exist
    if grep -q "<!-- CLEO:START" "$target_file"; then
        # Update existing injection
        update_injection "$target_file" "$template_content"
    else
        # Append new injection
        append_injection "$target_file" "$template_content"
    fi
}

# Load injection template from templates/CLEO-INJECTION.md
load_injection_template() {
    cat "$TEMPLATES_DIR/CLEO-INJECTION.md"
}

# Update existing injection (replace content between markers)
update_injection() {
    local file="$1"
    local content="$2"
    local temp_file="${file}.tmp"

    # Use Perl for reliable multi-line regex replacement
    perl -i.bak -0pe "s/<!-- CLEO:START.*?-->.*?<!-- CLEO:END -->/$(escape_for_regex "$content")/s" "$file"
}

# Append new injection to file
append_injection() {
    local file="$1"
    local content="$2"

    echo "" >> "$file"
    echo "$content" >> "$file"
}

# Extract injection version from file
get_injection_version() {
    local file="$1"
    grep -oP '<!-- CLEO:START v\K[0-9.]+' "$file" || echo "unknown"
}

# Validate injection markers present
validate_injection() {
    local file="$1"

    if ! grep -q "<!-- CLEO:START" "$file"; then
        echo "ERROR: Missing CLEO:START marker in $file"
        return 1
    fi

    if ! grep -q "<!-- CLEO:END -->" "$file"; then
        echo "ERROR: Missing CLEO:END marker in $file"
        return 1
    fi

    return 0
}

# Inject into all target files
inject_all_files() {
    local project_root="$1"

    for file in "CLAUDE.md" "AGENTS.md"; do
        local filepath="$project_root/$file"

        # Create file if doesn't exist
        if [[ ! -f "$filepath" ]]; then
            echo "Creating $file..."
            touch "$filepath"
        fi

        inject_to_file "$filepath"
        echo "✅ Injected into $file"
    done
}
```

### 5.2 Template Variable Substitution

**Supported Variables:**
- `{{VERSION}}` → Current CLEO version (e.g., "0.50.1")
- `{{GLOBAL_DOCS_PATH}}` → `~/.cleo/docs` (future: for custom paths)
- `{{DATE}}` → ISO 8601 date (future: for last-updated tracking)

**Implementation:**
```bash
substitute_variables() {
    local content="$1"

    content=$(echo "$content" | sed "s/{{VERSION}}/$(get_version)/g")
    content=$(echo "$content" | sed "s|{{GLOBAL_DOCS_PATH}}|~/.cleo/docs|g")
    content=$(echo "$content" | sed "s/{{DATE}}/$(date -u +%Y-%m-%dT%H:%M:%SZ)/g")

    echo "$content"
}
```

### 5.3 Error Handling & Rollback

**Atomic Operations:**
```bash
inject_to_file_safe() {
    local target_file="$1"
    local backup_file="${target_file}.backup-$(date +%s)"

    # 1. Create backup
    cp "$target_file" "$backup_file"

    # 2. Attempt injection
    if inject_to_file "$target_file"; then
        # Success - remove backup
        rm "$backup_file"
        return 0
    else
        # Failure - restore backup
        mv "$backup_file" "$target_file"
        echo "ERROR: Injection failed, restored from backup"
        return 1
    fi
}
```

---

## Part 6: Testing Strategy

### 6.1 Unit Tests (T1399)

**Test lib/injection.sh functions:**
```bats
# tests/unit/injection.bats

@test "inject_to_file creates new injection" {
    # Setup
    local test_file="/tmp/test-CLAUDE.md"
    echo "# Existing content" > "$test_file"

    # Execute
    inject_to_file "$test_file"

    # Assert
    grep -q "<!-- CLEO:START" "$test_file"
    grep -q "<!-- CLEO:END -->" "$test_file"
}

@test "inject_to_file updates existing injection" {
    # Setup with old injection
    local test_file="/tmp/test-CLAUDE.md"
    cat > "$test_file" <<EOF
# My Project
<!-- CLEO:START v0.49.0 -->
Old content here
<!-- CLEO:END -->
EOF

    # Execute
    inject_to_file "$test_file"

    # Assert version updated
    grep -q "<!-- CLEO:START v0.50.1 -->" "$test_file"
    ! grep -q "Old content here" "$test_file"
}

@test "get_injection_version extracts version correctly" {
    local test_file="/tmp/test-CLAUDE.md"
    echo "<!-- CLEO:START v0.50.1 -->" > "$test_file"

    version=$(get_injection_version "$test_file")
    [[ "$version" == "0.50.1" ]]
}
```

### 6.2 Integration Tests (T1400)

**Test multi-file injection workflow:**
```bats
# tests/integration/multi-file-injection.bats

@test "init --update-claude-md injects into both CLAUDE.md and AGENTS.md" {
    # Setup project
    local test_project="/tmp/test-project"
    mkdir -p "$test_project"
    cd "$test_project"

    # Execute
    cleo init --update-claude-md

    # Assert both files have injection
    [[ -f "CLAUDE.md" ]]
    [[ -f "AGENTS.md" ]]
    grep -q "<!-- CLEO:START" "CLAUDE.md"
    grep -q "<!-- CLEO:START" "AGENTS.md"

    # Assert content identical
    diff <(sed -n '/<!-- CLEO:START/,/<!-- CLEO:END/p' CLAUDE.md) \
         <(sed -n '/<!-- CLEO:START/,/<!-- CLEO:END/p' AGENTS.md)
}

@test "upgrade --update-injection updates both files" {
    # Setup with old version
    # ... setup code ...

    # Execute
    cleo upgrade --update-injection

    # Assert both updated
    [[ "$(get_injection_version CLAUDE.md)" == "$(get_version)" ]]
    [[ "$(get_injection_version AGENTS.md)" == "$(get_version)" ]]
}
```

### 6.3 Golden Tests (T1401)

**Test injection output format:**
```bats
# tests/golden/injection-output.bats

@test "injection output matches golden file" {
    local test_file="/tmp/test-CLAUDE.md"
    inject_to_file "$test_file"

    # Extract injection content
    local actual=$(sed -n '/<!-- CLEO:START/,/<!-- CLEO:END/p' "$test_file")

    # Compare to golden file (with version normalization)
    local golden=$(cat tests/golden/injection-expected.md | sed "s/{{VERSION}}/$(get_version)/g")

    diff <(echo "$actual") <(echo "$golden")
}
```

---

## Part 7: Rollout Plan

### Phase 1: Foundation (T1395)
- [ ] Implement `lib/injection.sh` with core functions
- [ ] Create unit tests for injection library
- [ ] Update templates/CLEO-INJECTION.md with @ reference
- [ ] Create templates/AGENT-INJECTION.md with 3 new sections

### Phase 2: Command Integration (T1396-T1398)
- [ ] Extend `init` for dual-file injection
- [ ] Extend `upgrade` for injection updates
- [ ] Extend `validate` for injection checks
- [ ] Integration tests for command workflows

### Phase 3: Global Install (T1428-T1430)
- [ ] Implement `cleo install --global`
- [ ] Implement `cleo doctor`
- [ ] Update install.sh with OS detection
- [ ] Multi-agent setup documentation

### Phase 4: Validation (T1402)
- [ ] Run full test suite
- [ ] Golden test validation
- [ ] Manual testing across Linux/macOS/WSL2
- [ ] Verify @ references work in Claude/Codex/Gemini

---

## Part 8: Success Metrics

### Adoption Targets (6 months post-v2.0)

| Metric | Baseline (T1427) | Target | Measurement |
|--------|------------------|--------|-------------|
| File attachments (--files) | 13% | 40% | Tasks with .files != [] |
| Verification gates | 31% | 70% | Tasks with .verification.passed != null |
| Analysis commands | 0% | 20% | Audit log entries for analyze/blockers/chain |
| AGENTS.md adoption | 0% (not tracked) | 80% | Projects with AGENTS.md injection |
| Global install usage | 0% (not implemented) | 60% | ~/.cleo/docs/ exists |

### Quality Metrics (maintain)

| Metric | Current | Target |
|--------|---------|--------|
| Tasks with descriptions | 100% | 100% |
| Title != description | 100% | 100% |
| Label usage | 76% | 75%+ |
| Hierarchy usage | 84% | 80%+ |

---

## Part 9: Open Questions & Future Work

### v2.1 Candidates
1. **Kimi CLI @ syntax support** - Needs testing/verification (T1425 gap)
2. **Native Windows support** - Evaluate trade-offs if user demand increases
3. **System-wide configs** - Enterprise `/etc/cleo/` if needed for managed deployments
4. **Template customization** - Allow projects to customize injection content
5. **Multi-language injection** - Support non-English AGENT-INJECTION.md

### v3.0 Candidates
1. **Plugin system** - Extensible injection for custom agent types
2. **AI-powered usage analysis** - Automated recommendations from audit logs
3. **Cross-project analytics** - Aggregate usage metrics across all CLEO projects
4. **Injection validation CI** - GitHub Action to check injection up-to-date

---

## Appendices

### Appendix A: File Manifest

**New Files:**
- `lib/injection.sh` - Shared injection library (T1395)
- `scripts/install-global.sh` - Global install command (T1428)
- `scripts/doctor.sh` - Diagnostic command (T1429)
- `templates/CLEO-INJECTION.md` - Injection template
- `templates/AGENT-INJECTION.md` - Enhanced agent guidance
- `tests/unit/injection.bats` - Unit tests (T1399)
- `tests/integration/multi-file-injection.bats` - Integration tests (T1400)
- `tests/golden/injection-output.bats` - Golden tests (T1401)

**Modified Files:**
- `scripts/init.sh` - Multi-file injection (T1396)
- `scripts/upgrade.sh` - Injection updates (T1397)
- `scripts/validate.sh` - Injection validation (T1398)
- `install.sh` - OS detection logic (T1426)

### Appendix B: Research Citations

- [T1425: @ Syntax Research](.cleo/research/T1425-at-syntax-research.md)
- [T1426: OS Detection Research](.cleo/research/T1426-os-detection-research.md)
- [T1427: Usage Metrics Analysis](.cleo/research/T1427-usage-metrics-analysis.md)

### Appendix C: Design Decisions Log

| Decision | Rationale | Alternatives Considered |
|----------|-----------|-------------------------|
| Dual injection (CLAUDE.md + AGENTS.md) | Max compatibility, future-proof | Single file, N-file injection |
| @ reference not @import | Avoid context bloat | Full embedding, hybrid |
| Require WSL2 for Windows | Industry pattern, avoid complexity | Native Windows support |
| 3 new AGENT-INJECTION.md sections | Data-driven from T1427 metrics | 1 catch-all section, 5+ sections |
| Global install at ~/.cleo/ | Universal pattern across all agents | /usr/local/, /opt/cleo/ |

---

**Document Version:** 2.0.0
**Last Updated:** 2026-01-04
**Next Review:** Upon T1431 completion
**Approval Status:** Implementation-Ready
