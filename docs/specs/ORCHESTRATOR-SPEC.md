# CLEO Native Orchestration System Specification

**Version**: 2.0.0
**Status**: Specification
**Created**: 2025-12-30
**Updated**: 2025-12-31
**Author**: Architecture Team
**Target**: CLEO v0.42.0+

---

## Part 1: Preamble

### 1.1 Purpose

This specification defines CLEO's native tmux-based multi-agent orchestration system. The system enables parallel execution of tasks across multiple Claude Code agents while maintaining state consistency, scope isolation, and deterministic coordination.

### 1.2 Authority

This specification is **AUTHORITATIVE** for:
- tmux session lifecycle management
- Agent spawning and environment injection
- Wave-based dependency execution
- Completion detection via Stop hooks
- Heartbeat monitoring and stale agent detection

This specification **DEFERS TO**:
- [PRIME-ARCHITECTURE-SPEC.md](PRIME-ARCHITECTURE-SPEC.md) for PRIME/Session Agent/Subagent hierarchy
- [SOLID-PROMPTING-SYSTEM-SPEC.md](SOLID-PROMPTING-SYSTEM-SPEC.md) for agent prompt templates
- [MULTI-SESSION-SPEC.md](MULTI-SESSION-SPEC.md) for session scope binding
- [IMPLEMENTATION-ORCHESTRATION-SPEC.md](IMPLEMENTATION-ORCHESTRATION-SPEC.md) for 7-agent pipeline

### 1.3 RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" are interpreted as described in RFC 2119.

---

## Part 2: Design Philosophy

### 2.1 Core Principles

Build CLEO-native tmux orchestration optimized for CLEO's existing architecture and LLM-agent-first principles:

| Principle | Implementation |
|-----------|---------------|
| **Automation-First** | CLI/scriptable by design, not TUI with automation bolted on |
| **Event-Driven** | Stop hooks for completion vs polling (reduces latency) |
| **Scope Pre-Assignment** | No runtime lock contention (disjoint scopes assigned before spawn) |
| **Wave-Based Spawning** | Dependency-aware vs spawn-all-immediately |
| **Single State File** | Use existing `sessions.json` vs multiple coordination files |
| **Context Minimization** | Scope-filtered injection reduces token usage |

### 2.2 Patterns Adopted from Agent Farm

