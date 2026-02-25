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
cleo orchestrator spawn T1575  # Auto-detects epic → uses decomposition protocol

# 4. Wait for decomposition completion
cleo research show <research-id>

# 5. Continue with wave-0 tasks
cleo orchestrator next --epic T1575
```

## Pattern: Resuming Interrupted Work

```bash
# 1. Check state on conversation start
cleo orchestrator start --epic T1575
# Shows: session active, current T1586, next task T1589

# 2. Check for incomplete subagent work
cleo research pending
# Shows: needs_followup: ["T1586"]

# 3. Resume focused task or spawn followup
cleo show T1586 --brief
cleo orchestrator spawn T1586  # Re-spawn if needed
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
cleo orchestrator next --epic T1575
cleo orchestrator spawn T1590
```

## Pattern: Parallel Execution

```bash
# 1. Analyze dependency waves
cleo orchestrator analyze T1575
# Shows: Wave 0: T1578, T1580, T1582 (no deps)

# 2. Verify parallel safety
cleo orchestrator ready --epic T1575
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
cleo orchestrator ready --epic T1575 --phase core

# 3. Spawn within phase context
cleo orchestrator spawn T1586

# 4. When phase complete, advance
cleo phases stats
cleo phase advance  # Move to testing phase
```

## Pattern: Quality Gates Workflow

```bash
# 1. Subagent completes implementation
# Returns: "Implementation complete. See MANIFEST.jsonl for summary."

# 2. Orchestrator verifies output
cleo research show <research-id>
cleo show T1586

# 3. Spawn validation subagent
cleo orchestrator spawn T1590  # Validation task

# 4. Set verification gates
cleo verify T1586 --gate testsPassed
cleo verify T1586 --gate qaPassed
cleo verify T1586 --all

# 5. Parent epic auto-completes when all children verified
```

## Pattern: Release Workflow

**Release tasks use the `release` protocol** via `cleo release` commands.

```bash
# 1. Verify all epic tasks complete
cleo list --parent T1575 --status pending  # Should be empty

# 2. Run pre-release validation
./tests/run-all-tests.sh
cleo validate

# 3. Create and ship release
cleo release create v0.85.0 --tasks T001,T002,T003
cleo release ship v0.85.0 --bump-version --create-tag --push

# Preview without changes:
cleo release ship v0.85.0 --bump-version --dry-run
```

**IMPORTANT**: `dev/release-version.sh` is **DEPRECATED** (since v0.78.0).
Always use `cleo release create` → `cleo release ship`.

See `protocols/release.md` for the full release protocol specification.

## Full RCSD-to-Release Lifecycle

```bash
# RCSD PIPELINE (setup phase)
cleo orchestrator spawn T100  # research protocol
cleo orchestrator spawn T101  # consensus protocol
cleo orchestrator spawn T102  # specification protocol
cleo orchestrator spawn T103  # decomposition protocol

# EXECUTION (core phase)
cleo orchestrator spawn T104  # implementation protocol
cleo orchestrator spawn T105  # implementation protocol
# ...more implementation tasks...

# CONTRIBUTION (tracked automatically)
# contribution protocol auto-triggers for shared resources

# RELEASE (polish phase)
cleo release create v0.74.0 --tasks T104,T105
cleo release ship v0.74.0 --bump-version --create-tag --push
cleo session end --note "Feature X released v0.74.0"
```
