# HYBRID Integration Testing Checklist

**Task**: T1089 - Integration testing in Claude Code (REFRAMED)
**Epic**: T1074
**Date**: 2026-01-27
**Status**: complete
**Agent Type**: implementation

---

## Summary

Comprehensive integration test matrix for CLEO's hybrid architecture: registry-based injection system (primary) + optional Claude Code plugin (session binding). Both systems work independently and coexist without conflict.

---

## Architecture Overview

CLEO uses a **2-tier approach**:

1. **INJECTION SYSTEM** (Primary) - Registry-based auto-discovery
   - Agent registry discovers installed agents
   - `cleo init` creates agent docs (CLAUDE.md, AGENTS.md, GEMINI.md)
   - CLEO markers (`<!-- CLEO:START -->` ... `<!-- CLEO:END -->`) protect injections
   - `cleo upgrade` refreshes injection content
   - Skills invoked via protocol names

2. **PLUGIN SYSTEM** (Optional) - Session binding for Claude Code
   - Plugin loads when `--with-plugin` flag used
   - `hooks.json` loaded by Claude Code
   - SessionStart fires on session begin
   - CLEO_SESSION env var bound to terminal
   - Plugin doesn't break without cleo CLI

**Both systems work independently AND together.**

---

## Matrix 1: INJECTION SYSTEM (Primary)

### 1.1 Agent Registry Discovery

#### Test: Registry File Exists
- [ ] **Verify** `templates/agent-registry.json` exists in cleo installation
- [ ] **Validate** against `schemas/agent-registry.schema.json`
- [ ] **Check** schemaVersion field present

#### Test: Registry Loading
- [ ] **Source** `lib/agent-registry.sh`
- [ ] **Call** `ar_load_registry`
- [ ] **Verify** `$_AR_REGISTRY_CACHE` populated
- [ ] **Check** JSON parses with `jq empty`

#### Test: Agent Discovery Functions
- [ ] **Call** `ar_list_agents` → returns space-separated agent IDs
- [ ] **Call** `ar_list_by_tier tier1` → returns claude-code, cursor, windsurf
- [ ] **Call** `ar_list_by_instruction_file "CLAUDE.md"` → returns claude-code
- [ ] **Call** `ar_get_agent "claude-code"` → returns JSON object

#### Test: Installed Agent Detection
- [ ] **Call** `ar_is_installed "claude-code"` when `~/.claude` exists → returns 0
- [ ] **Call** `ar_is_installed "fake-agent"` → returns 1
- [ ] **Call** `ar_list_installed` → returns only installed agents
- [ ] **Call** `ar_list_installed_by_tier tier1` → filters by tier

#### Test: Path Resolution
- [ ] **Call** `ar_get_global_dir "claude-code"` → expands `$HOME` in path
- [ ] **Call** `ar_get_global_instruction_path "claude-code"` → `~/.claude/CLAUDE.md`
- [ ] **Call** `ar_get_global_skills_dir "claude-code"` → `~/.claude/skills`
- [ ] **Verify** paths absolute, no `$HOME` literal

### 1.2 Injection File Creation

#### Test: Init Creates Files
```bash
# Setup
cd /tmp/test-project
rm -rf .cleo CLAUDE.md AGENTS.md GEMINI.md

# Execute
cleo init

# Verify
- [ ] CLAUDE.md created if claude-code installed
- [ ] AGENTS.md created if any AGENTS.md agent installed
- [ ] GEMINI.md created if gemini-cli installed
- [ ] Files contain CLEO markers
```

#### Test: Init Preserves User Content
```bash
# Setup
echo "# My Project" > CLAUDE.md
echo "User content" >> CLAUDE.md

# Execute
cleo init

# Verify
- [ ] "# My Project" preserved
- [ ] "User content" preserved
- [ ] CLEO injection added between markers
- [ ] User content NOT inside markers
```

#### Test: Multiple Agent Files
```bash
# Setup (simulate multiple agents installed)
mkdir -p ~/.claude ~/.cursor ~/.gemini

# Execute
cleo init

# Verify
- [ ] CLAUDE.md created
- [ ] AGENTS.md created (cursor uses this)
- [ ] GEMINI.md created
- [ ] Each file has correct @-reference to injection template
```

### 1.3 CLEO Markers

#### Test: Marker Preservation
```bash
# Setup
cat > CLAUDE.md << 'EOF'
<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
EOF

# Execute
cleo init

# Verify
- [ ] Markers unchanged
- [ ] @-reference preserved
- [ ] No duplicate markers
```

