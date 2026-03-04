# CLEO Verb Standards

**Version**: 2026.3.3
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
| Create new entity | `add` | `install`, `prepare`, `start` (when creating) | Enforced |
| Read single | `show` | — | Enforced |
| Read list | `list` | - | Enforced |
| Search | `find` | `search` | Enforced |
| Modify | `update` | `configure`, `modify`, `edit` | Enforced |
| Remove | `delete` | `remove`, `uninstall` | Enforced |
| Soft-delete | `archive` | - | Enforced |
| Restore | `restore` | `unarchive`, `reopen`, `uncancel` | Enforced |
| Finish work | `complete` | `end`, `done`, `finish` | Enforced |
| Begin work | `start` | `focus-set` | Enforced |
| Stop work | `stop` | `focus-clear` | Enforced |
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
| End session | `end` | - (MCP operation) | Enforced |
| Link entities | `link` | `connect`, `associate`, `attach` | Enforced |
| Health check | `check` | `ping`, `probe`, `test` (when checking liveness) | Enforced |
| Data repair | `repair` | `fix`, `heal`, `correct` (when repairing data) | Reserved |
| Conflict resolution | `resolve` | `settle`, `fix`, `merge` (when resolving conflicts) | Reserved |
| Unlink entities | `unlink` | `disconnect`, `detach`, `deassociate` | Enforced |
| Compute value | `compute` | `calculate`, `derive`, `eval` (when computing metrics) | Enforced |
| Composite read | `plan` | — (composite multi-query aggregation for planning views) | Enforced |
| Schedule work | `schedule` | `defer`, `queue` (when scheduling tasks for future execution) | Reserved |
| Cancel task | `cancel` | `abort`, `stop`, `kill` (when cancelling tasks) | Reserved |
| Synchronize data | `sync` | `pull`, `push`, `reconcile` (when syncing stores) | Enforced |
| Inspect internals | `inspect` | `diagnose`, `debug`, `examine` (when inspecting state) | Reserved |
| Save observation | `observe` | `note`, `capture` (when saving observations to cognitive memory) | Enforced |
| Append-only write | `store` | `add` for memory, `write` for audit entries | Enforced |
| Batch retrieve | `fetch` | — (new verb; batch retrieval by ID array) | Enforced |
| Chronological context | `timeline` | — (new verb; anchored context retrieval) | Enforced |

---

## Verb Usage Rules

### 1. Add (Create)

**Standard**: `add`
**Replaces**: `install`, `prepare`, `new`

```bash
# CORRECT
cleo add "Task title"
cleo backup add
cleo release add v1.0.0

# INCORRECT
cleo new "Task title"
```

**MCP Usage**: `tasks.add`

---

### 2. Show (Read Single)

**Standard**: `show`
**Replaces**: `display`, `view`

```bash
# CORRECT
cleo show T123
cleo config show key

# INCORRECT
cleo display T123
```

**MCP Usage**: `tasks.show`, `config.show`

---

### 3. List (Read Multiple)

**Standard**: `list`

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
**Replaces**: `search`

```bash
# CORRECT
cleo find "keyword"

# INCORRECT
cleo search "keyword"
```

**MCP Usage**: `tasks.find`, `tools.skill.find`

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
**Replaces**: `focus-set`

```bash
# CORRECT
cleo start T123

# INCORRECT
cleo focus-set T123
```

**MCP Usage**: `tasks.start`, `session.start`

---

### 11. Stop (Stop Work)

**Standard**: `stop`
**Replaces**: `focus-clear`

```bash
# CORRECT
cleo stop
```

**MCP Usage**: `tasks.stop`, `session.end`

**Note**: In MCP, the canonical session termination operation is `session.end`. In CLI, the canonical command is `stop`.

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
cleo pipeline validate --stage implementation
cleo validate schema
cleo validate protocol

# INCORRECT
cleo pipeline check --stage implementation
```

**MCP Usage**: `pipeline.stage.validate`, `check.schema`, `check.protocol`

**Note**: `validate` is for compliance and schema checks. For liveness checks, use `check`. For artifact-level gate verification, use `verify`.

---

### 14. Record (Log Events)

**Standard**: `record`
**Replaces**: `log` (when recording structured events, not reading logs)
**Scope**: Recording lifecycle stage completions, session decisions, assumptions, and compliance checks

```bash
# CORRECT
cleo pipeline record --stage research --epicId T001
cleo compliance record --taskId T123

