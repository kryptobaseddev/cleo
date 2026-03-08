# CLEO Multi-Tier Agent Orchestration Specification

**Version**: 2026.3.8
**Status**: REVIEW
**Date**: 2026-03-08
**Task**: T5671
**Authors**: CLEO Development Team

---

## 1. Overview

Multi-tier agent orchestration addresses three fundamental constraints of LLM-agent-based software engineering:

1. **Context protection**: Each agent operates within a ~185,000 token context window. A single agent attempting to coordinate, implement, test, and synthesize results for a large task will exhaust its context before completion.

2. **Parallel execution**: Independent workstreams (e.g., testing 10 domains simultaneously) can be executed by separate agents in parallel, reducing wall-clock time proportional to the number of concurrent agents.

3. **Specialization**: An orchestrator that coordinates but never touches code preserves its context for decision-making. Team leads that own implementation domains maintain deep context within their scope. Subagents that execute atomic tasks operate with minimal, focused context.

This specification defines the three-tier architecture (Orchestrator, Team Lead, Subagent), wave-based execution patterns, context protection rules, task decomposition standards, and communication protocols that enable reliable multi-agent coordination within CLEO.

---

## 2. Terminology

| Term | Definition |
|------|------------|
| **Orchestrator** | A Tier 0 agent responsible exclusively for coordination: task decomposition, agent spawning, dependency tracking, and wave management. MUST NOT read source code or run tests. |
| **Team Lead** | A Tier 1 agent that owns a domain, workstream, or fix batch. Reads and writes code, runs tests, makes commits, and reports results to the Orchestrator. |
| **Subagent** | A Tier 2 agent spawned by a Team Lead for an atomic, single-purpose task. Reports only to its spawning Team Lead. |
| **Wave** | A group of tasks that MAY execute in parallel because they share no mutual dependencies. Waves execute serially; tasks within a wave execute concurrently. |
| **Task Decomposition** | The process of breaking a high-level objective into discrete, agent-sized units of work with explicit dependencies and acceptance criteria. |
| **Context Budget** | The maximum token consumption an agent SHOULD operate within before handing off or shutting down. Hard cap: 185,000 tokens per agent. |
| **Handoff** | The transfer of responsibility from one agent to another, mediated by file-based artifacts (`.cleo/agent-outputs/`) and summary messages (SendMessage). |
| **Idle State** | A normal operational state where an agent has completed its current work and awaits new instructions. Idle notifications are informational, not error conditions. |

---

## 3. Three-Tier Architecture

```
Tier 0: Orchestrator
  |
  +-- Tier 1: Team Lead A (domain/workstream owner)
  |     |
  |     +-- Tier 2: Subagent A1 (atomic task)
  |     +-- Tier 2: Subagent A2 (atomic task)
  |
  +-- Tier 1: Team Lead B (domain/workstream owner)
  |     |
  |     +-- Tier 2: Subagent B1 (atomic task)
  |
  +-- Tier 1: Team Lead C (independent specialist)
```

### 3.1 Tier 0: Orchestrator

The Orchestrator is the single coordination point for the entire operation.

**Responsibilities:**
- Create task decomposition with dependency chains (TaskCreate + addBlockedBy)
- Spawn and shut down Team Lead agents via Agent tool + SendMessage
- Track completion status via TaskList and TaskGet
- Unblock next waves when dependencies clear
- Protect its own context by delegating ALL implementation work

**Constraints:**
- MUST NOT read source code, test files, or implementation artifacts
- MUST NOT run tests, builds, or any code execution
- MUST NOT make commits or modify files
- MUST delegate all research to Explore agents or Team Leads
- SHOULD use file-based communication for large result sets
- SHOULD shut down completed agents to free resources

### 3.2 Tier 1: Team Lead

Team Leads own a domain, workstream, or batch of related fixes.

**Responsibilities:**
- Read and write code within their assigned scope
- Run tests and validate changes
- Make commits with proper task references
- MAY spawn Tier 2 subagents for parallel subtasks within their scope
- Report result summaries to Orchestrator via SendMessage
- Write detailed results to `.cleo/agent-outputs/` files

**Constraints:**
- MUST operate within their assigned scope
- MUST NOT communicate directly with other Team Leads (coordinate through Orchestrator)
- MUST report completion or blockers to the Orchestrator
- SHOULD shut down after completing assigned work

### 3.3 Tier 2: Subagent

Subagents execute atomic, focused tasks with the shortest possible context.

**Responsibilities:**
- Execute a single, well-defined task (test one domain, research one topic, fix one file)
- Report results to the spawning Team Lead only