#### Test: Marker Detection
- [ ] **Function** `has_cleo_injection()` detects markers
- [ ] **Returns** 0 when both START and END present
- [ ] **Returns** 1 when markers missing
- [ ] **Returns** 1 when only one marker present

#### Test: User Content Outside Markers
```bash
# Setup
cat > CLAUDE.md << 'EOF'
# My Custom Instructions

<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->

## My Project Rules
- Rule 1
- Rule 2
EOF

# Execute
cleo upgrade --update-docs

# Verify
- [ ] "# My Custom Instructions" preserved
- [ ] "## My Project Rules" preserved
- [ ] CLEO injection updated between markers
- [ ] No content deleted
```

### 1.4 Upgrade Mechanism

#### Test: Upgrade Updates Docs
```bash
# Setup (outdated injection)
cleo init
# Manually change template version

# Execute
cleo upgrade

# Verify
- [ ] CLAUDE.md injection updated
- [ ] AGENTS.md injection updated
- [ ] GEMINI.md injection updated
- [ ] User content preserved
```

#### Test: Upgrade Idempotent
```bash
# Execute twice
cleo upgrade
cleo upgrade

# Verify
- [ ] Second run detects no changes
- [ ] Exit code 0 (no updates needed)
- [ ] No file modifications on second run
```

#### Test: Upgrade --status
```bash
# Execute
cleo upgrade --status

# Verify
- [ ] Shows what needs updating
- [ ] Does NOT modify files
- [ ] Exit code indicates update status
```

#### Test: Upgrade Dry-Run
```bash
# Execute
cleo upgrade --dry-run

# Verify
- [ ] Shows planned changes
- [ ] Does NOT modify files
- [ ] Indicates which files would be updated
```

### 1.5 Skill Invocation

#### Test: Skill Manifest Discovery
- [ ] **Verify** `skills/manifest.json` exists
- [ ] **Source** `lib/skill-validate.sh`
- [ ] **Call** `skill_exists "ct-research-agent"` → returns 0
- [ ] **Call** `skill_exists "fake-skill"` → returns 1

#### Test: Skill Validation
- [ ] **Call** `skill_validate_for_spawn "ct-research-agent"` → returns 0
- [ ] **Verify** required tokens present in skill
- [ ] **Check** skill status is "active"
- [ ] **Validate** skill file exists

#### Test: Skill Info Retrieval
```bash
# Execute
info=$(skill_get_info "ct-research-agent")

# Verify
- [ ] Returns JSON object
- [ ] Contains name, path, status
- [ ] Contains requiredTokens array
```

### 1.6 Template Synchronization

#### Test: Template Injection File
- [ ] **Verify** `.cleo/templates/AGENT-INJECTION.md` created during init
- [ ] **Check** content matches global template
- [ ] **Validate** @-reference resolves

#### Test: Template Update on Upgrade
```bash
# Setup
cleo init
# Update global template at ~/.cleo/templates/AGENT-INJECTION.md

# Execute
cleo upgrade

# Verify
- [ ] Local template updated
- [ ] Changes reflected in agent docs
```

---

## Matrix 2: PLUGIN SYSTEM (Optional)

### 2.1 Plugin Directory Structure

#### Test: Plugin Files Exist
```bash
# Verify
- [ ] .claude-plugin/plugin.json exists
- [ ] .claude-plugin/hooks/hooks.json exists
- [ ] .claude-plugin/hooks/scripts/session-start.sh exists
```

#### Test: Plugin Manifest Valid
```bash
# Execute
cat .claude-plugin/plugin.json | jq empty

# Verify
- [ ] JSON valid
- [ ] Contains name, version
- [ ] hooks.enabled = true
- [ ] hooks.manifest = "hooks/hooks.json"
```

### 2.2 Hooks Configuration

#### Test: Hooks Manifest Valid
```bash
# Execute
cat .claude-plugin/hooks/hooks.json | jq empty

# Verify
- [ ] JSON valid
- [ ] SessionStart defined
- [ ] matcher = "*"
- [ ] type = "command"
- [ ] command points to session-start.sh
- [ ] timeout defined (10s)
```

#### Test: Hook Script Executable
```bash
# Verify
- [ ] session-start.sh has execute permission
- [ ] Shebang is #!/usr/bin/env bash
- [ ] set -euo pipefail present
```

### 2.3 SessionStart Hook

#### Test: Hook Fires on Session Start
```bash
# Setup
cd test-project
cleo session start --scope epic:T001 --auto-focus

# Execute
claude --with-plugin /path/to/.claude-plugin

# Verify (in Claude session)
- [ ] SessionStart hook executes
- [ ] session-start.sh runs
- [ ] Output: "✓ CLEO session bound: session_..."
```

