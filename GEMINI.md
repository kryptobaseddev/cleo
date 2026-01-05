<!-- AGENT:GEMINI -->
# Mission: Task Execution via CLEO
You are operating within a CLEO-managed project. Your primary memory is the `.cleo/todo.json` file, accessed ONLY via the `cleo` CLI.

**Gemini-Specific Protocols:**
1. **Context Window**: Do not read the entire `cleo list` output if it's large. Use `cleo find` or `cleo dash` to save tokens.
2. **Buffer Sync**: You have a native "scratchpad" or "todo list" capability. Keep it synced with CLEO using `cleo sync`.
3. **Settings**: Ensure `.gemini/settings.json` includes `AGENTS.md` in `contextFileName` to persist these instructions.

---
<!-- CLEO:START v0.50.2 -->
## Task Management (cleo)

Use `ct` (alias for `cleo`) for all task operations. Full docs: `~/.cleo/docs/TODO_Task_Management.md`

### CRITICAL: Error Handling
**NEVER ignore exit codes. Failed commands mean tasks were NOT created/updated.**

**After EVERY command, check:**
1. Exit code `0` = success, `1-22` = error, `100+` = special (not error)
2. JSON field `"success": false` = operation failed
3. **Execute `error.fix`** - Copy-paste-ready command to resolve the error
4. **Or choose from `error.alternatives`** - Array of {action, command} options
5. Check `error.context` for structured error data

**Common Errors and Fixes:**
| Exit | Code | Meaning | Fix |
|:----:|------|---------|-----|
| 6 | `E_VALIDATION_*` | Validation failed | Check field lengths, escape `$` in notes |
| 10 | `E_PARENT_NOT_FOUND` | Parent doesn't exist | Verify with `ct exists <parent-id>` |
| 11 | `E_DEPTH_EXCEEDED` | Max depth (3) exceeded | Use shallower hierarchy (epic→task→subtask max) |
| 12 | `E_SIBLING_LIMIT` | Too many siblings (7) | Move task to different parent |
| 4 | `E_NOT_FOUND` | Task doesn't exist | Use `ct find` or `ct list` to verify |

**Recoverable errors (retry with backoff):** 7, 20, 21, 22
**Special codes (not errors):** 100 = no data, 101 = already exists, 102 = no change needed

**Shell escaping for notes:** Always escape `$` as `\$` in notes to prevent shell interpolation:
```bash
ct update T001 --notes "Price: \$395"  # Correct
ct update T001 --notes "Price: $395"   # WRONG - $395 interpreted as variable
```

### Data Integrity (RFC 2119)

**MUST** use `cleo` commands for all state modifications.
**MUST NOT** edit `.cleo/*.json` files directly.
**MUST** check exit codes after every command (see Error Handling above).

**Rationale**: Direct file edits bypass validation, create stale data in multi-writer environments.

### Best Practices (Efficiency)

- **Context-efficient**: Use `find` for task discovery (99% less context than `list`)
- **Native filters**: Use `--status`, `--label`, `--phase` (faster than jq)
- **Command discovery**: `ct commands -r critical` shows essential commands
- **Session lifecycle**: Start sessions before work, end when complete
- **JSON auto-detection**: Piped output is JSON (no `--format` flag needed)

### Essential Commands
```bash
ct list                    # View tasks (JSON when piped)
ct find "query"            # Fuzzy search (99% less context than list)
ct add "Task"              # Create task
ct done <id>               # Complete task
ct focus set <id>          # Set active task
ct focus show              # Show current focus
ct session start|end       # Session lifecycle
ct exists <id>             # Verify task exists
ct dash                    # Project overview
ct analyze                 # Task triage (JSON default)
ct analyze --auto-focus    # Auto-set focus to top task
ct delete <id> --reason "..."  # Cancel/soft-delete task
ct uncancel <id>           # Restore cancelled task
ct context                 # Check context window usage
ct context check           # Exit code for scripting (0=OK, 50+=warning)
```

### Command Discovery
```bash
cleo commands -r critical    # Show critical commands (no jq needed)
```

### Session Protocol

**Sessions persist across Claude conversations.** Resume where you left off.

**Sessions coexist.** No need to suspend one to start another.

#### START (State Awareness)
```bash
ct session list              # Check existing sessions
ct list                      # See task state
ct dash                      # Project overview
ct session resume <id>       # Resume existing
# OR
ct session start --scope epic:T001 --auto-focus --name "Feature Work"
```

