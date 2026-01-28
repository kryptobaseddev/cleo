# CLEO PRIME Architecture Specification

**Version**: 1.0.0
**Status**: Specification
**Author**: Backend Architect
**Date**: 2025-12-30

## Overview

**CLEO PRIME** defines the three-tier orchestration architecture where:
- **PRIME** = The primary agent (human-interacting orchestrator)
- **Session Agents** = Spawned Claude instances in tmux panes working on epics/task groups
- **Subagents** = Atomic task executors spawned by Session Agents via Task tool

This architecture enables **divide-and-conquer parallelism** while maintaining **context boundaries**, **state consistency**, and **clear responsibility separation**.

---

## Architecture Layers

### Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           PRIME AGENT                                │
│  • Human interaction                                                 │
│  • Epic decomposition                                                │
│  • Session Agent spawning                                            │
│  • Progress monitoring                                               │
│  • No implementation work                                            │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         │ spawns N Session Agents
                         │ (via tmux/zellij)
                         │
         ┌───────────────┼───────────────┬───────────────┐
         ▼               ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ Session Agent 0 │ │ Session Agent 1 │ │ Session Agent N │
│                 │ │                 │ │                 │
│ Scope: T001.*   │ │ Scope: T002.*   │ │ Scope: T00N.*   │
│                 │ │                 │ │                 │
│ • Task ordering │ │ • Task ordering │ │ • Task ordering │
│ • Subagent use  │ │ • Subagent use  │ │ • Subagent use  │
│ • Progress      │ │ • Progress      │ │ • Progress      │
│ • Implementation│ │ • Implementation│ │ • Implementation│
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         │ spawns Subagents  │                   │
         │ (via Task tool)   │                   │
         ▼                   ▼                   ▼
    ┌─────────┐         ┌─────────┐         ┌─────────┐
    │Subagent │         │Subagent │         │Subagent │
    │ T001.1  │         │ T002.1  │         │ T00N.1  │
    └─────────┘         └─────────┘         └─────────┘
```

---

## 1. PRIME Agent Responsibilities

### What PRIME DOES

| Responsibility | Implementation | Rationale |
|----------------|---------------|-----------|
| **Human Interaction** | Responds to user queries, clarifications, decisions | Only agent user sees directly |
| **Epic Analysis** | Analyzes epic structure, identifies parallelizable subtrees | Requires full epic context |
| **Task Assignment** | Computes scope boundaries for Session Agents | Prevents scope conflicts |
| **Session Spawning** | Launches tmux/zellij panes with Session Agents | Orchestration control |
| **Progress Monitoring** | Polls `sessions.json`, renders dashboard | Aggregates multi-agent state |
| **Conflict Detection** | Detects scope overlaps, dependency violations | Global state visibility |
| **Error Escalation Handling** | Receives escalations from Session Agents | Final decision authority |
| **Session Cleanup** | Archives completed sessions, handles failures | Lifecycle management |

### What PRIME DOES NOT DO

| Anti-Pattern | Why Prohibited | Correct Approach |
|--------------|----------------|------------------|
| **Implementation Work** | PRIME has no scope binding | Delegate to Session Agent |
| **Direct Task Execution** | No `cleo focus set` by PRIME | Session Agents own tasks |
| **File Editing** | Wastes PRIME's orchestration context | Session Agents/Subagents execute |
| **Detailed Code Review** | Context inefficiency | Session Agents review within scope |
| **Responding to Subagent Errors** | Bypasses Session Agent | Session Agents handle first |

### PRIME Context Management Strategy

**Context Budget Allocation:**
```
PRIME Context (100%)
├─ Epic Structure (30%)           # Task tree, dependencies, phase info
├─ Session Agent State (25%)      # Status, progress, current focus
├─ User Conversation (20%)        # Requirements, decisions, clarifications
├─ Orchestration Logic (15%)      # Assignment strategy, conflict rules
└─ Error Escalations (10%)        # Failure reports, blocker context
```

**Context Retention Policy:**
- **Keep**: Epic metadata, session assignments, high-level progress
- **Discard**: Implementation details, code snippets, detailed logs
- **Delegate**: Scope-specific context to Session Agents

**State Synchronization:**
```bash
# PRIME reads global state
cleo session list --status active    # All Session Agent states
cleo list --parent T998              # Epic children
cleo dash                            # Project overview