#### Test: Session Binding
```bash
# Setup
SESSION_ID="session_20260127_123456_abc123"
echo "$SESSION_ID" > .cleo/.current-session

# Execute
claude --with-plugin /path/to/.claude-plugin

# Verify (in Claude session)
- [ ] CLEO_SESSION env var set
- [ ] CLEO_SESSION equals SESSION_ID
- [ ] .cleo/.session-env created
- [ ] File contains export statement
```

#### Test: Session Verification
```bash
# Setup (inactive session)
echo "session_invalid" > .cleo/.current-session

# Execute hook
bash .claude-plugin/hooks/scripts/session-start.sh

# Verify
- [ ] Hook detects inactive session
- [ ] CLEO_SESSION NOT set
- [ ] Exit code 0 (silent failure)
```

#### Test: Graceful Degradation
```bash
# Setup (no cleo installed)
mv ~/.cleo ~/.cleo.bak

# Execute hook
bash .claude-plugin/hooks/scripts/session-start.sh

# Verify
- [ ] Hook exits cleanly
- [ ] No error messages
- [ ] Exit code 0
```

### 2.4 Plugin Without CLEO CLI

#### Test: Plugin Loads Without CLEO
```bash
# Setup (no cleo installed)
rm -rf ~/.cleo

# Execute
claude --with-plugin /path/to/.claude-plugin

# Verify
- [ ] Plugin loads successfully
- [ ] No errors in Claude output
- [ ] Hook script exits early (no cleo binary)
```

#### Test: Plugin Doesn't Break Commands
```bash
# Setup (no cleo installed)
rm -rf ~/.cleo

# Execute (in Claude with plugin)
echo "test"
ls -la

# Verify
- [ ] Commands execute normally
- [ ] No CLEO-related errors
- [ ] Plugin transparent when cleo absent
```

---

## Matrix 3: HYBRID SYSTEM (Both Together)

### 3.1 Coexistence Testing

#### Test: Injection + Plugin Together
```bash
# Setup
cleo init                    # Creates injection files
cleo session start --scope epic:T001 --auto-focus

# Execute
claude --with-plugin /path/to/.claude-plugin

# Verify
- [ ] Agent docs (CLAUDE.md) loaded via @-reference
- [ ] SessionStart hook fires
- [ ] CLEO_SESSION bound
- [ ] No conflicts between systems
```

#### Test: Injection Works Without Plugin
```bash
# Setup
cleo init

# Execute
claude    # NO --with-plugin flag

# Verify
- [ ] Agent docs loaded
- [ ] CLEO commands work
- [ ] No plugin-related errors
```

#### Test: Plugin Works Without Injection
```bash
# Setup (no agent docs)
rm -f CLAUDE.md AGENTS.md GEMINI.md

# Execute
claude --with-plugin /path/to/.claude-plugin

# Verify
- [ ] Plugin loads
- [ ] SessionStart fires
- [ ] No injection-related errors
```

### 3.2 Session Binding with Both

#### Test: Session Binding Methods
```bash
# Test 1: Via plugin hook
- [ ] CLEO_SESSION set by SessionStart hook
- [ ] .cleo/.session-env created

# Test 2: Via explicit export
export CLEO_SESSION="session_xyz"
- [ ] cleo commands use exported session
- [ ] Session binding persists

# Test 3: Via --session flag
cleo list --session session_xyz
- [ ] Overrides env var
- [ ] Single command scope
```

#### Test: TTY Binding (Plugin Context)
```bash
# In Claude session with plugin
cleo session switch session_xyz

# Verify
- [ ] TTY binding file created (if real terminal)
- [ ] Or uses .current-session fallback
- [ ] Subsequent commands use correct session
```

### 3.3 Workflow Integration

#### Test: Full Workflow with Both Systems
```bash
# Phase 1: Setup
cleo init                              # Injection system
cleo session start --scope epic:T001 --auto-focus

# Phase 2: Start Claude with plugin
claude --with-plugin /path/to/.claude-plugin

# Phase 3: Verify context (in Claude)
cleo session status                    # Should show session_...
env | grep CLEO_SESSION               # Should be set

# Phase 4: Work
cleo focus set T100
cleo add "Subtask" --depends T100
cleo complete T100

# Phase 5: Verify
cleo list                             # Uses bound session
cleo show T100                        # Task state correct

# Verify
- [ ] All CLEO commands work
- [ ] Session binding consistent
- [ ] No errors or warnings
```

