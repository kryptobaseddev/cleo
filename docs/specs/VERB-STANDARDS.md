# CLEO Verb Standards

**Version**: 2026.2.27
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
| Create new entity | `add` | `create`, `install`, `prepare`, `start` (when creating) | Enforced |
| Read single | `show` | `get` | Enforced |
| Read list | `list` | - | Enforced |
| Search | `find` | `search`, `query` | Enforced |
| Modify | `update` | `configure`, `modify`, `edit` | Enforced |
| Remove | `delete` | `remove`, `uninstall` | Enforced |
| Soft-delete | `archive` | - | Enforced |
| Restore | `restore` | `unarchive`, `reopen`, `uncancel` | Enforced |
| Finish work | `complete` | `end`, `done`, `finish` | Enforced |
| Begin work | `start` | `focus-set`, `tasks.start` | Enforced |
| Stop work | `stop` | `focus-clear`, `tasks.stop`, `end` | Enforced |
| Check current | `status` | `show` (when showing state, not entity) | Enforced |
| Validate compliance | `validate` | `check` (when validating compliance) | Enforced |
| Record event | `record` | `log` (when recording decisions/assumptions) | Enforced |
| Resume work | `resume` | `continue`, `reopen` (when resuming sessions) | Enforced |
| Pause work | `suspend` | `pause`, `hibernate` | Enforced |
| Reset state | `reset` | `clear`, `wipe` (when resetting to initial) | Enforced |
| Initialize | `init` | `setup`, `bootstrap` (when initializing project) | Enforced |
| Enable feature | `enable` | `activate`, `on` | Enforced |
| Disable feature | `disable` | `deactivate`, `off` | Enforced |
| Create backup | `backup` | `snapshot`, `save` (when creating backups) | Enforced |
| Schema migration | `migrate` | `upgrade`, `transform` | Enforced |
| Verify artifact | `verify` | `check`, `audit` (when verifying gates/frontmatter) | Enforced |
| Inject content | `inject` | `insert`, `load` (when injecting protocols) | Enforced |
| Execute action | `run` | `exec`, `execute` (compound verb: `test.run`, `gates.run`) | Enforced |
| End session | `end` | - (MCP operation; CLI alias for `stop`) | Enforced |
| Link entities | `link` | `connect`, `associate`, `attach` | Enforced |
| Configure settings | `configure` | `setup`, `config` (when configuring skills) | Enforced |
| Health check | `check` | `ping`, `probe`, `test` (when checking liveness) | Enforced |
| Data repair | `repair` | `fix`, `heal`, `correct` (when repairing data) | Enforced |
| Conflict resolution | `resolve` | `settle`, `fix`, `merge` (when resolving conflicts) | Enforced |
| Unlink entities | `unlink` | `disconnect`, `detach`, `deassociate` | Enforced |
| Compute value | `compute` | `calculate`, `derive`, `eval` (when computing metrics) | Enforced |
| Composite read | `plan` | — (composite multi-query aggregation for planning views) | Enforced |
| Schedule work | `schedule` | `defer`, `queue` (when scheduling tasks for future execution) | Enforced |
| Cancel task | `cancel` | `abort`, `stop`, `kill` (when cancelling tasks) | Enforced |
| Synchronize data | `sync` | `pull`, `push`, `reconcile` (when syncing stores) | Enforced |
| Inspect internals | `inspect` | `diagnose`, `debug`, `examine` (when inspecting state) | Enforced |

---

## Verb Usage Rules

### 1. Add (Create)

**Standard**: `add`
**Replaces**: `create`, `install`, `prepare`, `new`

```bash
# CORRECT
cleo add "Task title"
cleo backup add
cleo release add v1.0.0

# INCORRECT
cleo create "Task title"
cleo backup create
cleo release create v1.0.0
```

**MCP Usage**: `tasks.add`

---

### 2. Show (Read Single)

**Standard**: `show`
**Replaces**: `get`, `display`, `view`

```bash
# CORRECT
cleo show T123
cleo config show key

# INCORRECT
cleo get T123
cleo config get key
```

**MCP Usage**: `tasks.show`, `config.show`

---

### 3. List (Read Multiple)

**Standard**: `list`
**Acceptable aliases**: `ls`

