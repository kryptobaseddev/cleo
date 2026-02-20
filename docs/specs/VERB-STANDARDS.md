# CLEO Verb Standards

**Version**: 2026.2.5  
**Status**: MANDATORY  
**Scope**: All CLEO CLI commands, MCP operations, and API endpoints  

## Purpose

This document establishes the canonical verb standard for CLEO to ensure consistent, predictable command interfaces across all user interactions. These standards are enforced at the code level and verified through automated compliance checks.

**Compliance**: ALL commands MUST adhere to these standards. Violations are considered bugs and MUST be fixed.

---

## Core Verb Standards

### Standard Verb Matrix

| Concept | Standard Verb | Replaces | Status |
|---------|---------------|----------|--------|
| Create new entity | `add` | `create`, `install`, `prepare`, `start` (when creating) | ✅ Enforced |
| Read single | `show` | `get` | ✅ Enforced |
| Read list | `list` | - | ✅ Enforced |
| Search | `find` | `search`, `query` | ✅ Enforced |
| Modify | `update` | `configure`, `modify`, `edit` | ✅ Enforced |
| Remove | `delete` | `remove`, `uninstall` | ✅ Enforced |
| Soft-delete | `archive` | - | ✅ Enforced |
| Restore | `restore` | `unarchive`, `reopen`, `uncancel` | ✅ Enforced |
| Finish work | `complete` | `end`, `done`, `finish` | ✅ Enforced |
| Begin work | `start` | `focus-set`, `focus.set` | ✅ Enforced |
| Stop work | `stop` | `focus-clear`, `focus.clear`, `end` | ✅ Enforced |
| Check current | `status` | `show` (when showing state, not entity) | ✅ Enforced |

### Verb Usage Rules

#### 1. Add (Create)
**Standard**: `add`  
**Replaces**: `create`, `install`, `prepare`, `new`  

```bash
# ✅ CORRECT
cleo add "Task title"
cleo backup add
cleo release add v1.0.0

# ❌ INCORRECT
cleo create "Task title"
cleo backup create
cleo release create v1.0.0
```

#### 2. Show (Read Single)
**Standard**: `show`  
**Replaces**: `get`, `display`, `view`  

```bash
# ✅ CORRECT
cleo show T123
cleo nexus show project:T123

# ❌ INCORRECT
cleo get T123
cleo nexus query project:T123
```

#### 3. List (Read Multiple)
**Standard**: `list`  
**Acceptable aliases**: `ls`  

```bash
# ✅ CORRECT
cleo list
cleo backup list
cleo session list
```

#### 4. Find (Search)
**Standard**: `find`  
**Replaces**: `search`, `query`  
**Acceptable aliases**: `search` (for backward compatibility)  

```bash
# ✅ CORRECT
cleo find "keyword"
cleo nexus find "pattern"

# ❌ INCORRECT
cleo query "keyword"
```

#### 5. Update (Modify)
**Standard**: `update`  
**Replaces**: `configure`, `modify`, `edit`, `set`  

```bash
# ✅ CORRECT
cleo update T123 --status done
cleo config update key value

# ❌ INCORRECT
cleo configure T123 --status done
cleo edit T123 --status done
```

#### 6. Delete (Remove)
**Standard**: `delete`  
**Replaces**: `remove`, `rm`, `uninstall`  
**Acceptable aliases**: `rm` (for shell familiarity)  

```bash
# ✅ CORRECT
cleo delete T123
cleo delete --id T123

# ❌ INCORRECT
cleo remove T123
cleo uninstall T123
```

#### 7. Archive (Soft Delete)
**Standard**: `archive`  
**Purpose**: Move to archive without permanent deletion  

```bash
# ✅ CORRECT
cleo archive
cleo archive --task T123
```

#### 8. Restore (Unarchive)
**Standard**: `restore`  
**Replaces**: `unarchive`, `reopen`, `uncancel`  
**Scope**: Universal restoration from ANY terminal state  

```bash
# ✅ CORRECT
cleo restore task T123
cleo restore backup --file tasks.json

# Universal - handles archived, cancelled, OR completed tasks
cleo restore task T123 --status pending

# ❌ INCORRECT
cleo unarchive T123
cleo reopen T123
cleo uncancel T123
```

**Implementation**: The `restore task` command intelligently handles:
- Archived tasks (from archive file)
- Cancelled tasks (from active list)
- Completed tasks (from active list)

#### 9. Complete (Finish Work)
**Standard**: `complete`  
**Replaces**: `end`, `done`, `finish`  
**Acceptable aliases**: `done` (for user familiarity)  

```bash
# ✅ CORRECT
cleo complete T123
cleo complete T123 --notes "Finished implementation"

# ❌ INCORRECT
cleo finish T123
cleo end T123
```

#### 10. Start (Begin Work)
**Standard**: `start`  
**Replaces**: `focus-set`, `focus.set`  

```bash
# ✅ CORRECT
cleo start T123
cleo session start --name "Sprint 1"

# ❌ INCORRECT
cleo focus set T123
cleo session focus-set
```

#### 11. Stop (Stop Work)
**Standard**: `stop`  
**Replaces**: `focus-clear`, `focus.clear`, `end`  
**Acceptable aliases**: `end` (for backward compatibility)  

```bash
# ✅ CORRECT
cleo stop
cleo session stop --note "Summary"

# ❌ INCORRECT
cleo focus clear
cleo session end
```

