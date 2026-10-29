# Common HITL Patterns

> Referenced from: @skills/ct-orchestrator/SKILL.md
> Load when: Need executable workflow patterns for specific orchestrator scenarios

Executable workflows for typical orchestrator scenarios.

## Pattern: Starting Fresh Epic

```bash
# 1. HITL creates epic
cleo add "Implement auth system" --type epic --size large --phase core

# 2. Start orchestrator session
cleo session start --scope epic:T1575 --auto-start

# 3. Spawn planning subagent (decomposition protocol)
cleo orchestrate spawn T1575  # Auto-detects epic → uses decomposition protocol

# 4. Wait for decomposition completion
cleo research show <research-id>

# 5. Continue with wave-0 tasks
cleo orchestrate next T1575
```

## Pattern: Resuming Interrupted Work

```bash
# 1. Check state on conversation start
cleo session status
cleo orchestrate status --epic T1575
# Shows: session active, epic progress, ready tasks

# 2. Check for incomplete subagent work
cleo research pending
# Shows: needs_followup: ["T1586"]

# 3. Resume focused task or spawn followup
cleo show T1586
cleo orchestrate spawn T1586  # Re-spawn if needed
```

## Pattern: Handling Manifest Followups

```bash
# 1. Query manifest for pending items
cleo research pending
# Returns: { "T1586": ["Add error handling", "Write tests"] }

# 2. Create child tasks for followups
cleo add "Add error handling to auth" --parent T1586 --depends T1586
cleo add "Write auth tests" --parent T1586 --depends T1586

# 3. Spawn for new tasks
cleo orchestrate next T1575
cleo orchestrate spawn T1590
```

## Pattern: Parallel Execution

```bash
# 1. Analyze dependency waves
cleo orchestrate analyze T1575
# Shows: Wave 0: T1578, T1580, T1582 (no deps)

# 2. Verify parallel safety
cleo orchestrate ready T1575
# Returns: ["T1578", "T1580", "T1582"]

# 3. Spawn multiple subagents (different sessions)
# Session A spawns T1578
# Session B spawns T1580
# Session C spawns T1582

# 4. Monitor completion via manifest
cleo research list --status complete --limit 10
```

## Pattern: Phase-Aware Orchestration

```bash
# 1. Check current phase
cleo phase show
# Returns: "core"

# 2. Get tasks in current phase
cleo orchestrate ready T1575

# 3. Spawn within phase context
cleo orchestrate spawn T1586

# 4. When phase complete, advance
cleo phase list
cleo phase advance  # Move to testing phase
```

## Pattern: Quality Gates Workflow

```bash
# 1. Subagent completes implementation
# Returns: "Implementation complete. Manifest appended to pipeline_manifest."

# 2. Orchestrator verifies output
cleo research show <research-id>
cleo show T1586

# 3. Spawn validation subagent
cleo orchestrate spawn T1590  # Validation task

# 4. Record gate evidence (every gate needs programmatic evidence; bare --all is rejected)
cleo done T1586 --plan                                          # names the atoms each gate needs
cleo verify T1586 --gate testsPassed --evidence "ci:<pr>"       # or tool:test-affected
cleo verify T1586 --gate qaPassed --evidence "ci:<pr>"          # or tool:lint;tool:typecheck
cleo complete T1586

# 5. Parent epic auto-completes when all children verified
```

## Pattern: Release Workflow

**Release tasks use the `release` protocol** via `cleo release` commands.

A release is one command (ADR-099). Every change reaches main through a merged PR
first; the merge sweep has already closed their tasks.

```bash
# 1. Check the epic: closing tasks are merged with green CI, sweep pending
cleo list --parent T1575 --status pending

# 2. Preview: the green sha, its CI run, notes, packages, migrations, task report
cleo release cut v0.85.0 --dry-run

# 3. Tag and publish (release.yml builds, publishes and records the verdict)
cleo release cut v0.85.0
```

Provenance is reconciled automatically by the merge sweep. The old plan, open and
pr-status verbs and the hand-pushed tag are retired (T14114).

See `src/protocols/release.md` for the full release protocol specification.

## Full Epic Loop

```bash
# PLAN (one plan document, decisions in BRAIN, tasks with AC)
cleo orchestrate spawn T100  # research protocol: findings section
cleo orchestrate spawn T103  # decomposition protocol: tasks with deps + AC

# EXECUTION (core phase)
cleo orchestrate spawn T104  # implementation protocol
cleo orchestrate spawn T105  # implementation protocol
# ...more implementation tasks...

# CONTRIBUTION (tracked automatically)
# contribution protocol auto-triggers for shared resources

# RELEASE (polish phase)
cleo release cut v0.74.0 --dry-run
cleo release cut v0.74.0
cleo session end --note "Feature X released v0.74.0"
```