# PRIME never writes task state directly
# All task operations via Session Agents
```

---

## 2. Session Agent Responsibilities

### Core Duties

| Responsibility | Implementation | Rationale |
|----------------|---------------|-----------|
| **Scope Management** | Maintains `--scope subtree:T001` binding | Prevents task conflicts |
| **Task Sequencing** | Orders tasks by dependencies, priority | Efficient execution |
| **Subagent Spawning** | Uses Task tool for atomic task execution | Offloads simple work |
| **Implementation Work** | Edits files, runs commands, validates | Direct code manipulation |
| **Progress Reporting** | Updates `focus note`, task status | PRIME visibility |
| **Error Handling (L1)** | Retries, workarounds, local fixes | First-line resolution |
| **Escalation** | Reports blockers to PRIME when stuck | Escalation path |

### Scope Isolation

**Session Agent receives:**
```json
{
  "sessionId": "session_20251230100000_abc",
  "agentId": "agent-0",
  "scope": {
    "type": "subtree",
    "rootId": "T998.1",
    "taskIds": ["T998.1", "T998.1.1", "T998.1.2"]
  },
  "epicContext": {
    "id": "T998",
    "title": "Implement Authentication System",
    "phase": "core"
  },
  "instructions": "Complete all tasks in your scope. Use Subagents for simple tasks."
}
```

**Session Agent constraints:**
- CANNOT access tasks outside `scope.taskIds`
- CANNOT modify session scope after start
- CANNOT spawn new Session Agents (only PRIME can)
- CAN spawn Subagents for tasks within scope
- CAN suspend session if blocked externally

### Subagent Spawning Decisions

**When Session Agent spawns Subagent:**
```
Task Characteristics:
├─ Atomic (single file, <100 LOC)         → Subagent
├─ Well-defined (clear acceptance criteria) → Subagent
├─ No context dependency                   → Subagent
└─ Simple (no architecture decisions)      → Subagent

Task Characteristics:
├─ Complex (multi-file, architecture)      → Session Agent keeps
├─ Ambiguous (requires design decisions)   → Session Agent keeps
├─ Dependent (needs scope context)         → Session Agent keeps
└─ Critical (high risk)                    → Session Agent keeps
```

**Subagent Spawning Pattern:**
```bash
# Session Agent evaluates task T998.1.2
if is_atomic_task "T998.1.2"; then
    # Spawn Subagent via Task tool
    spawn_subagent "T998.1.2" "Implement JWT token validation"
else
    # Handle directly
    cleo focus set T998.1.2
    # ... implementation work ...
    cleo complete T998.1.2
fi
```

### Progress Reporting Protocol

**Session Agent reports to PRIME via state:**
```bash
# Focus updates (PRIME polls sessions.json)
cleo focus set T998.1.2
cleo focus note "Implementing JWT validation middleware"

# Task completion (updates todo.json)
cleo complete T998.1.2

# Session-level status (updates sessions.json)
cleo session suspend --note "Waiting for OAuth credentials from T999"
```

**PRIME detects changes:**
```bash
# Polling loop in PRIME
while orchestration_active; do
    sessions=$(cleo session list --format json)
    # Detect focus changes, completions, suspensions
    update_dashboard "$sessions"
    sleep 5
done
```

---

## 3. Subagent Responsibilities

**Subagents are ephemeral, atomic task executors spawned via Task tool.**

### Subagent Lifecycle

```
Session Agent (T998.1)
    │
    ├─ Identifies atomic task T998.1.2 "Add JWT validation"
    │
    ├─ Spawns Subagent via Task tool:
    │      Task: "Implement JWT token validation in auth middleware"
    │      Context: JWT library docs, middleware structure
    │
    └─ Subagent executes:
           1. Receives task + minimal context
           2. Implements solution (edits files, tests)
           3. Validates work (runs tests)
           4. Reports completion via Stop hook
           5. Terminates
```

### Subagent Context Budget

```
Subagent Context (100%)
├─ Task Definition (40%)        # Title, description, acceptance criteria
├─ Relevant Code (30%)          # Files to modify, adjacent code
├─ Dependencies (20%)           # Libraries, APIs, interfaces
└─ Validation (10%)             # Test commands, success criteria
```

**What Subagent receives:**
- Task ID, title, description
- File paths to modify
- Acceptance criteria
- Test commands

**What Subagent does NOT receive:**
- Epic context
- Session Agent scope
- Other tasks in epic
- PRIME orchestration state

### Subagent Completion Signal

**Via Stop Hook:**
```yaml
# .claude/hooks/subagent-complete.yaml
name: Subagent Completion Reporter
trigger: Stop
when: $CLEO_SUBAGENT_MODE == "true"