```bash
# CORRECT
cleo list
cleo backup list
cleo session list
```

**MCP Usage**: `tasks.list`, `session.list`

---

### 4. Find (Search)

**Standard**: `find`
**Replaces**: `search`, `query`
**Acceptable aliases**: `search` (for backward compatibility)

```bash
# CORRECT
cleo find "keyword"

# INCORRECT
cleo query "keyword"
cleo search "keyword"
```

**MCP Usage**: `tasks.find`, `skills.find`

---

### 5. Update (Modify)

**Standard**: `update`
**Replaces**: `configure`, `modify`, `edit`, `set`

```bash
# CORRECT
cleo update T123 --status done

# INCORRECT
cleo configure T123 --status done
cleo edit T123 --status done
```

**MCP Usage**: `tasks.update`

---

### 6. Delete (Remove)

**Standard**: `delete`
**Replaces**: `remove`, `rm`, `uninstall`
**Acceptable aliases**: `rm` (for shell familiarity)

```bash
# CORRECT
cleo delete T123

# INCORRECT
cleo remove T123
```

**MCP Usage**: `tasks.delete`

---

### 7. Archive (Soft Delete)

**Standard**: `archive`
**Purpose**: Move to archive without permanent deletion

```bash
# CORRECT
cleo archive
cleo archive --task T123
```

**MCP Usage**: `tasks.archive`

---

### 8. Restore (Universal Restoration)

**Standard**: `restore`
**Replaces**: `unarchive`, `reopen`, `uncancel`
**Scope**: Universal restoration from ANY terminal state

```bash
# CORRECT
cleo restore task T123
cleo restore backup --file tasks.json

# INCORRECT
cleo unarchive T123
cleo reopen T123
cleo uncancel T123
```

**MCP Usage**: `tasks.restore`

**Implementation**: The `restore task` command handles archived, cancelled, and completed tasks.

---

### 9. Complete (Finish Work)

**Standard**: `complete`
**Replaces**: `end`, `done`, `finish`
**Acceptable aliases**: `done` (for user familiarity)

```bash
# CORRECT
cleo complete T123

# INCORRECT
cleo finish T123
cleo end T123
```

**MCP Usage**: `tasks.complete`

---

### 10. Start (Begin Work)

**Standard**: `start`
**Replaces**: `focus-set`, `tasks.start`

```bash
# CORRECT
cleo start T123

# INCORRECT
cleo start T123
```

**MCP Usage**: `tasks.start`, `session.start`

---

### 11. Stop (Stop Work)

**Standard**: `stop`
**Replaces**: `focus-clear`, `tasks.stop`, `end`
**Acceptable aliases**: `end` (for backward compatibility)

```bash
# CORRECT
cleo stop

# INCORRECT
cleo stop
```

**MCP Usage**: `tasks.stop`, `session.end`

**Note**: In MCP, the canonical session termination operation is `session.end`. In CLI, the canonical command is `stop` with `end` as a backward-compatible alias.

---

### 12. Status (Check Current State)

**Standard**: `status`
**Replaces**: `show` (when showing state, not entity)
**Usage**: For checking current state, not retrieving an entity

```bash
# CORRECT
cleo status
cleo session status

# INCORRECT (when checking state)
cleo show session
```

**MCP Usage**: `session.status`

---

### 13. Validate (Compliance Validation)

**Standard**: `validate`
**Replaces**: `check` (when validating compliance or prerequisites)
**Scope**: Lifecycle gates, orchestration readiness, research entries, protocol compliance, and skill frontmatter

```bash
# CORRECT
cleo lifecycle validate --stage implementation
cleo validate schema
cleo validate protocol

# INCORRECT
cleo lifecycle check --stage implementation
```

**MCP Usage**: `lifecycle.validate`, `validate.schema`, `validate.protocol`

**Note**: `validate` is for compliance and schema checks. For liveness checks, use `check`. For artifact-level gate verification, use `verify`.

---

### 14. Record (Log Events)

**Standard**: `record`
**Replaces**: `log` (when recording structured events, not reading logs)
**Scope**: Recording lifecycle stage completions, session decisions, assumptions, and compliance checks