#### WORK (Operational)
```bash
ct focus show                # Your focus
ct next                      # Get task suggestion
ct add "Subtask" --depends T005  # Add related tasks
ct update T005 --notes "..."     # Add task notes
ct focus note "Working on X"     # Session-level note
ct complete T005             # Complete task
ct focus set T006            # Next task
```

#### END (Cleanup)
```bash
ct complete <task-id>        # Complete current work
ct archive                   # Clean up old done tasks
ct session end --note "Progress notes"
```

### Phase Tracking
```bash
ct phases                  # List phases with progress
ct phase set <slug>        # Set current project phase
ct phase show              # Show current phase
ct list --phase core       # Filter tasks by phase
```
### Phase Integration
- Tasks can be assigned to project phases
- Phases provide progress tracking and organization
- Use `cleo list --phase <slug>` to filter by phase

### Phase Discipline
**Check phase context before work:**
```bash
ct phase show              # Always verify current phase
ct list --phase $(ct phase show -q)  # Focus on current phase tasks
```

**Cross-phase work guidelines:**
- **Same phase preferred** - Work within current phase when possible
- **Intentional cross-phase** - Document rationale when working across phases
- **Phase-aware creation** - Set task phase during creation: `ct add "Task" --phase testing`

**Phase progression awareness:**
- Core phase: Feature development and main implementation
- Testing phase: Validation, testing, and quality assurance
- Polish phase: Refinement, documentation, and final touches
- Maintenance phase: Bug fixes and ongoing support

### Hierarchy Automation (v0.24.0+)
- **Auto-complete**: Parent completes when all children done (if enabled)
- **Orphan repair**: `ct validate --fix-orphans unlink`
- **Tree view**: `ct tree` or `ct list --tree` (equivalent). Subtree: `ct tree --parent T001`
- **Reparent**: `ct reparent T005 --to T001` (move to different parent)
- **Promote**: `ct promote T005` (remove parent, make root)
- **Populate hierarchy**: `ct populate-hierarchy` (infer parentId from naming conventions)

**Enable auto-complete:**
```bash
ct config set hierarchy.autoCompleteParent true
ct config set hierarchy.autoCompleteMode auto  # auto|suggest|off
```

**Move tasks in hierarchy:**
```bash
ct reparent T005 --to T001           # Move T005 under T001
ct reparent T005 --to ""             # Remove parent (make root)
ct promote T005                      # Same as reparent --to ""
```

**Detect and fix orphaned tasks:**
```bash
ct validate --check-orphans          # Check for orphans
ct validate --fix-orphans unlink     # Remove invalid parent references
ct validate --fix-orphans delete     # Delete orphaned tasks
```

### Context Monitoring
```bash
ct context                 # Show context usage (🟢 ok, 🟡 warning, 🔴 critical)
ct context check           # Silent check, exit codes for scripting
```
**Exit codes**: `0`=OK (<70%) | `50`=Warning (70-84%) | `51`=Caution (85-89%) | `52`=Critical (90-94%) | `53`=Emergency (95%+)

**Automatic alerts**: When a CLEO session is active, context alerts automatically appear on stderr after task operations (`complete`, `add`, `focus set`, session lifecycle). Alerts use visual box format and only trigger on threshold crossings. Configure with `ct config set contextAlerts.*`. See `docs/commands/context.md` for details.

### Export/Import (Cross-Project)
```bash
# Export tasks to another project
ct export-tasks T001 --output task.json            # Export single task
ct export-tasks T001 --subtree --output epic.json  # Export epic with children

# Import tasks from another project
ct import-tasks task.json                          # Import into current project
ct import-tasks task.json --dry-run                # Preview import
ct import-tasks task.json --parent T050            # Import as children of T050
```

Full docs: `docs/export-import.md`
<!-- CLEO:END -->
<!-- AGENT:GEMINI -->
# Mission: Task Execution via CLEO
You are operating within a CLEO-managed project. Your primary memory is the `.cleo/todo.json` file, accessed ONLY via the `cleo` CLI.

**Gemini-Specific Protocols:**
1. **Context Window**: Do not read the entire `cleo list` output if it's large. Use `cleo find` or `cleo dash` to save tokens.
2. **Buffer Sync**: You have a native "scratchpad" or "todo list" capability. Keep it synced with CLEO using `cleo sync`.
3. **Settings**: Ensure `.gemini/settings.json` includes `AGENTS.md` in `contextFileName` to persist these instructions.

---
<!-- AGENT:GEMINI -->
# Mission: Task Execution via CLEO
You are operating within a CLEO-managed project. Your primary memory is the `.cleo/todo.json` file, accessed ONLY via the `cleo` CLI.