**Constraints:**
- MUST NOT communicate with other subagents or with the Orchestrator directly
- MUST NOT exceed the scope of their assigned task
- SHOULD complete and terminate promptly

---

## 4. Wave-Based Execution Pattern

Waves organize tasks into dependency-ordered groups. Tasks within a wave have no mutual dependencies and MAY execute in parallel. Waves themselves execute serially.

### 4.1 Wave Types

| Pattern | Use Case | Example |
|---------|----------|---------|
| **Serial waves** | Dependent work that must proceed in order | Fix -> Validate -> Commit -> Release |
| **Parallel waves** | Independent work with no cross-dependencies | 10 agents testing 10 domains simultaneously |
| **Mixed waves** | Some agents run parallel to serial chains | Spec-writer runs alongside bug-fix waves (no code dependency) |

### 4.2 Dependency Chains

Dependencies between tasks are expressed via TaskUpdate with `addBlockedBy`:

- **Sequential dependency**: Task B lists Task A in `addBlockedBy`. B cannot start until A completes.
- **Parallel independence**: Tasks with no `addBlockedBy` references to each other MAY execute concurrently.
- **Cross-wave dependency**: A task in Wave N+1 is blocked by one or more tasks in Wave N.

### 4.3 Wave Transitions

The Orchestrator manages wave transitions:

1. Orchestrator checks TaskList/TaskGet for completion status of current wave tasks
2. When all tasks in the current wave are completed (or deleted), the Orchestrator spawns agents for the next wave
3. Tasks in the next wave whose blockers have not all cleared MUST NOT be started
4. The Orchestrator MAY spawn agents for a partial next wave if some blockers have cleared while others have not

### 4.4 Existing Implementation

Wave computation is implemented in `src/core/orchestration/waves.ts`:

- `computeWaves(tasks)` performs topological sort to group tasks into dependency-ordered waves
- `getEnrichedWaves(epicId)` returns wave data enriched with task titles and statuses
- Maximum wave depth: 50 (safety limit against circular dependencies)

---

## 5. Context Protection Rules

Context protection is the primary motivation for multi-tier orchestration. These rules are normative.

### 5.1 Hard Limits

- **185,000 token HARD CAP** per agent. An agent MUST hand off or shut down before reaching this limit.
- The Orchestrator MUST NOT read source code. Reading implementation files consumes context that the Orchestrator needs for coordination decisions.

### 5.2 File-Based Communication

Large results MUST be communicated via files, not messages:

| Channel | Use Case | Token Cost |
|---------|----------|------------|
| SendMessage | Short summaries, status updates, instructions | Low (~100-500 tokens) |
| `.cleo/agent-outputs/` files | Detailed findings, test results, bug catalogs | Zero in Orchestrator context (cost borne by reading agent) |

Team Leads MUST write detailed results to `.cleo/agent-outputs/` and send only summaries via SendMessage. The naming convention is `{taskId}-{agent-role}-report.md`.

### 5.3 Agent Lifecycle

- Agents SHOULD be shut down after completing their assigned work to free system resources.
- The Orchestrator SHOULD spawn fresh agents for new waves rather than reusing agents from completed waves. Saturated agents carry accumulated context that reduces their effective working capacity.
- Re-spawning is preferred over context-clearing because fresh agents start with maximum available context.

### 5.4 Research Delegation

When the Orchestrator needs information about the codebase:

- MUST delegate to an Explore agent or a Team Lead
- MUST NOT use Read, Grep, or Glob tools directly
- SHOULD request specific answers rather than raw file contents

---

## 6. Task Decomposition Standards

### 6.1 Task Creation

Tasks created for multi-tier orchestration MUST follow these standards:

| Field | Requirement | Example |
|-------|-------------|---------|
| `subject` | Imperative form, scoped to a single deliverable | "Fix session validation for status enum" |
| `description` | Acceptance criteria: what "done" looks like | "session list --status ended accepts valid session statuses (active, ended, suspended)" |
| `activeForm` | Present continuous, shown in progress indicators | "Fixing session validation" |

### 6.2 Dependency Setup

- Use `addBlockedBy` to express sequential dependencies between tasks
- Tasks with no blockers are implicitly parallel-eligible
- The Orchestrator MUST set up all dependencies before spawning the first agent

### 6.3 Owner Assignment

- Owner is assigned when a Team Lead claims the task via TaskUpdate with `owner` param
- Owner names SHOULD be descriptive of the agent's role (e.g., "fix-research", "gauntlet-tasks", "synthesis")

### 6.4 Status Progression