#### 12. Status (Check Current)
**Standard**: `status`  
**Replaces**: `show` (when showing state, not entity)  
**Usage**: For checking current state, not retrieving an entity  

```bash
# ✅ CORRECT
cleo status
cleo session status
cleo nexus status

# ❌ INCORRECT (when checking state)
cleo show session
```

---

## Naming Conventions

### Command Structure

#### Domain-Action Pattern
```
{domain}.{action}           → tasks.add, sessions.start
{domain}.{namespace}.{action} → catalog.protocols, gate.pass
```

#### Multi-Word Commands
Use **kebab-case** for multi-word commands:
```bash
# ✅ CORRECT
cleo archive-stats
cleo generate-changelog
cleo export-tasks

# ❌ INCORRECT
cleo archiveStats
cleo generate_changelog
cleo exportTasks
```

### Parameter Naming

#### Standard Flags (LAFS Protocol)

**Global Output Format Flags** (apply to all commands):
| Purpose | Flag | Description |
|---------|------|-------------|
| JSON output | `--json` | Output in JSON format (default) |
| Human-readable | `--human` | Output in human-readable format |
| Quiet mode | `--quiet` | Suppress non-essential output for scripting |

**Common Utility Flags**:
| Purpose | Short | Long |
|---------|-------|------|
| Help | `-h` | `--help` |
| Version | `-V` | `--version` |
| Dry run | `-n` | `--dry-run` |
| Force | `-f` | `--force` |
| Verbose | `-v` | `--verbose` |

**LAFS Protocol Compliance**:
All CLI commands MUST respect the `--json`, `--human`, and `--quiet` flags:
- `--json` (default): Machine-readable JSON output following LAFS envelope schema
- `--human`: Formatted text output for human consumption
- `--quiet`: Minimal output suitable for scripting (exit codes only where possible)

```bash
# ✅ CORRECT - LAFS protocol output flags
cleo list --json              # Default: JSON envelope output
cleo list --human             # Human-readable table format
cleo list --quiet             # Silent operation, exit code only
cleo show T123 --human        # Pretty-printed task details
cleo complete T123 --quiet    # No output, check exit code
```

#### Entity References
```bash
# ✅ CORRECT
cleo show --id T123
cleo update T123 --status done
cleo delete --task T123

# ❌ INCORRECT
cleo show --taskId T123
cleo update --task-id T123
```

---

## Command Categories

### Task Operations
```
add         Create new task
show        Display task details
list        List tasks with filters
find        Search tasks
update      Modify task properties
delete      Remove task (soft delete to archive)
archive     Archive completed/cancelled tasks
restore     Restore task from terminal state
complete    Mark task as done
start       Begin working on task
stop        Stop working on task
```

### Session Operations
```
start       Begin new session
stop        End current session
status      Show session status
resume      Resume existing session
list        List sessions
gc          Garbage collect old sessions
```

### Backup Operations
```
add         Create new backup
list        List available backups
restore     Restore from backup
```

### Release Operations
```
add         Create new release
plan        Add/remove tasks from release
ship        Ship/release version
list        List releases
show        Show release details
changelog   Generate changelog
```

---

## Backward Compatibility

### Alias Policy
- **Primary**: Standard verb (MUST be documented)
- **Alias**: Deprecated verbs (MAY exist for compatibility)
- **Timeline**: Aliases maintained for minimum 2 major versions
- **Deprecation**: Aliases emit warning in verbose mode

### Current Aliases
| Standard | Alias | Status |
|----------|-------|--------|
| `backup add` | `backup create` | Supported |
| `release add` | `release create` | Supported |
| `session stop` | `session end` | Supported |
| `restore task` | `restore unarchive` | Supported |
| `restore task` | `restore reopen` | Supported |
| `restore task` | `restore uncancel` | Supported |
| `find` | `search` | Supported |
| `complete` | `done` | Supported |
| `delete` | `rm` | Supported |

---

## Verification

### Automated Compliance
```bash
# Check command structure
cleo compliance commands

# Validate verb usage
cleo compliance audit

# Check for violations
cleo compliance violations
```

### Manual Verification
```bash
# List all commands
cleo commands

# Check specific command
cleo commands <command-name>
```

---

## Enforcement

### Code Review Checklist
- [ ] New commands use standard verbs
- [ ] Subcommands follow naming conventions
- [ ] Aliases documented for backward compatibility
- [ ] Documentation updated with examples
- [ ] Tests use standard verbs only

### CI/CD Gates
- Verb standardization linting
- Command structure validation
- Documentation drift detection

---

## Migration History

### 2026.2.5 - Verb Standardization Release
- **Breaking**: None (all changes backward compatible via aliases)
- **Changed**: 
  - `unarchive` → `restore task` (with `unarchive` alias)
  - `reopen` → `restore task` (with `reopen` alias)
  - `uncancel` → `restore task` (with `uncancel` alias)
  - `backup create` → `backup add` (with `create` alias)
  - `release create` → `release add` (with `create` alias)
  - `session end` → `session stop` (with `end` alias)
  - `nexus query` → `nexus show` (with `query` alias)

---

## References

- **Task**: T4732 (Naming Standardization)
- **Epic**: T4739 (Eliminate 'Todo' Terminology)
- **Related**: RFC 2119 (MUST/SHOULD/MAY definitions)
- **Validation**: `cleo compliance` commands

---

**Document Maintenance**: Updates to this document require Task ID reference and approval from core maintainers.