```bash
# CORRECT
cleo lifecycle record --stage research --epicId T001
cleo compliance record --taskId T123

# INCORRECT
cleo lifecycle log --stage research
```

**MCP Usage**: `lifecycle.record`, `session.record.decision`, `validate.compliance.record`

---

### 15. Resume (Continue Paused Work)

**Standard**: `resume`
**Replaces**: `continue`, `reopen` (when resuming a suspended session)
**Scope**: Session management

```bash
# CORRECT
cleo session resume S001

# INCORRECT
cleo session continue S001
cleo session reopen S001
```

**MCP Usage**: `session.resume`

---

### 16. Suspend (Pause Work)

**Standard**: `suspend`
**Replaces**: `pause`, `hibernate`
**Scope**: Session management

```bash
# CORRECT
cleo session suspend

# INCORRECT
cleo session pause
```

**MCP Usage**: `session.suspend`

---

### 17. Reset (Emergency State Reset)

**Standard**: `reset`
**Replaces**: `clear`, `wipe` (when resetting to initial state)
**Scope**: Lifecycle stage emergency resets only

```bash
# CORRECT
cleo lifecycle reset --stage implementation --epicId T001

# INCORRECT
cleo lifecycle clear --stage implementation
```

**MCP Usage**: `lifecycle.reset`

**Warning**: `reset` is destructive. Use only in emergency situations.

---

### 18. Init (Initialize)

**Standard**: `init`
**Replaces**: `setup`, `bootstrap`, `install` (when initializing CLEO in a project)

```bash
# CORRECT
cleo init
cleo init --detect

# INCORRECT
cleo setup
cleo bootstrap
```

**MCP Usage**: `system.init`

---

### 19. Enable / Disable (Feature Toggle)

**Standard**: `enable` / `disable`
**Replaces**: `activate`/`deactivate`, `on`/`off`

```bash
# CORRECT
cleo skills enable ct-research-agent
cleo skills disable ct-validator

# INCORRECT
cleo skills activate ct-research-agent
```

**MCP Usage**: `skills.enable`, `skills.disable`

---

### 20. Backup (Create Backup)

**Standard**: `backup`
**Replaces**: `snapshot`, `save` (when creating backups)

```bash
# CORRECT
cleo backup
cleo backup add

# INCORRECT
cleo snapshot
```

**MCP Usage**: `system.backup`

---

### 21. Migrate (Schema Migration)

**Standard**: `migrate`
**Replaces**: `upgrade`, `transform`

```bash
# CORRECT
cleo migrate run

# INCORRECT
cleo upgrade schema
```

**MCP Usage**: `system.migrate`

---

### 22. Verify (Artifact Verification)

**Standard**: `verify`
**Replaces**: `check`, `audit` (when verifying task gates or skill frontmatter)
**Scope**: Gate verification and skill frontmatter validation

```bash
# CORRECT
cleo verify T123
cleo skills verify ct-orchestrator

# INCORRECT
cleo check T123
cleo audit T123
```

**MCP Usage**: `skills.verify`

**Note**: `verify` focuses on artifact-level checks (gates, frontmatter). Use `validate` for schema/protocol compliance.

---

### 23. Inject (Protocol Injection)

**Standard**: `inject`
**Replaces**: `insert`, `load` (when injecting protocol content)

```bash
# CORRECT
cleo research inject --protocol research

# INCORRECT
cleo insert protocol
```

**MCP Usage**: `research.inject`, `providers.inject`, `system.inject.generate`

---

### 24. Run (Execute Action)

**Standard**: `run`
**Usage**: Compound verb only — always paired with a domain prefix

```bash
# CORRECT
cleo migrate run
cleo test run

# INCORRECT
cleo exec tests
```

**MCP Usage**: `validate.test.run`, `release.gates.run`

**Rule**: `run` MUST always be used as part of a compound verb. Never use as a standalone verb.

---

### 25. End (Terminate Session — MCP)

**Standard**: `end` (MCP operation name)
**CLI equivalent**: `stop` (with `end` as alias)

**MCP Usage**: `session.end`

---

### 26. Link (Associate Entities)

**Standard**: `link`
**Replaces**: `connect`, `associate`, `attach`
**Scope**: Linking research entries to tasks

```bash
# CORRECT
cleo research link R001 T123

# INCORRECT
cleo research connect R001 T123
```