# INCORRECT
cleo pipeline log --stage research
```

**MCP Usage**: `pipeline.stage.record`, `session.record.decision`, `check.compliance.record`

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
cleo pipeline reset --stage implementation --epicId T001

# INCORRECT
cleo pipeline clear --stage implementation
```

**MCP Usage**: `pipeline.stage.reset`

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

**MCP Usage**: `admin.init`

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

**MCP Usage**: `tools.skill.enable`, `tools.skill.disable`

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

**MCP Usage**: `admin.backup`

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

**MCP Usage**: `admin.migrate`

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

**MCP Usage**: `tools.skill.verify`

**Note**: `verify` focuses on artifact-level checks (gates, frontmatter). Use `validate` for schema/protocol compliance.

---

### 23. Inject (Protocol Injection)

**Standard**: `inject`
**Replaces**: `insert`, `load` (when injecting protocol content)

```bash
# CORRECT
cleo memory inject --protocol memory

# INCORRECT
cleo insert protocol
```

**MCP Usage**: `session.context.inject`, `tools.provider.inject`, `admin.inject.generate`

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

**MCP Usage**: `check.test.run`, `pipeline.release.gates.run`

**Rule**: `run` MUST always be used as part of a compound verb. Never use as a standalone verb.

---

### 25. End (Terminate Session — MCP)

**Standard**: `end` (MCP operation name)
**CLI equivalent**: `stop`

**MCP Usage**: `session.end`

---

### 26. Link (Associate Entities)

**Standard**: `link`
**Replaces**: `connect`, `associate`, `attach`
**Scope**: Linking memory entries to tasks

```bash
# CORRECT
cleo memory link M001 T123

# INCORRECT
cleo memory connect M001 T123
```

**MCP Usage**: `memory.link`

---

### 27. Configure — Removed (See §5 Update)

`configure` is not a standalone canonical verb. Use `update` (§5) for entity modification.

The `tools.skill.configure` operation exists in the registry as a compound sub-operation for skill-specific parameter adjustment, but it does not constitute a canonical standalone verb. The Standard Verb Matrix (§2) confirms that `update` replaces `configure` (line 25).

