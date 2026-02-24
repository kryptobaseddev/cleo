# CLEO Verb Standards

**Version**: 2026.2.20
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
| Validate/check | `validate` | `check` (when validating compliance) | ✅ Enforced |
| Record event | `record` | `log` (when recording decisions/assumptions) | ✅ Enforced |
| Resume work | `resume` | `continue`, `reopen` (when resuming sessions) | ✅ Enforced |
| Pause work | `suspend` | `pause`, `hibernate` | ✅ Enforced |
| Reset state | `reset` | `clear`, `wipe` (when resetting to initial) | ✅ Enforced |
| Initialize | `init` | `setup`, `bootstrap` (when initializing project) | ✅ Enforced |
| Enable feature | `enable` | `activate`, `on` | ✅ Enforced |
| Disable feature | `disable` | `deactivate`, `off` | ✅ Enforced |
| Create backup | `backup` | `snapshot`, `save` (when creating backups) | ✅ Enforced |
| Schema migration | `migrate` | `upgrade`, `transform` | ✅ Enforced |
| Verify artifact | `verify` | `check`, `audit` (when verifying gates/frontmatter) | ✅ Enforced |
| Inject content | `inject` | `insert`, `load` (when injecting protocols) | ✅ Enforced |
| Execute action | `run` | `exec`, `execute` (compound verb: `test.run`, `gates.run`) | ✅ Enforced |
| End session | `end` | - (MCP operation; CLI alias for `stop`) | ✅ Enforced |
| Link entities | `link` | `connect`, `associate`, `attach` | ✅ Enforced |
| Configure settings | `configure` | `setup`, `config` (when configuring skills) | ✅ Enforced |

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

#### 13. Validate (Check Compliance)
**Standard**: `validate`
**Replaces**: `check` (when checking compliance or prerequisites)
**Scope**: Used across lifecycle gates, orchestration readiness, research entries, protocol compliance, and skill frontmatter

```bash
# ✅ CORRECT
cleo lifecycle validate --stage implementation
cleo orchestrate validate T123
cleo validate schema
cleo validate protocol

# ❌ INCORRECT
cleo lifecycle check --stage implementation
cleo orchestrate check T123
```

**MCP Usage**:
- `lifecycle.validate` (query) - Check stage prerequisites
- `orchestrate.validate` (mutate) - Validate spawn readiness
- `validate.schema` (query) - JSON Schema validation
- `validate.protocol` (query) - Protocol compliance check

#### 14. Record (Log Events)
**Standard**: `record`
**Replaces**: `log` (when recording structured events, not reading logs)
**Scope**: Used for recording lifecycle stage completions, session decisions, assumptions, and compliance checks

```bash
# ✅ CORRECT
cleo lifecycle record --stage research --epicId T001
cleo session record-decision "Use TypeScript for migration"
cleo compliance record --taskId T123

# ❌ INCORRECT
cleo lifecycle log --stage research
```

**MCP Usage**:
- `lifecycle.record` (mutate) - Record stage completion
- `session.record.decision` (mutate) - Record a session decision
- `session.record.assumption` (mutate) - Record an assumption
- `validate.compliance.record` (mutate) - Record compliance check

#### 15. Resume (Continue Paused Work)
**Standard**: `resume`
**Replaces**: `continue`, `reopen` (when resuming a suspended session)
**Scope**: Session management — resuming a previously suspended or ended session

```bash
# ✅ CORRECT
cleo session resume S001

# ❌ INCORRECT
cleo session continue S001
cleo session reopen S001
```

**MCP Usage**:
- `session.resume` (mutate) - Resume an existing session

#### 16. Suspend (Pause Work)
**Standard**: `suspend`
**Replaces**: `pause`, `hibernate`
**Scope**: Session management — temporarily suspending an active session without ending it

```bash
# ✅ CORRECT
cleo session suspend

# ❌ INCORRECT
cleo session pause
cleo session hibernate
```

**MCP Usage**:
- `session.suspend` (mutate) - Suspend current session

**Note**: `suspend` differs from `stop`/`end` in that a suspended session retains its state and can be resumed. `stop` terminates the session.

#### 17. Reset (Emergency State Reset)
**Standard**: `reset`
**Replaces**: `clear`, `wipe` (when resetting to initial state)
**Scope**: Lifecycle stage emergency resets

```bash
# ✅ CORRECT
cleo lifecycle reset --stage implementation --epicId T001

# ❌ INCORRECT
cleo lifecycle clear --stage implementation
```

**MCP Usage**:
- `lifecycle.reset` (mutate) - Reset lifecycle stage (emergency only)