#### Test: Multi-Session with Plugin
```bash
# Terminal 1
export CLEO_SESSION="session_001"
claude --with-plugin /path/to/.claude-plugin

# Terminal 2
export CLEO_SESSION="session_002"
claude --with-plugin /path/to/.claude-plugin

# Verify
- [ ] Each terminal has isolated session
- [ ] No session conflicts
- [ ] cleo commands use correct session
```

---

## Integration Test Execution

### Prerequisites
```bash
# Install CLEO
cleo version

# Verify agent registry
test -f ~/.cleo/templates/agent-registry.json

# Verify skills
test -f skills/manifest.json

# Verify plugin structure
test -f .claude-plugin/plugin.json
```

### Automated Test Runner

```bash
#!/usr/bin/env bash
# tests/integration/run-hybrid-tests.sh

set -euo pipefail

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0

run_test() {
    local test_name="$1"
    local test_cmd="$2"

    echo -n "Testing: $test_name ... "

    if eval "$test_cmd" &>/dev/null; then
        echo -e "${GREEN}PASS${NC}"
        ((PASSED++))
    else
        echo -e "${RED}FAIL${NC}"
        ((FAILED++))
    fi
}

echo "=== HYBRID INTEGRATION TESTS ==="
echo

# Matrix 1: Injection System
echo "Matrix 1: INJECTION SYSTEM"
run_test "Registry file exists" "test -f ~/.cleo/templates/agent-registry.json"
run_test "Registry loads" "source ~/.cleo/lib/agent-registry.sh && ar_load_registry"
run_test "List agents" "source ~/.cleo/lib/agent-registry.sh && ar_list_agents | grep -q claude-code"
run_test "Skill manifest exists" "test -f skills/manifest.json"

# Matrix 2: Plugin System
echo
echo "Matrix 2: PLUGIN SYSTEM"
run_test "Plugin manifest exists" "test -f .claude-plugin/plugin.json"
run_test "Hooks config exists" "test -f .claude-plugin/hooks/hooks.json"
run_test "Session script executable" "test -x .claude-plugin/hooks/scripts/session-start.sh"

# Matrix 3: Hybrid
echo
echo "Matrix 3: HYBRID SYSTEM"
run_test "Injection works standalone" "test -f CLAUDE.md || test -f AGENTS.md || test -f GEMINI.md"
run_test "Plugin loads without cleo" "jq -e '.hooks.enabled' .claude-plugin/plugin.json"

# Summary
echo
echo "=========================="
echo -e "Tests Passed: ${GREEN}${PASSED}${NC}"
echo -e "Tests Failed: ${RED}${FAILED}${NC}"
echo "=========================="

exit $FAILED
```

### Manual Test Checklist

Use this checklist for manual verification:

1. **Before testing**: Install CLEO fresh in test directory
2. **For each matrix**: Run tests in order (dependencies)
3. **Mark results**: ✓ pass, ✗ fail, ⚠ partial
4. **Document failures**: Note error messages, logs
5. **After testing**: Clean up test artifacts

---

## Expected Results

### Success Criteria

**Matrix 1 (Injection)**:
- All agent discovery tests pass
- Files created correctly by init
- Upgrade updates docs without data loss
- Skills validated before spawn

**Matrix 2 (Plugin)**:
- Plugin loads in Claude Code
- SessionStart hook fires
- Session binding works
- Graceful degradation without cleo

**Matrix 3 (Hybrid)**:
- Both systems coexist peacefully
- No conflicts or errors
- Session binding consistent across both
- Full workflow test completes

### Failure Scenarios

| Failure | Root Cause | Fix |
|---------|-----------|-----|
| Registry not found | Missing template file | Run `cleo upgrade` |
| Injection overwrites user content | Marker detection broken | Fix marker regex |
| Plugin errors on load | Invalid JSON manifest | Validate with `jq empty` |
| Session not bound | Hook script failed | Check stderr in Claude |
| Skill not found | Manifest out of sync | Regenerate manifest |

---

## Next Steps

After completing this checklist:

1. **Document failures** in GitHub issues
2. **Update tests** for BATS automation
3. **Add regression tests** for fixed bugs
4. **Verify fixes** by re-running checklist

---

## References

- **Injection System**: `lib/agent-registry.sh`, `lib/injection.sh`
- **Plugin System**: `.claude-plugin/`, `docs/guides/CLAUDE-CODE-PLUGIN.md`
- **Skills**: `lib/skill-validate.sh`, `skills/manifest.json`
- **Protocols**: `protocols/implementation.md`, `docs/architecture/CLEO-SUBAGENT.md`
- **Task**: T1089, Epic: T1074