**MCP Usage**: `research.link`

---

### 27. Configure (Adjust Settings)

**Standard**: `configure`
**Replaces**: `setup`, `config` (when configuring skill parameters)

```bash
# CORRECT
cleo skills configure ct-orchestrator --param maxAgents --value 3

# INCORRECT
cleo skills setup ct-orchestrator
```

**MCP Usage**: `skills.configure`

---

### 28. Check (Liveness / Health Check)

**Standard**: `check`
**Replaces**: `ping`, `probe`, `test` (when checking system liveness or health)
**Scope**: Liveness checks, health probes, and precondition checks

```bash
# CORRECT
cleo system check
cleo check --health

# INCORRECT
cleo ping
cleo probe
```

**MCP Usage**: `system.check`, `check.health`

**Distinction from `validate`**: `check` is for liveness and health probing. `validate` is for compliance and schema correctness. `verify` is for artifact gates.

---

### 29. Repair (Data Repair)

**Standard**: `repair`
**Replaces**: `fix`, `heal`, `correct` (when repairing corrupted or inconsistent data)
**Scope**: Sequence counter repair, data integrity repair, index repair

```bash
# CORRECT
cleo system repair --sequence
cleo repair index

# INCORRECT
cleo fix sequence
cleo heal data
```

**MCP Usage**: `system.repair`

**Note**: `repair` is non-destructive — it corrects inconsistencies without losing data. For destructive resets use `reset`.

---

### 30. Resolve (Conflict Resolution)

**Standard**: `resolve`
**Replaces**: `settle`, `fix`, `merge` (when resolving conflicts between data states)
**Scope**: Resolving sync conflicts, merge conflicts, and state inconsistencies

```bash
# CORRECT
cleo resolve conflict T123
cleo issues resolve I001

# INCORRECT
cleo settle conflict T123
cleo fix conflict T123
```

**MCP Usage**: `issues.resolve`

---

### 31. Unlink (Dissociate Entities)

**Standard**: `unlink`
**Replaces**: `disconnect`, `detach`, `deassociate`
**Scope**: Removing associations between entities (inverse of `link`)

```bash
# CORRECT
cleo research unlink R001 T123

# INCORRECT
cleo research disconnect R001 T123
cleo research detach R001 T123
```

**MCP Usage**: `research.unlink`

**Note**: `unlink` is the canonical inverse of `link`. Do not use `remove` or `delete` for dissociation.

---

### 32. Compute (Derive Values)

**Standard**: `compute`
**Replaces**: `calculate`, `derive`, `eval` (when computing derived metrics or values)
**Scope**: Computing dependency graphs, metrics, checksums, and derived task values

```bash
# CORRECT
cleo compute metrics
cleo compute dependencies T123

# INCORRECT
cleo calculate metrics
cleo derive dependencies T123
```

**MCP Usage**: `orchestrate.compute`

**Note**: `compute` is for deriving a single value or metric (checksum, dependency depth, complexity score). It does NOT cover composite multi-query aggregation — use `plan` for that. Internal function names like `computeChecksum()` or `computeWaves()` are not MCP operations and are unaffected by verb standards.

---

### 33. Plan (Composite Read / Planning View)

**Standard**: `plan`
**Replaces**: — (new verb; does not replace any existing verb)
**Scope**: Composite read operations that aggregate multiple queries into a single planning/dashboard view. Part of the BRAIN working memory loop (ADR-009).

```bash
# CORRECT
cleo plan
cleo plan --epic T4840

# INCORRECT
cleo compute plan        # compute is for deriving values, not aggregating queries
cleo schedule plan       # schedule is for deferring future work
cleo list --view plan    # plan is its own verb, not a list filter
```

**MCP Usage**: `tasks.plan`

**Rationale**: `plan` is a composite query operation that aggregates in-progress epics, ready tasks, blocked tasks, and open bugs into a single planning view. It doesn't compute a derived value (`compute`) and it doesn't schedule future work (`schedule`). Neither existing verb fits. The `schedule` verb entry previously listed `plan` as a replaced verb, but that referred to "planning to do work later" (scheduling), not "viewing a planning dashboard" (composite read). These are semantically distinct operations.

---