**Warning**: `reset` is a destructive operation and should only be used in emergency situations. Prefer `record` with appropriate status for normal lifecycle progression.

#### 18. Init (Initialize)
**Standard**: `init`
**Replaces**: `setup`, `bootstrap`, `install` (when initializing CLEO in a project)
**Scope**: System initialization — first-time setup of CLEO in a project directory

```bash
# ✅ CORRECT
cleo init
cleo init --detect
cleo init --force

# ❌ INCORRECT
cleo setup
cleo bootstrap
```

**MCP Usage**:
- `system.init` (mutate) - Initialize CLEO

**Note**: `init` is idempotent — running it on an already-initialized project is safe.

#### 19. Enable / Disable (Feature Toggle)
**Standard**: `enable` / `disable`
**Replaces**: `activate`/`deactivate`, `on`/`off`
**Scope**: Skill management — enabling or disabling installed skills

```bash
# ✅ CORRECT
cleo skills enable ct-research-agent
cleo skills disable ct-validator

# ❌ INCORRECT
cleo skills activate ct-research-agent
cleo skills deactivate ct-validator
```

**MCP Usage**:
- `skills.enable` (mutate) - Enable a skill
- `skills.disable` (mutate) - Disable a skill

#### 20. Backup (Create Backup)
**Standard**: `backup`
**Replaces**: `snapshot`, `save` (when creating backups)
**Scope**: System operations — creating point-in-time backup snapshots

```bash
# ✅ CORRECT
cleo backup
cleo backup add
cleo backup list
cleo backup restore --file tasks.json

# ❌ INCORRECT
cleo snapshot
cleo save-state
```

**MCP Usage**:
- `system.backup` (mutate) - Create backup

**Note**: `backup` is both a domain (with subcommands `add`, `list`, `restore`) and a system-level operation.

#### 21. Migrate (Schema Migration)
**Standard**: `migrate`
**Replaces**: `upgrade`, `transform`
**Scope**: System operations — running schema migrations on data files

```bash
# ✅ CORRECT
cleo migrate status
cleo migrate run
cleo migrate run todo --dry-run

# ❌ INCORRECT
cleo upgrade schema
cleo transform data
```

**MCP Usage**:
- `system.migrate` (mutate) - Run migrations

**Note**: `migrate` is idempotent — running migrations on already-migrated files is safe.

#### 22. Verify (Artifact Verification)
**Standard**: `verify`
**Replaces**: `check`, `audit` (when verifying task gates or skill frontmatter)
**Scope**: Verification gates for tasks and skill frontmatter validation

```bash
# ✅ CORRECT
cleo verify T123
cleo verify T123 --gate tests --value true
cleo skills verify ct-orchestrator

# ❌ INCORRECT
cleo check T123
cleo audit T123
```

**MCP Usage**:
- `skills.verify` (query) - Validate skill frontmatter

**Note**: `verify` focuses on artifact-level checks (gates, frontmatter). Use `validate` for schema/protocol compliance checks.

#### 23. Inject (Protocol Injection)
**Standard**: `inject`
**Replaces**: `insert`, `load` (when injecting protocol content)
**Scope**: Research protocol injection and provider content injection

```bash
# ✅ CORRECT
cleo inject
cleo research inject --protocol research

# ❌ INCORRECT
cleo insert protocol
cleo load protocol
```

**MCP Usage**:
- `research.inject` (mutate) - Get protocol injection content
- `providers.inject` (mutate) - Inject content into provider instruction files
- `system.inject.generate` (mutate) - Generate MVI injection

#### 24. Run (Execute Action)
**Standard**: `run`
**Usage**: Compound verb only — always paired with a domain prefix
**Scope**: Executing test suites (`test.run`) and release gate checks (`gates.run`)

```bash
# ✅ CORRECT
cleo migrate run
cleo test run

# ❌ INCORRECT
cleo exec tests
cleo execute gates
```

**MCP Usage**:
- `validate.test.run` (mutate) - Execute test suite
- `release.gates.run` (mutate) - Run release gates

**Rule**: `run` MUST always be used as part of a compound verb (e.g., `test.run`, `gates.run`). It should never be used as a standalone verb for task operations.

#### 25. End (Terminate Session — MCP)
**Standard**: `end` (MCP operation name)
**CLI equivalent**: `stop` (with `end` as alias)
**Scope**: Session termination via MCP interface

```bash
# CLI usage (standard):
cleo session stop --note "Finished sprint"

# CLI usage (alias):
cleo session end --note "Finished sprint"
```