```
pending --> in_progress --> completed
                       \-> deleted (if no longer needed)
```

- `pending`: Created but not yet claimed
- `in_progress`: Claimed by an agent, work underway
- `completed`: All acceptance criteria met
- `deleted`: Task removed (superseded, duplicate, or no longer relevant)

### 6.5 Naming Conventions

- **Task subjects**: Action-oriented, scoped to a single deliverable. "Fix X", "Test Y", "Write Z".
- **Agent names**: Descriptive of role within the operation. Examples: `fix-research`, `gauntlet-tasks`, `gauntlet-memory`, `synthesis`, `spec-writer`.

---

## 7. Communication Protocol

### 7.1 Direct Messages

SendMessage with `type: "message"` is the primary communication channel between tiers.

- **Orchestrator -> Team Lead**: Task assignments, wave instructions, dependency updates
- **Team Lead -> Orchestrator**: Completion summaries, blocker reports, result locations
- **Team Lead -> Subagent**: Task instructions (via spawn)
- **Subagent -> Team Lead**: Results (via SendMessage or file output)

### 7.2 Shutdown Protocol

SendMessage with `type: "shutdown_request"` is used after an agent's tasks are complete:

1. Orchestrator sends shutdown request to the Team Lead
2. Team Lead acknowledges and terminates
3. If the Team Lead has unfinished work, it MAY reject the shutdown with an explanation

### 7.3 Idle Notifications

Idle notifications indicate that an agent has completed its current work and is waiting for input. They are a **normal operational state**.

- The Orchestrator MUST NOT react to idle notifications unless it has new work to assign.
- Idle notifications are NOT error conditions and SHOULD NOT trigger debugging or investigation.
- The system generates idle notifications automatically; agents SHOULD NOT send structured JSON status messages manually.

### 7.4 Broadcast Messages

SendMessage with `type: "broadcast"` sends to all teammates simultaneously.

- MUST be used sparingly -- each broadcast delivers N separate messages (one per teammate)
- Valid use cases: critical blocking issues requiring immediate team-wide attention
- MUST NOT be used for routine status updates or completion notifications

### 7.5 Status Tracking

Task status updates MUST use TaskUpdate, not message-based status reporting:

- Team Leads update their task status via TaskUpdate when starting (`in_progress`) and finishing (`completed`)
- The Orchestrator reads task status via TaskGet/TaskList to determine wave completion
- This ensures a single source of truth for task state

### 7.6 Provider-Neutral Transport Layer

Inter-agent communication SHOULD be abstracted behind a provider-neutral transport interface. This enables CLEO orchestration to work with any agent framework, not just Claude Code.

#### 7.6.1 AgentTransport Interface

The `AgentTransport` interface (`src/core/signaldock/transport.ts`) defines the canonical abstraction:

| Method | Purpose |
|--------|---------|
| `register(name, class, tier)` | Register an agent with the transport layer |
| `deregister(agentId)` | Remove an agent from the transport layer |
| `send(from, to, content, conversationId?)` | Send a message to another agent |
| `poll(agentId, since?)` | Poll for new messages |
| `heartbeat(agentId)` | Keep the agent connection alive |
| `createConversation(participants, visibility?)` | Create a conversation channel |

#### 7.6.2 Transport Implementations

| Transport | Provider | Status | Use Case |
|-----------|----------|--------|----------|
| `ClaudeCodeTransport` | Claude Code SDK | Phase 0 (current) | Default when SignalDock is not enabled |
| `SignalDockTransport` | SignalDock REST API | Phase 1 | Provider-neutral messaging with delivery guarantees |

The transport is selected by a factory function based on the `signaldock.enabled` configuration flag. When disabled (default), the `ClaudeCodeTransport` preserves backward compatibility with the existing SendMessage-based orchestration model.

#### 7.6.3 Relationship to Conduit

The `AgentTransport` interface is a Phase 1 stepping stone toward the canonical Conduit relay path defined in `CLEO-CONDUIT-PROTOCOL-SPEC.md`. When Conduit is implemented:

- SignalDock's `DeliveryChain` (SSE > Webhook > WS > HTTP/2 > Polling) maps to Conduit's delivery state machine
- Message envelopes SHOULD be shaped to conform to LAFS envelope discipline
- The `AgentTransport` interface MAY be extended or superseded by Conduit's IPC boundary

---

## 8. T5671 Case Study

T5671 Phase 2 validated this orchestration pattern in production. The objective was to fix regressions, release a new version, and comprehensively test all 200 MCP operations across 10 domains.

### 8.1 Operation Structure