### 34. Schedule (Defer Work)

**Standard**: `schedule`
**Replaces**: `defer`, `queue` (when scheduling tasks for future execution)
**Scope**: Scheduling tasks and operations for deferred execution

```bash
# CORRECT
cleo schedule T123 --after T456
cleo schedule --cron "0 9 * * 1"

# INCORRECT
cleo defer T123
cleo queue T123
```

**MCP Usage**: `tasks.schedule`

---

### 35. Cancel (Cancel Task)

**Standard**: `cancel`
**Replaces**: `abort`, `kill` (when cancelling a task without archiving)
**Scope**: Marking a task as cancelled (terminal state, not deleted)

```bash
# CORRECT
cleo cancel T123
cleo cancel T123 --reason "Requirements changed"

# INCORRECT
cleo abort T123
cleo kill T123
```

**MCP Usage**: `tasks.cancel`

**Note**: `cancel` sets status to `cancelled` (soft terminal state). Use `delete` to permanently remove. Use `archive` to move to archive store.

---

### 36. Sync (Synchronize Data)

**Standard**: `sync`
**Replaces**: `pull`, `push`, `reconcile` (when synchronizing data between stores)
**Scope**: Syncing with TodoWrite, external providers, and data stores

```bash
# CORRECT
cleo system sync
cleo sync --provider todowrite

# INCORRECT
cleo pull
cleo reconcile
```

**MCP Usage**: `system.sync`

---

### 37. Inspect (Examine Internals)

**Standard**: `inspect`
**Replaces**: `diagnose`, `debug`, `examine` (when examining internal system state)
**Scope**: Inspecting database state, session internals, and system diagnostics

```bash
# CORRECT
cleo inspect db
cleo inspect session S001
cleo inspect T123 --raw

# INCORRECT
cleo diagnose db
cleo debug session
```

**MCP Usage**: `system.inspect`, `admin.inspect`

**Note**: `inspect` exposes raw internal state for debugging. Use `show` for normal entity retrieval.

### 38. Store (Append-Only Memory Write)

**Canonical verb**: `store`
**Replaces**: `add` for append-only memory operations, `write` for audit-trail entries
**Scope**: Memory domain (BRAIN memory operations)

```bash
# CORRECT
cleo memory store --type pattern --content "Parallel waves reduce blocker cascades"
cleo memory store --type learning --content "Epic decomposition works best at 5-7 subtasks"

# INCORRECT
cleo memory add ...  # Use 'store' for memory, 'add' for tasks
cleo memory create ...
```

**MCP Usage**: `memory.pattern.store`, `memory.learning.store`

**Rationale**: `store` is distinct from `add` because memory entries are append-only, support deduplication via running averages, and are not user-managed entities. `add` implies CRUD lifecycle; `store` implies accumulation.

### 39. Recall (Semantic Memory Retrieval)

**Canonical verb**: `recall` (CLI alias for `search` in memory context)
**Replaces**: `find` for natural-language memory queries, `search` for semantic retrieval
**Scope**: Memory domain (BRAIN memory operations)

```bash
# CORRECT
cleo memory recall "atomic operations pattern"
cleo memory recall "blocker" --type pattern --limit 5

# INCORRECT
cleo memory find ...  # Use 'recall' for memory, 'find' for tasks
cleo memory get ...
```

**MCP Usage**: `memory.pattern.search`, `memory.learning.search` (MCP uses `search` internally; `recall` is CLI surface only)

**Rationale**: `recall` is the human-facing synonym for memory retrieval, distinct from `find` which operates on structured task data. In MCP, `search` is used for consistency with the existing query verb pattern.

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
{domain}.{action}              → tasks.add, session.start
{domain}.{namespace}.{action}  → validate.protocol, gate.pass
```

#### Multi-Word Commands

Use **kebab-case** for multi-word commands:

```bash
# CORRECT
cleo archive-stats
cleo generate-changelog