actions:
  - bash: |
      # Report completion to Session Agent via CLEO state
      if [ "$EXIT_STATUS" = "0" ]; then
          cleo complete "$CLEO_TASK_ID" --notes "Subagent completed"
      else
          cleo update "$CLEO_TASK_ID" --notes "Subagent failed: $EXIT_REASON"
      fi
```

---

## 4. Communication Protocol

### PRIME ↔ Session Agent Communication

**Channel**: CLEO state files (`sessions.json`, `todo.json`, `focus.json`)

**PRIME → Session Agent (Initialization):**
```bash
# PRIME spawns Session Agent in tmux pane
tmux send-keys -t "cleo-orch-T998:0.0" "
    export CLEO_SESSION='session_abc123'
    export CLEO_AGENT_ID='agent-0'
    export CLEO_SCOPE_ROOT='T998.1'
    cleo session start --scope subtree:T998.1 --agent agent-0
    claude --model claude-sonnet-4 --prompt agent-prompt.md
" Enter
```

**Session Agent → PRIME (Progress):**
```bash
# Session Agent updates state (PRIME polls)
cleo focus set T998.1.2              # Updates focus.json
cleo focus note "Working on JWT"     # Updates focus.sessionNote
cleo complete T998.1.2               # Updates todo.json
```

**Session Agent → PRIME (Escalation):**
```bash
# Session Agent suspends with escalation note
cleo session suspend --note "ESCALATION: Need OAuth credentials from external team. Blocking T998.1.3"
```

**PRIME detects escalation:**
```bash
# PRIME polling loop
sessions=$(cleo session list --format json)
escalations=$(echo "$sessions" | jq '.sessions[] | select(.status == "suspended" and (.notes | contains("ESCALATION")))')

if [ -n "$escalations" ]; then
    # PRIME notifies user, awaits decision
    echo "Session Agent agent-0 escalated: Need OAuth credentials"
fi
```

### Session Agent ↔ Subagent Communication

**Channel**: Task tool (Claude Code native)

**Session Agent → Subagent (Spawn):**
```typescript
// Session Agent spawns Subagent via Task tool
await claude.tools.task({
  title: "Implement JWT token validation",
  description: "Add token validation middleware to auth.js",
  context: `
    - File: src/auth/middleware.js
    - Use jsonwebtoken library
    - Validate signature, expiration, issuer
    - Test command: npm test -- auth.test.js
  `,
  acceptanceCriteria: [
    "Token validation function exists",
    "Tests pass",
    "Invalid tokens rejected"
  ]
});
```

**Subagent → Session Agent (Completion):**
```yaml
# Via Stop hook (subagent-complete.yaml)
# Writes to todo.json: task T998.1.2 status → done
# Session Agent polls todo.json, detects completion
```

**Subagent → Session Agent (Failure):**
```yaml
# Via Stop hook on error
# Writes to todo.json: task T998.1.2 notes → "Subagent failed: Missing JWT secret in env"
# Session Agent polls, detects failure, handles or escalates
```

---

## 5. Context Boundaries

### PRIME Context Boundaries

**What PRIME Retains:**
```json
{
  "epic": {
    "id": "T998",
    "title": "Implement Authentication System",
    "children": ["T998.1", "T998.2", "T998.3"],
    "dependencies": {...},
    "phase": "core"
  },
  "sessionAgents": [
    {
      "id": "agent-0",
      "scope": "subtree:T998.1",
      "status": "active",
      "currentFocus": "T998.1.2",
      "progress": {"completed": 2, "total": 3}
    }
  ],
  "userContext": "User requested OAuth support, GitHub + Google",
  "blockers": []
}
```

**What PRIME Discards:**
```
✗ Code snippets from Session Agents
✗ Detailed error stack traces
✗ File-level implementation details
✗ Test output logs
✗ Subagent intermediate results
```

### Session Agent Context Boundaries

**What Session Agent Receives:**
```json
{
  "scope": {
    "type": "subtree",
    "rootId": "T998.1",
    "taskIds": ["T998.1", "T998.1.1", "T998.1.2"]
  },
  "tasks": [
    {"id": "T998.1", "title": "Setup auth middleware", "description": "...", "status": "pending"}
  ],
  "epicContext": {
    "title": "Implement Authentication System",
    "phase": "core"
  },
  "instructions": "Complete all tasks in scope. Use JWT library. Coordinate with T998.2 for user model interface."
}
```

**What Session Agent Retains:**
```
✓ Scope task tree structure
✓ Task dependencies within scope
✓ Code relevant to scope (auth middleware)
✓ Test results for scope tasks
✓ Subagent results within scope
```

**What Session Agent Discards:**
```
✗ Tasks outside scope (T998.2, T998.3)
✗ Epic-level orchestration state
✗ Other Session Agent progress
✗ User conversation history
```

### Subagent Context Boundaries

**What Subagent Receives:**
```json
{
  "taskId": "T998.1.2",
  "title": "Add JWT token validation",
  "description": "Implement token validation middleware in auth.js",
  "files": ["src/auth/middleware.js"],
  "context": "Use jsonwebtoken library. Validate signature, expiration, issuer.",
  "acceptanceCriteria": ["Tests pass", "Invalid tokens rejected"],
  "testCommand": "npm test -- auth.test.js"
}
```

**What Subagent Retains:**
```
✓ Single task definition
✓ Files to modify
✓ Immediate dependencies (JWT library)
✓ Test validation
```

**What Subagent Does NOT Receive:**
```
✗ Session Agent scope
✗ Epic context
✗ Other tasks (even siblings)
✗ Orchestration state
✗ User conversation
```

---

## 6. Error Escalation

### Escalation Hierarchy

```
Subagent Error
    │
    ├─ Retry (3 attempts)
    │   └─ Success → Complete
    │   └─ Failure → Escalate to Session Agent
    │