- **Orchestrator**: 1 (Tier 0, coordination only)
- **Domain leads**: 10 (Tier 1, one per canonical domain)
- **Specialists**: 1 synthesis agent + 1 spec-writer (parallel)
- **Execution pattern**: 4 sequential waves with internal parallelism

### 8.2 Wave Execution

| Wave | Agents | Tasks | Pattern |
|------|--------|-------|---------|
| **A: Fix** | 1 (test-fixer) | Fix 7 test regressions from Phase 1 | Serial -- must complete before validation |
| **B: Validate & Release** | 1 (build-validator) | Run full test suite, commit fixes, release v2026.3.24 | Serial -- depends on Wave A |
| **C: Gauntlet** | 10 (domain leads) | Test 200 operations across 10 domains | Parallel -- 10 agents running simultaneously |
| **D: Synthesis** | 1 (synthesis) | Aggregate all gauntlet results into unified report | Serial -- depends on Wave C |

Additionally, 1 spec-writer agent ran in parallel with all waves (no code dependency).

### 8.3 Results

| Metric | Value |
|--------|-------|
| Overall pass rate | 93.1% (192/206 test points) |
| Domains at 100% | 6 of 10 (Memory, Orchestrate, Tools, Admin, Nexus, Sticky) |
| Total bugs found | 17 (0 P0, 4 P1, 7 P2, 6 P3/LOW) |
| Version released | v2026.3.24 |
| Average usability score | 7.6/10 |
| Average consistency score | 8.4/10 |

### 8.4 Pattern Validation

The execution confirmed:

- **Context protection worked**: The Orchestrator never read source code and maintained coordination capacity throughout all 4 waves.
- **Parallel execution scaled**: 10 gauntlet agents tested 10 domains simultaneously without interference.
- **Wave dependencies held**: No agent started work before its blockers cleared.
- **File-based communication was sufficient**: All detailed results flowed through `.cleo/agent-outputs/` files; only summaries traversed SendMessage.
- **Fresh spawns outperformed reuse**: Each wave used freshly spawned agents rather than reusing agents from prior waves.

### 8.5 Gauntlet Per-Domain Results

| Agent | Domain | Ops | Pass Rate | Bugs |
|-------|--------|-----|-----------|------|
| tasks-lead | Tasks | 26 | 92.3% | 2 |
| session-lead | Session | 15 | 80.8% | 7 |
| memory-lead | Memory | 18 | 100% | 0 |
| check-lead | Check | 16 | 81.3% | 3 |
| pipeline-lead | Pipeline | 31 | 71.0% | 4 |
| orchestrate-lead | Orchestrate | 16 | 100% | 0 |
| tools-lead | Tools | 22 | 100% | 0 |
| admin-lead | Admin | 30 | 100% | 1 |
| nexus-lead | Nexus | 20 | 100% | 0 |
| sticky-lead | Sticky | 6 | 100% | 0 |

Full results: `.cleo/agent-outputs/T5671-synthesis-report.md`

---

## 9. Integration Points

### 9.1 CLEO Infrastructure

| Component | Role in Multi-Tier Orchestration |
|-----------|----------------------------------|
| `src/core/orchestration/waves.ts` | Wave computation via topological sort of task dependencies |
| `src/dispatch/domains/orchestrate.ts` | MCP domain handler for orchestration operations |
| TaskCreate / TaskUpdate / TaskList | Task management primitives used by the Orchestrator |
| Agent tool | Provider-specific mechanism for spawning Team Leads and Subagents |
| SendMessage tool | Inter-agent communication channel (Phase 0, provider-specific) |
| TeamCreate tool | Team initialization for multi-agent operations |
| `src/core/signaldock/` | Provider-neutral agent transport layer (Phase 1, via SignalDock HTTP API) |

### 9.2 Related Specifications

| Specification | Relationship |
|---------------|-------------|
| `CLEO-CONDUIT-PROTOCOL-SPEC.md` | Canonical A2A relay specification; SignalDock transport implements Phase 1 toward Conduit |

| Specification | Relationship |
|---------------|-------------|
| `CLEO-AUTONOMOUS-RUNTIME-SPEC.md` | Defines the runtime foundation (Agent-Runtime Core, Impulse Engine, Watchers) on which multi-tier orchestration operates |
| `MCP-AGENT-INTERACTION-SPEC.md` | Defines progressive disclosure tiers and MCP-first interaction patterns used by all tiers |
| `ct-orchestrator SKILL.md` | Defines the LOOM pipeline, ORC constraints, and provider-neutral spawning pattern for single-orchestrator workflows |
| `CLEO-OPERATION-CONSTITUTION.md` | Canonical registry of all 200+ MCP operations available to agents |
| `VERB-STANDARDS.md` | Canonical verb standards that all agent-created operations MUST follow |