**Removed from Enforced matrix**: 2026.3.3 (T5253). See [Reserved & Planned Verbs](#reserved--planned-verbs) for tracking.

---

### 28. Check (Liveness / Health Check)

**Standard**: `check`
**Replaces**: `ping`, `probe`, `test` (when checking system liveness or health)
**Scope**: Liveness checks, health probes, and precondition checks

```bash
# CORRECT
cleo admin check
cleo check --health

# INCORRECT
cleo ping
cleo probe
```

**MCP Usage**: `admin.health`, `check.coherence.check`

**Distinction from `validate`**: `check` is for liveness and health probing. `validate` is for compliance and schema correctness. `verify` is for artifact gates.

---

### 29. Repair (Data Repair)

**Standard**: `repair`
**Replaces**: `fix`, `heal`, `correct` (when repairing corrupted or inconsistent data)
**Scope**: Sequence counter repair, data integrity repair, index repair

```bash
# CORRECT
cleo admin repair --sequence
cleo repair index

# INCORRECT
cleo fix sequence
cleo heal data
```

**MCP Usage**: `admin.repair` [Reserved — not yet implemented in registry]

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

**MCP Usage**: `tools.issue.resolve` [Reserved — not yet implemented in registry]

---

### 31. Unlink (Dissociate Entities)

**Standard**: `unlink`
**Replaces**: `disconnect`, `detach`, `deassociate`
**Scope**: Removing associations between entities (inverse of `link`)

```bash
# CORRECT
cleo memory unlink M001 T123

# INCORRECT
cleo memory disconnect M001 T123
cleo memory detach M001 T123
```

**MCP Usage**: `memory.unlink`

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

**MCP Usage**: `tasks.schedule` [Reserved — not yet implemented in registry]

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

**MCP Usage**: `tasks.cancel` [Reserved — not yet implemented in registry]

**Note**: `cancel` sets status to `cancelled` (soft terminal state). Use `delete` to permanently remove. Use `archive` to move to archive store.

---

### 36. Sync (Synchronize Data)

**Standard**: `sync`
**Replaces**: `pull`, `push`, `reconcile` (when synchronizing data between stores)
**Scope**: Syncing with TodoWrite, external providers, and data stores

```bash
# CORRECT
cleo admin sync
cleo sync --provider todowrite

# INCORRECT
cleo pull
cleo reconcile
```

**MCP Usage**: `admin.sync`

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

**MCP Usage**: `admin.inspect` [Reserved — not yet implemented in registry]

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

**MCP Usage**: `memory.decision.store`, `memory.pattern.store`, `memory.learning.store`

**Rationale**: `store` is distinct from `add` because memory entries are append-only, support deduplication via running averages, and are not user-managed entities. `add` implies CRUD lifecycle; `store` implies accumulation.

### 39. Recall (Semantic Memory Retrieval)

**Canonical verb**: `recall`
**Replaces**: `search` for semantic retrieval
**Scope**: Memory domain (BRAIN memory operations)

```bash
# CORRECT
cleo memory recall "atomic operations pattern"
cleo memory recall "blocker" --type pattern --limit 5

# INCORRECT
cleo memory search ...
```

**MCP Usage**: `memory.find`, `memory.pattern.find`, `memory.learning.find` (MCP uses `find` consistently; `recall` is CLI surface only)

**Rationale**: `recall` is the human-facing synonym for memory retrieval. In MCP, the memory domain now uses `find` consistently with all other domains, eliminating the previous `search` carve-out.

---

### 40. Observe (Save Observation)

**Standard**: `observe`
**Replaces**: `note`, `capture` (when saving observations to cognitive memory)
**Scope**: Memory domain — saving raw observations to brain.db

```bash
# CORRECT
cleo memory observe --text "Discovered pattern in auth flow"

# INCORRECT
cleo memory add --text "..."
cleo memory write --text "..."
```

**MCP Usage**: `memory.observe`

**Note**: `observe` is the append-only write operation for raw observations to brain.db. Distinct from `store` which is used for structured memory types (patterns, learnings, decisions).

---

### 41. Fetch (Batch Retrieve by IDs)

**Standard**: `fetch`
**Replaces**: — (new verb; does not replace any existing verb)
**Scope**: Memory domain — step 3 of 3-layer retrieval workflow

```bash
# CORRECT
cleo memory fetch --ids O-abc123,O-def456

# INCORRECT
cleo memory show O-abc123 O-def456  # 'show' is single-entity; 'fetch' is batch
cleo memory get --ids ...            # 'get' is deprecated
```

**MCP Usage**: `memory.fetch`

**Note**: `fetch` is the batch retrieval verb for the 3-layer cognitive retrieval pattern: `find` (search index) → `timeline` (context) → `fetch` (full details). Distinct from `show` (single entity by ID) and `list` (filtered collection).

---

### 42. Timeline (Chronological Context)

**Standard**: `timeline`
**Replaces**: — (new verb; does not replace any existing verb)
**Scope**: Memory domain — step 2 of 3-layer retrieval workflow

```bash
# CORRECT
cleo memory timeline --anchor O-abc123
cleo memory timeline --query "authentication"

# INCORRECT
cleo memory context O-abc123
```

**MCP Usage**: `memory.timeline`

**Note**: `timeline` is step 2 of the BRAIN 3-layer retrieval workflow: (1) `find` → get index with IDs, (2) `timeline` → get chronological context around an anchor, (3) `fetch` → get full details for filtered IDs. Use after `memory find` to understand context before committing to `memory fetch`.

---

## Naming Conventions

### Command Structure

#### Domain-Action Pattern

```
{domain}.{action}              → tasks.add, session.start
{domain}.{namespace}.{action}  → check.protocol, pipeline.stage.validate
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
stop        End current session
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
config.show Get config value
```

#### Memory Operations

```
show        Memory entry details
list        List memory entries
find        Find memory
inject      Get protocol injection
link        Link memory to task
unlink      Remove memory-task link
resolve     Resolve memory conflicts
compute     Compute derived values
store       Append-only memory write (patterns, learnings)
recall      Semantic memory retrieval
stats       Aggregate memory statistics
timeline    3-layer retrieval step: chronological context around anchor
fetch       3-layer retrieval step: full details for filtered IDs
observe     Save observation to brain.db (mutate gateway)
```

#### Validation Operations

```
validate    Schema/protocol/task validation
verify      Artifact gate verification
check       Health check (distinct from validate)
compliance  Compliance summary and violations
test.run    Execute test suite
```

#### Sticky Operations (Domain: sticky)

All sticky operations use the `sticky.*` namespace (canonical 10th domain):

```
add         Create new sticky note
list        List sticky notes
show        Show sticky note details
convert     Convert sticky to task or memory
archive     Archive sticky note
```

**CLI Examples:**
```bash
cleo sticky add "Check edge case in validation"
cleo sticky add "Bug: login fails" --tag bug --priority high
cleo sticky list
cleo sticky list --tag bug
cleo sticky show SN-042
cleo sticky convert SN-042 --to-task --title "Fix validation"
cleo sticky archive SN-042
```

**Note**: Sticky notes are lightweight capture entries. The `convert` verb promotes them to formal entities (tasks or memory). Unlike other domains, sticky uses `convert` instead of `complete` for promotion workflows, and does not support `update`, `delete`, or `restore` operations.

#### Nexus.Share Operations

All sharing operations are under the `nexus.share.*` sub-namespace (10 operations):

```
nexus.share.status           Query sharing status
nexus.share.remotes          List configured remotes
nexus.share.sync.status      Query sync status
nexus.share.snapshot.export  Export project snapshot
nexus.share.snapshot.import  Import project snapshot
nexus.share.sync.gitignore   Sync gitignore with CLEO paths
nexus.share.remote.add       Add sharing remote
nexus.share.remote.remove    Remove sharing remote
nexus.share.push             Push to sharing remote
nexus.share.pull             Pull from sharing remote
```

**MCP Examples:**
```bash
query { domain: "nexus", operation: "share.status" }
query { domain: "nexus", operation: "share.remotes" }
mutate { domain: "nexus", operation: "share.push" }
mutate { domain: "nexus", operation: "share.snapshot.export" }
```

**Note**: Sharing operations have always been under `nexus.share.*`. There was no `sharing` domain in production.

---

## Enforcement

### Code Review Checklist

- [ ] New commands use standard verbs
- [ ] Subcommands follow naming conventions

- [ ] Documentation updated with examples
- [ ] Tests use standard verbs only

### CI/CD Gates

- Verb standardization linting
- Command structure validation
- Documentation drift detection

---

## Reserved & Planned Verbs

These verbs appear in the Standard Verb Matrix with **Reserved** status. They are documented here for planning purposes but are **not yet implemented** in the registry. Do not use them in MCP operations until they are promoted to Enforced status.

### Reserved Verbs (Documented but Not Implemented)

| Verb | Intended Domain | Rationale | Originally Added |
|------|-----------------|-----------|------------------|
| `repair` | `admin` | Data integrity repair (sequence counters, indexes). No `admin.repair` in Constitution domain tables. Awaiting implementation. | T4791 (2026.2.25) |
| `resolve` | `tools.issue` | Conflict/issue resolution. No `tools.issue.resolve` in registry. Awaiting implementation. | T4791 (2026.2.25) |
| `schedule` | `tasks` | Deferred task execution. No `tasks.schedule` in registry. Awaiting implementation. | T4791 (2026.2.25) |
| `cancel` | `tasks` | Task cancellation (terminal state). No `tasks.cancel` in registry. Note: `admin.job.cancel` exists for background jobs but is a different concept. | T4791 (2026.2.25) |
| `inspect` | `admin` | Internal state examination. Registry verb exists but no entry in Constitution domain tables. Awaiting formal registration. | T4791 (2026.2.25) |

### Deferred Verbs (Pending Design Decision)

| Verb | Context | Status |
|------|---------|--------|
| `consolidate` | BRAIN reasoning & consolidation | Pending Reasoning R&C outcome |
| `predict` | BRAIN predictive features | Pending Reasoning R&C outcome |
| `suggest` | BRAIN suggestion engine | Pending Reasoning R&C outcome |
| `spawn` | Agent orchestration | In registry as `orchestrate.spawn`; verb section deferred |
| `kill` | Agent termination | Pending design — may use `stop` instead |
| `learn` | BRAIN learning accumulation | Overlaps with `store` — pending clarification |
| `score` | Grading / quality scoring | In registry as `admin.grade`; verb section deferred |

### Removed from Enforced Matrix

| Verb | Was Line | Reason | Date |
|------|----------|--------|------|
| `configure` | 48 | Contradicts line 25 (`update` replaces `configure`). Zero standalone operations in registry. `tools.skill.configure` is a compound operation under `update` semantics. | 2026.3.3 |
| `repair` | 50 | Not in registry or Constitution Sec 4. Moved to Reserved. | 2026.3.3 |
| `resolve` | 51 | Not in registry or Constitution Sec 4. Moved to Reserved. | 2026.3.3 |
| `schedule` | 55 | Not in registry or Constitution Sec 4. Moved to Reserved. | 2026.3.3 |
| `cancel` | 56 | Not in registry as `tasks.cancel`. `job.cancel` is different semantics. Moved to Reserved. | 2026.3.3 |
| `inspect` | 58 | Not in Constitution domain tables. Moved to Reserved. | 2026.3.3 |

---

## Migration History

### 2026.3.3 - Verb Standards Alignment and Domain Restructure (verb-standards-alignment)

**Verb Matrix Changes:**
- **Removed**: `configure` as standalone enforced verb. Redirected to §5 Update. `tools.skill.configure` is a compound sub-operation, not a canonical standalone verb.
- **Reclassified to Reserved**: `repair`, `resolve`, `schedule`, `cancel`, `inspect` — declared Enforced but not yet implemented in registry
- **Added as Enforced**: `observe` (§40), `fetch` (§41), `timeline` (§42) — missing from documentation but in registry and Constitution since BRAIN cutover (T5241)
- `store` (§38) and `recall` (§39) already existed — verified and MCP Usage lines corrected

**Namespace Corrections (22 replacements):**
All MCP examples updated to use current canonical domains:
- `lifecycle.*` → `pipeline.*` (stage.validate, stage.record, stage.reset)
- `system.*` → `admin.*` (init, backup, migrate, check, repair, sync, inspect)
- `skills.*` → `tools.skill.*` (find, enable, disable, verify)
- `providers.*` → `tools.provider.*` (inject)
- `validate.*` → `check.*` (schema, protocol, compliance.record, test.run)
- `issues.*` → `tools.issue.*` (resolve)
- `memory.inject` → `session.context.inject`

**Bug Fixes:**
- §10 Start: INCORRECT example was identical to CORRECT example — fixed to show `cleo focus-set T123`
- §10 Start / §11 Stop: Removed `tasks.start` and `tasks.stop` from Replaces fields (these are canonical operation names, not deprecated verbs)
- §27 Configure: Rewritten as redirect note — `configure` is not a standalone canonical verb

**Domain Restructure:**
- `sharing` domain absorbed into `nexus` — 10 operations moved to `nexus.share.*` namespace
- `sticky` domain added as 10th canonical domain — 5 operations: sticky.add, sticky.list, sticky.show, sticky.convert, sticky.archive

**Reserved & Planned Verbs:** New section added documenting reclassified verbs with planned MCP addresses.

**Enforced verb count:** 36 (was 39; removed 6 including `configure`, added 4: `observe`, `store`, `fetch`, `timeline`; net -2; `store` was missing from matrix but had §38 section)

**Version alignment:** Synchronized with CLEO-OPERATION-CONSTITUTION.md at 2026.3.3

### 2026.3.3 - Domain Restructure: Final Domain Consolidation (T5276, T5267)

- **Finalized**: 10 canonical domains: tasks, session, memory, check, pipeline, orchestrate, tools, admin, nexus, sticky
- **Added**: `sticky` domain (5 operations): `add`, `list`, `show`, `convert`, `archive`
- **Confirmed**: `nexus` domain includes 10 `share.*` sub-namespace operations (total 22 operations)
- **New verbs**: `convert` for sticky-to-entity promotion workflows
- **Updated**: Total operations: 198 (119 query + 79 mutate)
- **Documentation**: Added Sticky Operations and Nexus.Share Operations sections to Verb Quick Reference
- **No migration needed**: Sharing operations were always under `nexus.share.*`

### 2026.2.27 - BRAIN Memory Verb Addition (T4763, T4780)

- **Added**: `store` as 38th canonical verb for append-only BRAIN memory writes
- **Added**: `recall` as 39th canonical verb
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
- **Added**: Verb compliance tracking section for standardization monitoring

### 2026.2.5 - Verb Standardization Release

- **Changed**:
  - `unarchive` → `restore task`
  - `reopen` → `restore task`
  - `uncancel` → `restore task`
  - `backup create` → `backup add`
  - `release create` → `release add`
  - `session end` → `session stop`
  - `nexus query` → `nexus show`

---

## References

- **Tasks**: T4732 (Naming Standardization), T4791 (Missing Verb Documentation), T4792 (Fix Verb Violations)
- **Related**: RFC 2119 (MUST/SHOULD/MAY definitions)
- **Mintlify version**: Removed (was `docs/mintlify/specs/VERB-STANDARDS.md`, now consolidated here)
- **Validation**: `cleo compliance` commands

---

**Document Maintenance**: Updates to this document require Task ID reference and approval from core maintainers.