Session Agent Error
    │
    ├─ Workaround (local fixes, retries)
    │   └─ Success → Continue
    │   └─ Failure → Escalate to PRIME
    │
PRIME Error
    │
    ├─ Replanning (reassign tasks, respawn agents)
    │   └─ Success → Continue
    │   └─ Failure → Escalate to Human
    │
Human Intervention
    └─ Manual decision
```

### Subagent Escalation to Session Agent

**Escalation Triggers:**
- Subagent fails 3+ times
- Task requires architecture decision
- Missing external dependency
- Ambiguous requirements

**Escalation Mechanism:**
```bash
# Subagent Stop hook on repeated failure
if [ "$RETRY_COUNT" -ge 3 ]; then
    cleo update "$CLEO_TASK_ID" \
        --status blocked \
        --blocked-by "Subagent failed: Missing JWT_SECRET env var" \
        --notes "Escalated to Session Agent: Need environment configuration guidance"
fi
```

**Session Agent Response:**
```bash
# Session Agent detects blocked task
blocked_tasks=$(cleo list --status blocked --format json)

if [ -n "$blocked_tasks" ]; then
    # Session Agent decides:
    # 1. Fix locally (add env var, retry Subagent)
    # 2. Escalate to PRIME (needs global config)
fi
```

### Session Agent Escalation to PRIME

**Escalation Triggers:**
- Blocked on task outside scope
- Scope conflict detected
- Critical failure (data corruption, security issue)
- External dependency unavailable
- User decision required

**Escalation Mechanism:**
```bash
# Session Agent suspends with escalation note
cleo session suspend --note "ESCALATION: Task T998.1.3 requires OAuth credentials. External dependency not in scope. User decision needed."
```

**PRIME Response:**
```bash
# PRIME polling detects escalation
escalations=$(cleo session list --status suspended --format json | jq '.sessions[] | select(.notes | contains("ESCALATION"))')

# PRIME analyzes:
# 1. Can another Session Agent help? (reassign)
# 2. Is blocker resolvable? (provide guidance)
# 3. Needs human input? (notify user)

# PRIME resolves:
case "$ESCALATION_TYPE" in
    "external_dependency")
        # Notify user, await input
        echo "Agent agent-0 blocked on OAuth credentials. Please provide credentials or defer task."
        ;;
    "scope_conflict")
        # Replanning required
        cleo orchestrate replan T998 --reassign T998.1.3 to agent-1
        ;;
esac
```

### PRIME Escalation to Human

**Escalation Triggers:**
- Multiple Session Agents blocked
- Conflicting task requirements
- Security/safety concerns
- Budget/resource limits exceeded
- Unresolvable technical blocker

**Escalation Mechanism:**
```
PRIME: "I've encountered a blocker in the authentication epic.

**Context:**
- Session Agent agent-0 (T998.1 scope) needs OAuth client credentials
- Session Agent agent-1 (T998.2 scope) needs database schema approval
- Both agents suspended, 60% of epic complete

**Options:**
1. Provide OAuth credentials → Resume agent-0
2. Approve schema → Resume agent-1
3. Defer OAuth tasks → Reassign agent-0 to other work
4. Stop orchestration → Manual intervention