### 9.3 Relationship to ct-orchestrator

The ct-orchestrator skill defines a **single-orchestrator** pattern with ORC constraints (ORC-001 through ORC-009) and LOOM pipeline management. Multi-tier orchestration extends this pattern:

- ORC-001 (stay high-level) and ORC-009 (never write code) apply to the Tier 0 Orchestrator
- ORC-002 (delegate all work) is expressed through the Team Lead tier
- ORC-003 (no full file reads) applies to the Orchestrator; Team Leads MAY read files
- ORC-005 (context budget) is generalized to the 185K token hard cap per agent
- LOOM pipeline stages remain applicable for epic-level orchestration

---

## 10. Anti-Patterns

The following patterns MUST be avoided in multi-tier orchestration:

| Anti-Pattern | Why It Fails | Correct Pattern |
|-------------|--------------|-----------------|
| **Orchestrator writing code** | Consumes context needed for coordination; violates separation of concerns | Delegate all implementation to Team Leads |
| **Peer-to-peer agent communication** | Creates untracked dependencies; Orchestrator loses visibility into coordination state | All cross-team communication flows through the Orchestrator or shared files |
| **Single monolithic agent** | Context overflow on large tasks; no parallelism; single point of failure | Decompose into tiers with specialized agents |
| **Reusing saturated agents** | Accumulated context reduces effective working capacity; risk of confusion from prior task context | Spawn fresh agents for new waves |
| **Polling for agent completion** | Wastes Orchestrator context on repeated status checks | Use idle notifications and TaskGet to detect completion |
| **Removing functionality without verification** | Agents may delete imports, functions, or code that other components depend on | Verify all removals against usage before deleting |
| **Sending large results via messages** | Consumes Orchestrator context; messages have size limits | Write detailed results to `.cleo/agent-outputs/` files; send summaries via SendMessage |
| **Skipping dependency setup** | Agents start work before prerequisites are met; race conditions on shared resources | Set up all `addBlockedBy` chains before spawning the first agent |
| **Structured JSON status messages** | Duplicates task system; adds parsing overhead; not rendered well in UI | Use TaskUpdate for status; use plain-text SendMessage for communication |
| **Excessive broadcasting** | N teammates = N message deliveries; wastes resources for non-critical updates | Default to direct messages; broadcast only for critical team-wide issues |

---

## 11. Conformance Requirements

### 11.1 MUST (Required)

- The Orchestrator MUST NOT read source code, run tests, or write implementation code.
- The Orchestrator MUST set up task dependencies before spawning agents.
- Team Leads MUST write detailed results to `.cleo/agent-outputs/` files.
- Team Leads MUST report completion summaries to the Orchestrator via SendMessage.
- All agents MUST shut down or hand off before reaching the 185,000 token context limit.
- Wave transitions MUST wait for all blocking tasks to complete before spawning dependent agents.
- Task status MUST be tracked via TaskUpdate, not message-based reporting.

### 11.2 SHOULD (Recommended)

- The Orchestrator SHOULD spawn fresh agents for each wave rather than reusing saturated agents.
- The Orchestrator SHOULD shut down completed agents to free system resources.
- Team Leads SHOULD use descriptive agent names reflecting their role.
- Subagents SHOULD complete and terminate promptly after finishing their atomic task.
- The Orchestrator SHOULD NOT react to idle notifications unless assigning new work.

### 11.3 MAY (Optional)

- Team Leads MAY spawn Tier 2 subagents for parallel subtasks within their scope.
- The Orchestrator MAY spawn agents for a partial next wave when some (but not all) blockers have cleared.
- Independent specialists (e.g., spec-writers) MAY run in parallel with sequential wave chains when they have no code dependencies.

---

## 12. References

- `docs/specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md` -- Autonomous runtime foundation
- `docs/specs/MCP-AGENT-INTERACTION-SPEC.md` -- Progressive disclosure and agent interaction
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` -- Canonical operation registry
- `docs/specs/VERB-STANDARDS.md` -- Canonical verb standards
- `packages/ct-skills/skills/ct-orchestrator/SKILL.md` -- Orchestrator skill (LOOM, ORC constraints)
- `src/core/orchestration/waves.ts` -- Wave computation implementation
- `.cleo/agent-outputs/T5671-synthesis-report.md` -- T5671 gauntlet case study results