# INCORRECT
cleo archiveStats
cleo generate_changelog
```

### Parameter Naming

#### Standard Flags (LAFS Protocol)

**Global Output Format Flags** (apply to all commands):

| Purpose | Flag | Description |
|---------|------|-------------|
| JSON output | `--json` | Output in JSON format (default) |
| Human-readable | `--human` | Output in human-readable format |
| Quiet mode | `--quiet` | Suppress non-essential output for scripting |

---

## Verb Quick Reference

### By Category

#### Task Operations

```
add         Create new task
show        Display task details
list        List tasks with filters
find        Search tasks
update      Modify task properties
delete      Remove task permanently
archive     Archive completed/cancelled tasks
restore     Restore task from terminal state
complete    Mark task as done
start       Begin working on task
stop        Stop working on task
cancel      Mark task as cancelled (terminal, not deleted)
plan        Composite planning view (aggregates multiple queries)
schedule    Defer task to future execution
```

#### Session Operations

```
start       Begin new session
stop        End current session (alias: end)
status      Show session status
resume      Resume existing session
suspend     Pause session without ending
list        List sessions
record      Record decision or assumption
```

#### System Operations

```
init        Initialize CLEO project
backup      Create backup
restore     Restore from backup
migrate     Run schema migrations
check       Health/liveness probe
repair      Fix data inconsistencies
sync        Synchronize data stores
inspect     Examine internal state
config.set  Set config value
config.show Get config value (config.get accepted as alias)
```

#### Research Operations

```
show        Research entry details
list        List research entries
find        Find research
inject      Get protocol injection
link        Link research to task
unlink      Remove research-task link
resolve     Resolve research conflicts
compute     Compute derived values
```

#### BRAIN Memory Operations

```
store       Append-only memory write (patterns, learnings)
recall      Semantic memory retrieval (CLI alias for search)
stats       Aggregate memory statistics
```

#### Validation Operations

```
validate    Schema/protocol/task validation
verify      Artifact gate verification
check       Health check (distinct from validate)
compliance  Compliance summary and violations
test.run    Execute test suite
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

### 2026.2.27 - BRAIN Memory Verb Addition (T4763, T4780)

- **Added**: `store` as 38th canonical verb for append-only BRAIN memory writes
- **Added**: `recall` as 39th canonical verb (CLI alias for memory search)
- **Added**: BRAIN Memory Operations category to Verb Quick Reference
- **Rulings**: `store` vs `add` — use `store` for memory accumulation, `add` for task creation. `recall` vs `find` — use `recall` for semantic memory retrieval, `find` for structured task search.
- **Deferred**: `consolidate`, `predict`, `suggest`, `spawn`, `kill`, `learn`, `score` — pending Reasoning R&C outcome

### 2026.2.27 - Plan Verb Addition (T4914, T4911)

- **Added**: `plan` as 37th canonical verb for composite read/planning view operations
- **Clarified**: `compute` scope narrowed — removed `tasks.compute` MCP reference; `compute` is for deriving single values/metrics only
- **Clarified**: `schedule` no longer lists `plan` as a replaced verb — `plan` (composite query) and `schedule` (defer work) are semantically distinct
- **Rationale**: BRAIN working memory loop (ADR-009 Phase 1) requires a composite planning view that aggregates multiple queries. Neither `compute` nor `schedule` fits this use case.
- **Total canonical verbs**: 37 (was 36)

### 2026.2.25 - Additional Verb Documentation (T4791)

- **Added**: 9 new verb entries: `check`, `repair`, `resolve`, `unlink`, `compute`, `schedule`, `cancel`, `sync`, `inspect`
- **Note**: `validate`, `record`, `link`, `archive`, `restore`, `verify` were already documented; confirmed and retained

### 2026.2.20 - Missing Verb Documentation

- **Added**: 17 verbs documented: `validate`, `record`, `resume`, `suspend`, `reset`, `init`, `enable`, `disable`, `backup`, `migrate`, `verify`, `inject`, `run`, `end`, `link`, `configure`
- **Added**: Known Verb Violations section tracking `config.get`, `reopen`, `uncancel` deviations

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

- **Tasks**: T4732 (Naming Standardization), T4791 (Missing Verb Documentation), T4792 (Fix Verb Violations)
- **Related**: RFC 2119 (MUST/SHOULD/MAY definitions)
- **Mintlify version**: `docs/mintlify/specs/VERB-STANDARDS.md`
- **Validation**: `cleo compliance` commands

---

**Document Maintenance**: Updates to this document require Task ID reference and approval from core maintainers.