Which approach would you like?"
```

---

## 7. State Consistency Guarantees

### ACID Properties for CLEO State

| Property | Implementation | Guarantee |
|----------|----------------|-----------|
| **Atomicity** | All task updates via `atomic_write()` | Task state never partially updated |
| **Consistency** | JSON Schema validation on every write | State always valid |
| **Isolation** | Session scopes prevent task conflicts | Agents cannot interfere |
| **Durability** | Append-only `todo-log.json` | Audit trail survives failures |

### Concurrency Control

**Scope-Based Locking:**
```
Session Agent 0: scope subtree:T998.1
Session Agent 1: scope subtree:T998.2

✓ ALLOWED: Both agents active (disjoint scopes)
✗ BLOCKED: Agent 2 tries scope subtree:T998.1 (conflict)
```

**Focus Locking:**
```
Session Agent 0: focus T998.1.2
Session Agent 1: focus T998.2.1

✓ ALLOWED: Different tasks (disjoint scopes)
✗ BLOCKED: Agent 1 tries focus T998.1.3 (in Agent 0's scope)
```

**State Synchronization:**
```bash
# PRIME polls sessions.json every 5 seconds
# Session Agents write to sessions.json on focus/status change
# Subagents write to todo.json on completion

# Conflict detection
if scope_overlap_detected; then
    kill_conflicting_agent
    escalate_to_prime "Scope conflict: agent-2 tried to claim T998.1.3"
fi
```

---

## 8. Failure Recovery

### Session Agent Failure

**Detection:**
```bash
# PRIME monitors heartbeat (lastHeartbeat in sessions.json)
current_time=$(date +%s)
last_heartbeat=$(jq -r '.sessions[] | select(.id == "session_abc") | .lastHeartbeat' sessions.json)

if [ $((current_time - last_heartbeat)) -gt 300 ]; then
    # Agent unresponsive for 5+ minutes
    handle_agent_failure "session_abc"
fi
```

**Recovery Strategies:**

| Strategy | When Used | Implementation |
|----------|-----------|----------------|
| **Respawn** | Agent crashed, scope recoverable | Spawn new agent with same scope |
| **Reassign** | Agent timeout, tasks redistributable | Assign scope to existing agent |
| **Suspend** | External blocker, await resolution | Mark session suspended, notify PRIME |
| **Abort** | Critical failure, manual intervention | Stop orchestration, escalate to human |

**Respawn Implementation:**
```bash
handle_agent_failure() {
    local session_id="$1"
    local scope=$(jq -r ".sessions[] | select(.id == \"$session_id\") | .scope.rootId" sessions.json)
    local incomplete_tasks=$(cleo list --parent "$scope" --status pending,active --format json)

    if [ -n "$incomplete_tasks" ]; then
        # Respawn agent with same scope
        spawn_session_agent "$scope" --resume "$session_id"
    else
        # All tasks complete, mark session ended
        cleo session end "$session_id" --note "Agent failed but scope complete"
    fi
}
```

### Subagent Failure

**Detection:**
```bash
# Session Agent polls task status
task_status=$(cleo show T998.1.2 --format json | jq -r '.status')

if [ "$task_status" = "blocked" ]; then
    notes=$(cleo show T998.1.2 --format json | jq -r '.notes[-1].content')
    if [[ "$notes" == *"Subagent failed"* ]]; then
        handle_subagent_failure "T998.1.2"
    fi
fi
```

**Recovery Strategies:**
```bash
handle_subagent_failure() {
    local task_id="$1"

    # Retry with Session Agent (no Subagent)
    cleo focus set "$task_id"
    # Session Agent handles task directly
    # ... implementation ...
    cleo complete "$task_id"
}
```

---

## 9. Performance Characteristics

### Context Efficiency

**PRIME Context Usage:**
```
Without PRIME: 100% context on single epic implementation
With PRIME:
  - PRIME: 30% context (orchestration only)
  - Session Agent 0: 25% context (scope T998.1)
  - Session Agent 1: 25% context (scope T998.2)
  - Session Agent 2: 20% context (scope T998.3)

Total effective context: 100% (PRIME) + 70% (3 agents) = 170% capacity
```

### Parallelization Efficiency

**Serial vs. Parallel:**
```
Serial (Single Agent):
  T998.1 (3 tasks) → T998.2 (4 tasks) → T998.3 (2 tasks)
  Total: 9 tasks sequentially

Parallel (3 Session Agents):
  Agent 0: T998.1 (3 tasks)  ┐
  Agent 1: T998.2 (4 tasks)  ├─ Concurrent
  Agent 2: T998.3 (2 tasks)  ┘

  Total: max(3, 4, 2) = 4 task durations (vs. 9)
  Speedup: 2.25x
```

### Subagent Efficiency

**Session Agent with Subagents:**
```
Without Subagents:
  Session Agent context consumed by simple tasks

With Subagents:
  Session Agent: Handles complex tasks (2/5)
  Subagents: Handle atomic tasks (3/5)

  Session Agent retains 60% context for complex work
```

---

## 10. Security Boundaries

### Scope-Based Access Control

**Session Agent Permissions:**
```json
{
  "agentId": "agent-0",
  "permissions": {
    "readTasks": ["T998.1", "T998.1.1", "T998.1.2"],
    "writeTasks": ["T998.1", "T998.1.1", "T998.1.2"],
    "readFiles": ["src/auth/*"],
    "writeFiles": ["src/auth/*"],
    "spawnSubagents": true,
    "spawnSessionAgents": false
  }
}
```

**Enforcement:**
```bash
# Session Agent tries to access T998.2 (out of scope)
cleo focus set T998.2
# ERROR (E_SCOPE_VIOLATION): Task T998.2 not in session scope subtree:T998.1
```

### Credential Isolation

**Secrets Handling:**
```
PRIME:
  ✗ No direct access to secrets
  ✓ Can request user provide secrets

Session Agent:
  ✓ Reads secrets from environment (if provided)
  ✗ Cannot write secrets to CLEO state
  ✓ Can use secrets in implementation

Subagent:
  ✓ Receives secrets via environment (ephemeral)
  ✗ Cannot persist secrets
  ✗ Cannot share secrets across Subagents
```

---

## 11. Implementation Checklist

### Phase 1: PRIME Foundation
- [ ] PRIME never executes implementation work
- [ ] PRIME delegates all tasks to Session Agents
- [ ] PRIME monitors `sessions.json` for progress
- [ ] PRIME detects escalations in session notes
- [ ] PRIME spawns Session Agents via tmux/zellij

### Phase 2: Session Agent Behavior
- [ ] Session Agent respects scope boundaries
- [ ] Session Agent uses `focus set` for active task
- [ ] Session Agent spawns Subagents for atomic tasks
- [ ] Session Agent reports progress via `focus note`
- [ ] Session Agent suspends on external blockers

### Phase 3: Subagent Integration
- [ ] Subagent receives minimal task context
- [ ] Subagent completes via Stop hook
- [ ] Subagent escalates failures to Session Agent
- [ ] Session Agent polls Subagent completion
- [ ] Subagent context isolated (no epic/session state)

### Phase 4: Communication Protocol
- [ ] PRIME ↔ Session Agent via CLEO state (JSON files)
- [ ] Session Agent ↔ Subagent via Task tool
- [ ] Escalations via `session suspend --note "ESCALATION: ..."`
- [ ] Heartbeat monitoring in `sessions.json`

### Phase 5: Error Handling
- [ ] Subagent retry (3 attempts) before escalation
- [ ] Session Agent local fixes before escalation
- [ ] PRIME replanning on Session Agent failure
- [ ] Human escalation on unresolvable blockers

---

## 12. Decision Tree: Who Does What?

### Task Arrives → Who Handles?

```
New Task T999 arrives
    │
    ├─ Is this orchestration-level? (epic decomposition, spawning)
    │   └─ YES → PRIME handles
    │
    ├─ Is this scope-level? (multi-task coordination, dependencies)
    │   └─ YES → Session Agent handles
    │
    └─ Is this atomic? (single file, <100 LOC, clear spec)
        └─ YES → Subagent handles
```

### Error Occurs → Who Handles?

```
Error occurs
    │
    ├─ Subagent error?
    │   ├─ Retryable? (transient failure)
    │   │   └─ YES → Subagent retries (3x)
    │   └─ Persistent? (missing dependency)
    │       └─ YES → Escalate to Session Agent
    │
    ├─ Session Agent error?
    │   ├─ In scope? (can fix locally)
    │   │   └─ YES → Session Agent handles
    │   └─ Out of scope? (needs other agent/user)
    │       └─ YES → Escalate to PRIME
    │
    └─ PRIME error?
        ├─ Replanning? (reassign tasks)
        │   └─ YES → PRIME replans
        └─ Unresolvable? (ambiguous requirements)
            └─ YES → Escalate to Human
```

---

## 13. Example Workflows

### Workflow 1: PRIME Orchestrates Epic

```bash
# Human: "Complete epic T998 with 3 agents"

# PRIME:
1. Analyzes epic structure:
   - T998.1 (3 tasks) → Agent 0
   - T998.2 (4 tasks) → Agent 1
   - T998.3 (2 tasks) → Agent 2

2. Spawns Session Agents:
   tmux new-session -s cleo-orch-T998
   tmux send-keys "cleo session start --scope subtree:T998.1" Enter
   # ... repeat for agents 1, 2

3. Monitors progress:
   while true; do
       sessions=$(cleo session list --status active --format json)
       render_dashboard "$sessions"
       sleep 5
   done

4. Detects completion:
   all_complete=$(cleo list --parent T998 --status done --format json | jq 'length')
   if [ "$all_complete" -eq 9 ]; then
       cleo orchestrate stop --success
   fi
```

### Workflow 2: Session Agent Uses Subagent

```bash
# Session Agent (scope: T998.1):
1. Lists scope tasks:
   tasks=$(cleo list --parent T998.1 --format json)

2. Identifies atomic task T998.1.2:
   if is_atomic "T998.1.2"; then
       spawn_subagent "T998.1.2" "Add JWT validation"
   fi

3. Handles complex task T998.1.3 directly:
   cleo focus set T998.1.3
   # ... implementation work ...
   cleo complete T998.1.3

4. Monitors Subagent completion:
   while [ "$(cleo show T998.1.2 --format json | jq -r '.status')" != "done" ]; do
       sleep 10
   done

5. Session complete:
   cleo session end --note "All T998.1 tasks complete"
```

### Workflow 3: Escalation Flow

```bash
# Subagent fails:
cleo update T998.1.2 --status blocked --blocked-by "Missing JWT_SECRET"

# Session Agent detects:
blocked=$(cleo list --status blocked --format json)
if [[ "$blocked" == *"JWT_SECRET"* ]]; then
    # Can Session Agent fix?
    if can_fix_locally; then
        export JWT_SECRET="generated_secret"
        retry_subagent "T998.1.2"
    else
        # Escalate to PRIME
        cleo session suspend --note "ESCALATION: Need JWT_SECRET from environment config"
    fi
fi

# PRIME detects:
escalations=$(cleo session list --status suspended --format json | jq '.sessions[] | select(.notes | contains("ESCALATION"))')
# PRIME notifies human:
echo "Session Agent agent-0 needs JWT_SECRET. Please provide or defer task."
```

---

## 14. Monitoring & Observability

### PRIME Dashboard

**Real-Time View:**
```
┌─────────────────────────────────────────────────────────────────┐
│  CLEO PRIME ORCHESTRATOR                                        │
│  Epic T998: "Implement Authentication System" (Phase: core)    │
├─────────────────────────────────────────────────────────────────┤
│  SESSION AGENTS                                                 │
│  ┌────────┬──────────┬─────────────────────┬──────────────────┐│
│  │ Agent  │ Status   │ Current Focus       │ Progress         ││
│  ├────────┼──────────┼─────────────────────┼──────────────────┤│
│  │ agent-0│ ● ACTIVE │ T998.1.2 (JWT)      │ ██████░░ 2/3     ││
│  │ agent-1│ ● ACTIVE │ T998.2.3 (Login)    │ ████████ 3/4     ││
│  │ agent-2│ ○ SUSP.  │ T998.3.1 (OAuth)    │ ████░░░░ 1/2     ││
│  └────────┴──────────┴─────────────────────┴──────────────────┘│
├─────────────────────────────────────────────────────────────────┤
│  SUBAGENTS (Active: 2)                                          │
│  - agent-0-subagent-1: T998.1.1 "Setup middleware"             │
│  - agent-1-subagent-2: T998.2.1 "User model"                   │
├─────────────────────────────────────────────────────────────────┤
│  ESCALATIONS (1)                                                │
│  ⚠ agent-2: Need OAuth credentials (T998.3.1 blocked)          │
└─────────────────────────────────────────────────────────────────┘
```

### Logging Architecture

**Audit Trail:**
```json
{
  "timestamp": "2025-12-30T10:45:23Z",
  "level": "INFO",
  "agent": "PRIME",
  "event": "SESSION_SPAWNED",
  "sessionId": "session_abc123",
  "agentId": "agent-0",
  "scope": "subtree:T998.1"
}

{
  "timestamp": "2025-12-30T10:47:15Z",
  "level": "INFO",
  "agent": "agent-0",
  "event": "SUBAGENT_SPAWNED",
  "taskId": "T998.1.2",
  "subagentId": "agent-0-subagent-1"
}

{
  "timestamp": "2025-12-30T10:50:00Z",
  "level": "WARN",
  "agent": "agent-2",
  "event": "ESCALATION",
  "reason": "External dependency unavailable",
  "taskId": "T998.3.1"
}
```

---

## 15. Constraints & Limitations

### Hard Constraints

| Constraint | Reason | Enforcement |
|------------|--------|-------------|
| PRIME cannot focus tasks | No scope binding | CLI rejects `focus set` from PRIME |
| Session Agent cannot spawn Session Agents | Orchestration authority | Only PRIME can spawn |
| Subagent cannot access epic context | Context isolation | Task tool filters context |
| Overlapping scopes prohibited | State consistency | Session start validates scopes |

### Soft Constraints

| Constraint | Reason | Recommendation |
|------------|--------|----------------|
| Max 5 concurrent Session Agents | Context budget | Configure `maxConcurrentSessions` |
| Subagent tasks <100 LOC | Context efficiency | Use for atomic work only |
| Escalations should be rare | Efficiency | Design scopes to minimize dependencies |
| PRIME retains <30% implementation context | Orchestration focus | Delegate details to Session Agents |

---

## 16. Configuration

### config.json Schema

```json
{
  "prime": {
    "enabled": true,
    "contextAllocation": {
      "epicStructure": 0.30,
      "sessionState": 0.25,
      "userConversation": 0.20,
      "orchestrationLogic": 0.15,
      "errorEscalations": 0.10
    },
    "monitoring": {
      "pollInterval": 5,
      "heartbeatTimeout": 300
    }
  },
  "sessionAgent": {
    "subagentThreshold": {
      "maxLines": 100,
      "maxFiles": 1,
      "requiresAtomicSpec": true
    },
    "escalationRules": {
      "maxRetries": 3,
      "escalateOnScopeConflict": true,
      "escalateOnExternalDependency": true
    }
  },
  "subagent": {
    "contextBudget": {
      "taskDefinition": 0.40,
      "relevantCode": 0.30,
      "dependencies": 0.20,
      "validation": 0.10
    },
    "stopHook": "~/.cleo/hooks/subagent-complete.yaml"
  }
}
```

---

## 17. Success Metrics

### Orchestration Efficiency

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Context Utilization** | >150% vs. single agent | Total effective context used |
| **Parallelization Speedup** | >2x for N=3 agents | Time to epic completion |
| **Escalation Rate** | <10% of tasks | Escalations / total tasks |
| **Subagent Success Rate** | >90% first attempt | Subagent completions / spawns |

### PRIME Behavior Compliance

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Zero Implementation Work** | 100% compliance | PRIME file edits = 0 |
| **Delegation Rate** | 100% tasks delegated | PRIME task claims = 0 |
| **Monitoring Accuracy** | <5% state staleness | Poll interval vs. state change latency |

---

## 18. Future Enhancements

### Phase N+1: Advanced Features

- **Dynamic Rebalancing**: Reassign tasks from slow agents to fast agents
- **Predictive Spawning**: Spawn Session Agents based on dependency readiness
- **Cross-Agent Collaboration**: Shared context for dependent tasks
- **Human-in-the-Loop**: Interactive approvals for high-risk tasks
- **Multi-Machine Orchestration**: Distribute Session Agents across compute nodes
- **Cost Optimization**: Model selection per task complexity
- **Session Replay**: Reproduce orchestration runs for debugging

---

## Appendix A: Terminology

| Term | Definition |
|------|------------|
| **PRIME** | Primary agent, orchestrates Session Agents, no implementation work |
| **Session Agent** | Scoped agent working on epic subtree, spawns Subagents |
| **Subagent** | Atomic task executor via Task tool, ephemeral |
| **Scope** | Set of tasks a Session Agent can access (subtree, epic, etc.) |
| **Escalation** | Error/blocker reported up hierarchy (Subagent→Session→PRIME→Human) |
| **Context Boundary** | Information isolation between agent tiers |
| **Atomic Task** | Single-file, <100 LOC, clear spec, suitable for Subagent |

---

## Appendix B: Related Specifications

- [ORCHESTRATOR-SPEC.md](ORCHESTRATOR-SPEC.md) - Orchestration command design
- [MULTI-SESSION-SPEC.md](MULTI-SESSION-SPEC.md) - Multi-session architecture
- [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) - CLI design principles
- [TODO_Task_Management.md](../TODO_Task_Management.md) - CLEO CLI reference

---

**END OF SPECIFICATION**
