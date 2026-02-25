# Autonomous Operation Quick Reference

**Spec**: [AUTONOMOUS-ORCHESTRATION-SPEC.md](../../../docs/specs/AUTONOMOUS-ORCHESTRATION-SPEC.md)

## Corrected Injection Template

Use this protocol block when operating autonomously:

```markdown
## Autonomous Orchestration Protocol

### IMMUTABLE CONSTRAINTS

| ID | Level | Rule |
|----|-------|------|
| AUTO-001 | MUST | Spawn ALL subagents (subagents MUST NOT spawn other subagents) |
| AUTO-002 | MUST | Read manifest `key_findings` for handoff (NOT full output files) |
| AUTO-003 | MUST | Decomposition is separate from orchestration |
| AUTO-004 | MUST | Verify manifest entry BEFORE spawning next agent |
| AUTO-005 | MUST | Compute dependency waves; spawn in wave order |
| AUTO-006 | MUST | Handle partial/blocked by creating followup tasks |
| CTX-002 | MUST | Auto-stop at 80% context; generate handoff |
| SESS-001 | MUST | Start with `cleo session list` |
| TOOL-001 | MUST NOT | Use TaskOutput tool (read manifest key_findings only) |

### WORKFLOW

1. **Session**: `cleo session list` → resume OR start with `--scope epic:T####`
2. **Waves**: `cleo orchestrator analyze T####` → compute dependency waves
3. **Spawn Loop**:
   - Spawn subagent via Task tool (subagent_type: cleo-subagent)
   - Wait for return message
   - Verify: `cleo research show <id>` → manifest entry exists
   - Link: `cleo research link T#### <id>`
   - Check wave dependencies before next spawn
4. **Context**: `cleo context` before each spawn → check threshold
5. **End**: `cleo session end --note "Wave N complete, next: T####"`

### PROHIBITED

- Subagent spawning subagents
- Reading full output files (use manifest summaries)
- Using TaskOutput tool to read subagent results (use manifest summaries only)
- Skipping manifest verification between spawns
- Continuing past 80% context without handoff
- Spawning out of dependency wave order
- Making architectural decisions without HITL
```

## Common Corrections

| Wrong Pattern | Correct Pattern | Constraint |
|---------------|-----------------|------------|
| "subagent hands off to subagent" | Orchestrator spawns ALL agents | AUTO-001 |
| "NEVER read Task Output" | Read manifest summaries only | AUTO-002 |
| "epic-architect creates full chain" | Decomposition is spawned subagent | AUTO-003 |
| Skip verification between spawns | Verify manifest before next spawn | AUTO-004 |
| No wave ordering | Use `cleo orchestrator analyze` | AUTO-005 |
| "Read TaskOutput for results" | Read manifest key_findings only | TOOL-001 |

## Decision Trees

### Should I Continue Autonomously?

```
┌─────────────────────────────────────────────┐
│ Is this an architectural decision?          │
└─────────────────────┬───────────────────────┘
                      │
          ┌───────────┴───────────┐
          │ YES                   │ NO
          ▼                       ▼
    ┌───────────┐         ┌─────────────────────────┐
    │ STOP      │         │ Is context >= 80%?      │
    │ HITL Gate │         └───────────┬─────────────┘
    └───────────┘                     │
                          ┌───────────┴───────────┐
                          │ YES                   │ NO
                          ▼                       ▼
                    ┌───────────┐         ┌─────────────────────┐
                    │ Generate  │         │ Are all dependencies│
                    │ Handoff   │         │ in wave resolved?   │
                    └───────────┘         └───────────┬─────────┘
                                                      │
                                          ┌───────────┴───────────┐
                                          │ YES                   │ NO
                                          ▼                       ▼
                                    ┌───────────┐         ┌───────────┐
                                    │ CONTINUE  │         │ WAIT for  │
                                    │ Spawn next│         │ blocking  │
                                    └───────────┘         │ tasks     │
                                                          └───────────┘
```

### When to Generate Handoff?

```
TRIGGER CONDITIONS (generate handoff if ANY):
├─ Context usage >= 80%
├─ User requests stop
├─ HITL gate reached (architectural decision)
├─ Wave boundary AND user requested pause
├─ Unrecoverable error
└─ Scope complete (all tasks done)

HANDOFF CONTENTS:
├─ session_id, epic_id, timestamp
├─ stop_reason (context_limit, wave_complete, hitl_gate, error, scope_complete)
├─ progress (completed_tasks, current_wave, waves_remaining)
├─ resume (command, next_tasks, blockers)
└─ context_snapshot (usage_percent, tokens_remaining)
```

### How to Resume from Handoff?

```bash
# 1. Read last handoff
cleo research list --type handoff --limit 1

# 2. Verify session exists
cleo session status <session_id>

# 3. Check for concurrent modifications
cleo session list --scope epic:<epic_id>

# 4. Resume if clear
cleo session resume <session_id>

# 5. Continue from next_tasks
cleo orchestrator next --epic <epic_id>
```

## Exit Codes

| Code | Constant | Meaning | Recovery |
|------|----------|---------|----------|
| 64 | EXIT_AUTONOMOUS_BOUNDARY | HITL gate reached | Wait for human decision |
| 65 | EXIT_HANDOFF_REQUIRED | Must generate handoff | Generate handoff, then stop |
| 66 | EXIT_RESUME_FAILED | Resume failed | Verify session/handoff state |
| 67 | EXIT_CONCURRENT_SESSION | Scope conflict | Wait or use different scope |

## Scope Boundaries

### Autonomous (proceed without HITL)

- Task execution within epic scope
- Dependency resolution and wave computation
- Manifest writing and status updates
- Spawning subagents in wave order
- Creating followup tasks for partial/blocked
- Small scope adjustments within epic

### Requires HITL

- Architectural decisions
- Scope expansion beyond epic
- Force/destructive operations
- Breaking changes
- Cross-epic work
- New epic creation
- Git push to main/master

## Manifest Entry for Handoff

```json
{"type":"session_handoff","timestamp":"2026-01-27T14:30:00Z","session_id":"session_20260127_143000_abc123","epic_id":"T1575","stop_reason":"context_limit","progress":{"completed_tasks":["T1576","T1577"],"current_wave":2,"waves_remaining":3},"resume":{"command":"cleo session resume session_20260127_143000_abc123","next_tasks":["T1579","T1580"],"blockers":[]},"context_snapshot":{"usage_percent":78,"tokens_remaining":22000},"agent_type":"handoff"}
```