**Gemini-Specific Protocols:**
1. **Context Window**: Do not read the entire `cleo list` output if it's large. Use `cleo find` or `cleo dash` to save tokens.
2. **Buffer Sync**: You have a native "scratchpad" or "todo list" capability. Keep it synced with CLEO using `cleo sync`.
3. **Settings**: Ensure `.gemini/settings.json` includes `AGENTS.md` in `contextFileName` to persist these instructions.

---

# CLEO (Command Line Entity Orchestrator)

**Task management designed for AI coding agents and solo developers.**

## Project Overview

**CLEO** is a specialized task management system built specifically to bridge the gap between human developers and AI coding agents. Its primary goal is to provide a structured, validated, and persistent state for AI agents, mitigating common issues like hallucination and context loss.

*   **Primary Command:** `cleo` (aliased as `ct`)
*   **Core Principles:**
    *   **Agent-First:** Defaults to JSON output for easy parsing by agents.
    *   **Validate Everything:** Every write operation is strictly validated against JSON schemas to prevent "hallucinated" or corrupt data.
    *   **Persist Everything:** Maintains immutable audit trails and session state to solve context window limits.
    *   **Atomic Operations:** Enforces a strict `temp -> validate -> backup -> rename` pattern for all file writes.
    *   **No Time Estimates:** Explicitly prohibits time-based estimation (hours/days) in favor of relative sizing (small/medium/large).

## Architecture

The project is built as a modular Bash CLI application:

*   **`scripts/`**: Contains the user-facing executable scripts for each command (e.g., `add-task.sh`, `complete-task.sh`). These are the entry points.
*   **`lib/`**: Shared library functions (foundation layer) used by scripts.
    *   `validation.sh`: JSON schema and semantic validation.
    *   `file-ops.sh`: Atomic file writing and backup logic.
    *   `logging.sh`: Audit trail logging.
    *   `version.sh`: Version resolution logic.
*   **`schemas/`**: JSON Schema definitions (`todo.schema.json`, `config.schema.json`, etc.) acting as the single source of truth for data integrity.
*   **`tests/`**: Comprehensive test suite using BATS (Bash Automated Testing System).
    *   `unit/`: Tests for individual library functions.
    *   `integration/`: End-to-end command workflow tests.
*   **`dev/`**: Development helper scripts (version bumping, benchmarking).
*   **`templates/`**: Starter templates for project initialization.

## Building and Running

Since this is a Bash-based CLI, there is no "build" step in the traditional compiled sense, but there is an installation/setup process.

### Installation
To install the tool globally (symlinked for development):
```bash
./install.sh
```

### Verification
Verify the installation and data integrity:
```bash
cleo version
cleo --validate
```

### Running Tests
The project uses BATS for testing. Ensure dependencies are met (`./install.sh --check-deps`).

Run all tests:
```bash
./tests/run-all-tests.sh
```

Run specific test suites:
```bash
./tests/test-validation.sh
bats tests/unit/file_ops.bats
```

## Development Conventions

### Agent Interaction Rules (CRITICAL)
When acting as an agent within this codebase or using this tool:
1.  **NEVER edit data files directly**: Do not modify `.cleo/*.json` files manually. ALWAYS use the CLI commands (`cleo add`, `cleo update`, etc.).
2.  **Validate State**: Before assuming the state of tasks, run `cleo list` or `cleo exists <ID>`.
3.  **Check Exit Codes**: Respect non-zero exit codes. They indicate validation failures or system errors.
4.  **No Time Estimates**: Do not accept or generate time estimates (hours/days). Use `size` (small/medium/large).

### Coding Standards (Bash)
*   **Shebang**: `#!/usr/bin/env bash`
*   **Safety**: Always use `set -euo pipefail`.
*   **Variables**: Quote all variable expansions (`"$var"`).
*   **Conditionals**: Use `[[ ... ]]` instead of `[ ... ]`.
*   **Naming**: `snake_case` for functions/variables, `UPPER_SNAKE_CASE` for constants.

### Contribution Workflow
*   **Commit Messages**: Follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`).
*   **Branches**: Use descriptive names (`feature/my-feature`, `fix/bug-id`).
*   **Tests**: All new features must include tests.
*   **Atomic Writes**: If modifying core logic, strictly adhere to the atomic write pattern in `lib/file-ops.sh`.

## Key Files
*   `README.md`: Main entry point and documentation index.
*   `CLAUDE.md`: Specific instructions for Claude/AI agents (highly relevant for understanding intended usage).
*   `AGENTS.md`: Detailed protocol for agent behavior and error handling.
*   `CONTRIBUTING.md`: Detailed contribution guidelines.
*   `schemas/todo.schema.json`: The data model definition.