Inspired by [claude_code_agent_farm](https://github.com/Dicklesworthstone/claude_code_agent_farm) (MIT License):

1. **tmux pane-based agent isolation** - Each agent runs in isolated tmux pane
2. **JSON state file for monitoring** - External tools can observe orchestration state
3. **Heartbeat-based health detection** - Detect stalled agents via timestamp comparison
4. **Prompt-based agent coordination** - Agents self-coordinate via injected instructions

### 2.3 CLEO Modernizations

Where CLEO improves on existing patterns:

| Aspect | Agent Farm Approach | CLEO Modernization |
|--------|--------------------|--------------------|
| **Completion Detection** | Polling-based file checks | Event-driven Stop hooks |
| **Task Claiming** | Runtime lock file creation | Pre-assigned disjoint scopes |
| **Agent Spawning** | All agents immediately + stagger | Dependency-aware wave spawning |
| **State Management** | 4 coordination files | Single `sessions.json` |
| **Context Injection** | Full task list per agent | Scope-filtered task subset |

---

## Part 3: Architecture

### 3.1 System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           PRIME AGENT                                │
│  • Analyzes epic structure                                           │
│  • Computes disjoint scopes                                          │
│  • Spawns Session Agents in tmux panes                               │
│  • Monitors completion via sessions.json                             │
│  • NO implementation work                                            │
└────────────────────────┬────────────────────────────────────────────┘
                         │ cleo orchestrate start T998
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     lib/orchestrator.sh                              │
│  • compute_dependency_waves() → Wave assignment                      │
│  • spawn_wave() → Create tmux panes with agents                      │
│  • handle_agent_completion() → Process Stop hook events              │
│  • orchestrate_status() → JSON state output                          │
└────────────────────────┬────────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  TMUX PANE 0    │ │  TMUX PANE 1    │ │  TMUX PANE N    │
│                 │ │                 │ │                 │
│ CLEO_SESSION=   │ │ CLEO_SESSION=   │ │ CLEO_SESSION=   │
│   sess_001      │ │   sess_002      │ │   sess_00N      │
│                 │ │                 │ │                 │
│ Scope: T998.1   │ │ Scope: T998.2   │ │ Scope: T998.N   │
│                 │ │                 │ │                 │
│ claude -p "..." │ │ claude -p "..." │ │ claude -p "..." │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         ▼                   ▼                   ▼
    Stop Hook            Stop Hook           Stop Hook
    → Completion         → Completion        → Completion
    Event                Event               Event
```

### 3.2 Layer Placement

```
Layer 3 (Application): lib/orchestrator.sh
                       ├── Depends on: sessions.sh, file-ops.sh, config.sh
                       └── Provides: orchestration functions

Layer 2 (Data):        lib/sessions.sh (existing, extended)
                       └── Add: heartbeat functions

Script Layer:          scripts/orchestrate.sh
                       └── User-facing CLI entry point
```

### 3.3 File Locations

| File | Purpose |
|------|---------|
| `lib/orchestrator.sh` | Core orchestration functions (Layer 3) |
| `scripts/orchestrate.sh` | CLI entry point |
| `.claude/hooks/orchestrator-stop.yaml` | Stop hook for completion notification |
| `templates/session-agent-prompt.md` | Base session agent prompt |
| `templates/agents/*.md` | 7 pipeline agent prompts |
| `.cleo/orchestration/events/` | Completion event files |

---

## Part 4: Core Functions

### 4.1 lib/orchestrator.sh

```bash
#!/usr/bin/env bash
# orchestrator.sh - CLEO multi-agent orchestration
#
# LAYER: 3 (Application Layer)
# DEPENDENCIES: sessions.sh, file-ops.sh, config.sh, paths.sh
# PROVIDES: orchestrate_start, orchestrate_stop, orchestrate_status,
#           compute_dependency_waves, spawn_wave, handle_agent_completion

# ============================================================================
# CORE ORCHESTRATION
# ============================================================================

orchestrate_start()
# Start orchestration for an epic
# Arguments: $1 = epic_id, $2 = num_agents (optional)
# Returns: EXIT_SUCCESS or EXIT_ORCHESTRATION_FAILED

orchestrate_stop()
# Stop all agents and cleanup
# Arguments: $1 = epic_id
# Returns: EXIT_SUCCESS

orchestrate_status()
# Get orchestration status as JSON
# Arguments: $1 = epic_id
# Outputs: JSON to stdout

# ============================================================================
# WAVE MANAGEMENT
# ============================================================================

compute_dependency_waves()
# Compute wave assignment from task dependencies
# Arguments: $1 = epic_id
# Outputs: JSON array of waves with task assignments

spawn_wave()
# Spawn agents for a specific wave
# Arguments: $1 = epic_id, $2 = wave_number
# Returns: EXIT_SUCCESS or EXIT_SPAWN_FAILED

get_next_wave()
# Determine next wave to spawn after completions
# Arguments: $1 = epic_id
# Outputs: wave_number or "COMPLETE"

# ============================================================================
# TMUX LIFECYCLE
# ============================================================================

tmux_create_session()
# Create orchestration tmux session
# Arguments: $1 = session_name
# Returns: EXIT_SUCCESS or EXIT_TMUX_FAILED

tmux_spawn_agent_pane()
# Add pane for agent
# Arguments: $1 = session_name, $2 = agent_id, $3 = scope, $4 = prompt_file
# Returns: EXIT_SUCCESS

tmux_send_prompt()
# Inject prompt to pane via buffer
# Arguments: $1 = pane_target, $2 = prompt_content

tmux_kill_session()
# Terminate orchestration session
# Arguments: $1 = session_name

# ============================================================================
# COMPLETION HANDLING
# ============================================================================

handle_agent_completion()
# Process Stop hook notification
# Arguments: $1 = session_id, $2 = exit_status
# Side effects: Updates sessions.json, may spawn next wave

detect_stale_agents()
# Find agents past heartbeat timeout
# Arguments: $1 = timeout_seconds (default: 120)
# Outputs: JSON array of stale session IDs

update_heartbeat()
# Update agent heartbeat timestamp
# Arguments: $1 = session_id
# Side effects: Updates lastActivity in sessions.json
```

### 4.2 scripts/orchestrate.sh

```bash
#!/usr/bin/env bash
# orchestrate.sh - User-facing orchestration CLI

# Usage:
#   cleo orchestrate start <epic-id> [OPTIONS]
#   cleo orchestrate status <epic-id>
#   cleo orchestrate stop <epic-id>
#   cleo orchestrate wave <epic-id> <wave-number>

# Options for 'start':
#   --agents N       Number of agents (default: auto-compute from task count)
#   --dry-run        Preview wave assignments without spawning
#   --timeout MINS   Per-agent timeout (default: 30)

# Exit codes:
#   0   Success
#   50  Orchestration failed to start
#   51  Epic not found
#   52  Scope conflict detected
#   53  Tmux session failed
#   54  Agent spawn failed
#   55  Wave progression failed
#   56  Timeout exceeded
#   57  Stop hook failed
```

---

## Part 5: Wave-Based Execution

### 5.1 Dependency Analysis

Tasks are grouped into waves based on their dependencies:

```
FUNCTION compute_dependency_waves(epic_id):
    tasks = cleo list --parent epic_id --format json

    # Wave 0: Tasks with no dependencies
    wave_0 = [t for t in tasks if len(t.depends) == 0]

    # Wave N: Tasks whose ALL dependencies are in waves < N
    for wave_n in range(1, MAX_WAVES):
        completed_tasks = union(wave_0, ..., wave_{n-1})
        wave_n = [t for t in tasks
                  if all(d in completed_tasks for d in t.depends)]

    return waves
```

### 5.2 Example Wave Assignment

Given T1114 with dependencies:

```
T1114 (epic)
├── T1123 (no deps)           → Wave 0
├── T1116 (deps: T1123)       → Wave 1
├── T1118 (deps: T1123)       → Wave 1
├── T1119 (deps: T1123)       → Wave 1
├── T1120 (deps: T1123)       → Wave 1
├── T1117 (deps: T1116)       → Wave 2
├── T1122 (deps: T1116,...)   → Wave 2
├── T1124-T1130 (deps: T1119) → Wave 2
└── T1121 (deps: T1116,...)   → Wave 3
```

### 5.3 Wave Progression

```
Wave 0 spawns → T1123 completes → Wave 1 spawns
Wave 1 spawns → All Wave 1 complete → Wave 2 spawns
Wave 2 spawns → All Wave 2 complete → Wave 3 spawns
Wave 3 spawns → All complete → Orchestration DONE
```

---

## Part 6: Environment Injection

### 6.1 CLEO_SESSION Binding

Each spawned agent receives environment variables:

```bash
export CLEO_SESSION="session_20251231_abc123"
export CLEO_SCOPE="subtree:T998.1"
export CLEO_AGENT_ID="agent-0"
export CLEO_ORCHESTRATION_ID="orch_xyz"
export CLEO_WAVE="1"
```

### 6.2 Session Resolution Priority

From `lib/session.sh`:

```bash
resolve_current_session_id() {
    # 1. Environment variable takes priority (set by orchestrator)
    if [[ -n "${CLEO_SESSION:-}" ]]; then
        echo "$CLEO_SESSION"
        return 0
    fi

    # 2. Fall back to file-based binding
    local current_session_file
    current_session_file="$(get_cleo_dir)/.current-session"
    if [[ -f "$current_session_file" ]]; then
        cat "$current_session_file"
        return 0
    fi

    return 1
}
```

---

## Part 7: Completion Detection

### 7.1 Stop Hook

```yaml
# .claude/hooks/orchestrator-stop.yaml
name: Orchestrator Completion Notifier
trigger: Stop
when: $CLEO_ORCHESTRATION_ID != ""

actions:
  - bash: |
      # Write completion event
      event_dir="${CLEO_PROJECT_ROOT}/.cleo/orchestration/events"
      mkdir -p "$event_dir"

      event_file="${event_dir}/${CLEO_SESSION}_complete.json"

      jq -nc \
        --arg session "$CLEO_SESSION" \
        --arg agent "$CLEO_AGENT_ID" \
        --arg status "$EXIT_STATUS" \
        --arg wave "$CLEO_WAVE" \
        --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
          session: $session,
          agent: $agent,
          exitStatus: ($status | tonumber),
          wave: ($wave | tonumber),
          completedAt: $timestamp
        }' > "$event_file"
```

### 7.2 Event Processing

The orchestrator monitors `.cleo/orchestration/events/` for completion files:

```bash
handle_agent_completion() {
    local session_id="$1"
    local exit_status="$2"

    # Update session status
    update_session_status "$session_id" "ended"

    # Check if wave complete
    local wave=$(get_agent_wave "$session_id")
    if wave_complete "$wave"; then
        local next_wave=$(get_next_wave)
        if [[ "$next_wave" == "COMPLETE" ]]; then
            orchestration_complete
        else
            spawn_wave "$next_wave"
        fi
    fi
}
```

---

## Part 8: Heartbeat Monitoring

### 8.1 Heartbeat Updates

Agents update their heartbeat via `sessions.json`:

```bash
update_heartbeat() {
    local session_id="$1"
    local sessions_file=$(get_sessions_file)

    local updated=$(jq \
        --arg id "$session_id" \
        --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '.sessions = [.sessions[] |
            if .id == $id then . + {lastActivity: $now} else . end]' \
        "$sessions_file")

    aw_atomic_write "$sessions_file" "$updated"
}
```

### 8.2 Stale Detection

```bash
detect_stale_agents() {
    local timeout_seconds="${1:-120}"
    local now=$(date +%s)

    jq -r \
        --argjson now "$now" \
        --argjson timeout "$timeout_seconds" \
        '.sessions[] |
         select(.status == "active") |
         select(($now - (.lastActivity | fromdateiso8601)) > $timeout) |
         .id' \
        "$(get_sessions_file)"
}
```

---

## Part 9: API Optimization

### 9.1 Context Minimization Strategies

| Strategy | Savings | Implementation |
|----------|---------|----------------|
| **Scope-filtered task list** | 50-80% | Only inject tasks in agent's scope |
| **Task-level injection** | 30-50% | Pass `task.description`, not full todo.json |
| **Shared CLAUDE.md** | 40-60% | Project context same for all, don't repeat |
| **Lazy file loading** | 20-30% | Agent reads files on-demand, not upfront |

### 9.2 Subagent vs Session Decision

```
IF task is atomic (size=small, single file) AND no architectural decisions:
    → Use Task tool (subagent) - shared context, faster

ELSE IF task has file-level scope AND is independent:
    → Use tmux session - isolated context, parallel

ELSE:
    → Keep in current session - context preservation
```

---

## Part 10: Configuration

### 10.1 config.json Schema Extension

```json
{
  "orchestration": {
    "terminal": "tmux",
    "maxConcurrentAgents": 5,
    "sessionEnvVar": "CLEO_SESSION",
    "heartbeatTimeout": 120,
    "eventPollingMs": 5000,
    "waveSpawnDelay": 2000,
    "agentProgram": "claude --model claude-sonnet-4"
  }
}
```

### 10.2 Exit Codes (50-59)

| Code | Constant | Meaning |
|------|----------|---------|
| 50 | `EXIT_ORCH_FAILED` | Orchestration failed to start |
| 51 | `EXIT_EPIC_NOT_FOUND` | Epic task not found |
| 52 | `EXIT_SCOPE_CONFLICT` | Scope overlap detected |
| 53 | `EXIT_TMUX_FAILED` | Tmux session creation failed |
| 54 | `EXIT_SPAWN_FAILED` | Agent spawn failed |
| 55 | `EXIT_WAVE_FAILED` | Wave progression failed |
| 56 | `EXIT_TIMEOUT` | Agent timeout exceeded |
| 57 | `EXIT_HOOK_FAILED` | Stop hook notification failed |

---

## Part 11: Implementation Checklist

### Phase 1: Foundation (T1116)
- [ ] Create `lib/orchestrator.sh` skeleton with source guards
- [ ] Implement `orchestrate_start()` (single wave, no deps)
- [ ] Implement `orchestrate_status()` for JSON output
- [ ] Implement `orchestrate_stop()` for cleanup
- [ ] Add tmux lifecycle functions
- [ ] Write BATS unit tests

### Phase 2: CLI and Integration (T1117, T1118)
- [ ] Create `scripts/orchestrate.sh` CLI entry point
- [ ] Update `lib/session.sh` for CLEO_SESSION priority
- [ ] Wire environment variable injection
- [ ] Add integration tests

### Phase 3: Event System (T1119, T1120)
- [ ] Create base session agent prompt template
- [ ] Implement Stop hook for completion notification
- [ ] Wire `handle_agent_completion()` to hook output
- [ ] Test event-driven completion flow

### Phase 4: Wave Dependencies
- [ ] Implement `compute_dependency_waves()`
- [ ] Implement `spawn_wave()` for specific wave
- [ ] Implement `get_next_wave()` for progression
- [ ] Add wave-based spawning tests

### Phase 5: Pipeline Agents (T1124-T1130)
- [ ] Create 7 specialized agent prompt templates
- [ ] Validate templates against SOLID Prompting spec
- [ ] Test each template with mock task execution

### Phase 6: Monitoring and Docs (T1121)
- [ ] Implement heartbeat monitoring
- [ ] Implement stale agent detection
- [ ] Write comprehensive documentation
- [ ] Update related specs

---

## Part 12: Success Criteria

| Criterion | Validation |
|-----------|------------|
| 3+ agents spawn on disjoint scopes | `orchestrate start T998` works |
| Wave progression | Wave N+1 spawns after Wave N completes |
| Stop hook triggers | Completion notification < 5s |
| No scope conflicts | Agents cannot focus same task |
| Heartbeat detection | Stale agents detected within 2 * timeout |
| All prompts SOLID-compliant | Template validation passes |
| Exit codes documented | All 50-59 codes in exit-codes.sh |

---

## Appendix A: Related Specifications

- [PRIME-ARCHITECTURE-SPEC.md](PRIME-ARCHITECTURE-SPEC.md) - Three-tier agent hierarchy
- [SOLID-PROMPTING-SYSTEM-SPEC.md](SOLID-PROMPTING-SYSTEM-SPEC.md) - Prompt template design
- [MULTI-SESSION-SPEC.md](MULTI-SESSION-SPEC.md) - Session scope binding
- [IMPLEMENTATION-ORCHESTRATION-SPEC.md](IMPLEMENTATION-ORCHESTRATION-SPEC.md) - 7-agent pipeline

---

## Appendix B: Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-12-30 | Initial Claude Squad analysis |
| 2.0.0 | 2025-12-31 | Complete rewrite: CLEO Native with Agent Farm patterns |

---

*Specification v2.0.0 - CLEO Native Orchestration System*
*Applicable to: CLEO v0.42.0+*
*Last updated: 2025-12-31*