**MCP Usage**:
- `session.end` (mutate) - End current session

**Note**: In MCP, the canonical operation is `end`. In CLI, the canonical command is `stop` with `end` as a backward-compatible alias. This asymmetry exists because MCP adopted `end` before the CLI verb standardization to `stop`.

#### 26. Link (Associate Entities)
**Standard**: `link`
**Replaces**: `connect`, `associate`, `attach`
**Scope**: Linking research entries to tasks

```bash
# ✅ CORRECT
cleo research link R001 T123
cleo research links T123

# ❌ INCORRECT
cleo research connect R001 T123
cleo research attach R001 T123
```

**MCP Usage**:
- `research.link` (mutate) - Link research entry to task

#### 27. Configure (Adjust Settings)
**Standard**: `configure`
**Replaces**: `setup`, `config` (when configuring skill parameters)
**Scope**: Skill configuration — adjusting skill-specific settings

```bash
# ✅ CORRECT
cleo skills configure ct-orchestrator --param maxAgents --value 3

# ❌ INCORRECT
cleo skills setup ct-orchestrator
```

**MCP Usage**:
- `skills.configure` (mutate) - Configure a skill

**Note**: `configure` is for skill-specific configuration. For system-level configuration, use `config.set` / `config.show` (see Known Violations below).

---

## Known Verb Violations

All previously known violations have been resolved (T4792). The standard verbs are now canonical,
with old verbs retained as backward-compatible aliases:

| Location | Standard (canonical) | Alias (backward compat) | Status |
|----------|---------------------|------------------------|--------|
| `system.config.show` (query) | `config.show` | `config.get` | Fixed |
| `tasks.restore` (mutate) | `restore` | `reopen`, `uncancel` | Fixed |
| `system.restore` (mutate) | `restore` | `uncancel` | Fixed |
| `issues.add.*` (mutate) | `add.bug`, `add.feature`, `add.help` | `create.bug`, `create.feature`, `create.help` | Fixed |
| `skills.find` (query) | `find` | `search` | Fixed |

New code MUST use the standard verb. Aliases are maintained for backward compatibility only.

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
stop        End current session (alias: end)
status      Show session status
resume      Resume existing session
suspend     Pause session without ending
list        List sessions
gc          Garbage collect old sessions
record      Record decision or assumption
```

### Backup Operations
```
add         Create new backup (also: backup at system level)
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
gates.run   Run release gates
```

### Lifecycle Operations
```
validate    Check stage prerequisites
status      Current lifecycle state
history     Stage transition history
record      Record stage completion
skip        Skip optional stage
reset       Reset stage (emergency)
gate.pass   Mark gate as passed
gate.fail   Mark gate as failed
```

### System Operations
```
init        Initialize CLEO project
backup      Create backup
restore     Restore from backup
migrate     Run schema migrations
config.set  Set config value
config.show Get config value (canonical; config.get accepted as alias)
cleanup     Cleanup stale data
sync        Sync with TodoWrite
```

### Skill Operations
```
list        List available skills
show        Skill details
find        Find skills
verify      Validate skill frontmatter
install     Install a skill
uninstall   Uninstall a skill
enable      Enable a skill
disable     Disable a skill
configure   Configure a skill
```

### Validation Operations
```
validate    Schema/protocol/task validation
compliance  Compliance summary and violations
test.run    Execute test suite
```

### Research Operations
```
show        Research entry details
list        List research entries
find        Find research
inject      Get protocol injection
link        Link research to task
```

### Orchestration Operations
```
start       Initialize orchestration
spawn       Generate spawn prompt
validate    Validate spawn readiness
analyze     Dependency analysis
next        Next task to spawn
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

### 2026.2.20 - Missing Verb Documentation (T4791)
- **Added**: 17 verbs now documented: `validate`, `record`, `resume`, `suspend`, `reset`, `init`, `enable`, `disable`, `backup`, `migrate`, `verify`, `inject`, `run`, `end`, `link`, `configure`
- **Added**: Known Verb Violations section tracking `config.get`, `reopen`, `uncancel` deviations
- **Added**: Command categories for Lifecycle, System, Skill, Validation, Research, and Orchestration operations
- **Updated**: Session and Release command categories with missing verbs

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

- **Task**: T4732 (Naming Standardization), T4791 (Missing Verb Documentation)
- **Epic**: T4739 (Eliminate 'Todo' Terminology)
- **Related**: RFC 2119 (MUST/SHOULD/MAY definitions)
- **Validation**: `cleo compliance` commands

---

**Document Maintenance**: Updates to this document require Task ID reference and approval from core maintainers.
