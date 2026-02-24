---
title: "CLEO BRAIN Specification"
version: "1.1.0"
status: "draft"
created: "2026-02-03"
updated: "2026-02-09"
epic: "T2975"
task: "T3002"
authors: ["Claude Opus 4.5", "CLEO Development Team"]
---

# CLEO BRAIN Specification

**Version**: 1.1.0
**Status**: DRAFT
**Date**: 2026-02-09
**Epic**: T2975 - CLEO Consolidation Sprint
**Task**: T3002 - Specification: Define AGENTIC BRAIN Concrete Requirements

---

## 1. Executive Summary

This specification defines CLEO as an **Agentic Cognitive Infrastructure** implementing the BRAIN model: a five-dimensional system that transforms CLEO from a task manager into persistent cognitive substrate for autonomous AI agent coordination.

### 1.0 Authority and Scope

This document is a capability-model specification. Product identity and canonical invariants are defined by higher-authority documents:

1. `docs/concepts/vision.mdx` (immutable vision identity)
2. `docs/specs/PORTABLE-BRAIN-SPEC.md` (canonical product contract)

If conflicts occur, higher-authority documents prevail. This specification defines dimension-level implementation requirements and measurable certification criteria.

**BRAIN** is not metaphor but architecture:

| Dimension | What It Means | Current Gap |
|-----------|---------------|-------------|
| **B**ase (Memory) | Persistent knowledge across sessions | No decision/pattern memory |
| **R**easoning | Causal inference and temporal analysis | Static dependency graph only |
| **A**gent | Autonomous multi-agent orchestration | No self-healing or learning |
| **I**ntelligence | Adaptive validation and prediction | No pattern extraction |
| **N**etwork | Cross-project knowledge coordination | Unvalidated Nexus (zero usage) |

**From**: Task manager with anti-hallucination validation (Tier S)
**To**: Cognitive infrastructure for AI-driven development workflows (Tier M/L)

### 1.1 Guiding Principles

1. **Memory First**: Persistent knowledge before advanced reasoning
2. **Evidence-Based**: Validate each capability before expansion
3. **Agent-Native**: Design for autonomous agents, not human workflows
4. **Incremental Rollout**: Phase-gated implementation aligned with Strategic Roadmap
5. **Anti-Hallucination**: Core validation architecture is non-negotiable

---

## 2. BRAIN Dimension Specifications

### 2.1 Base (Memory Layer)

**Purpose**: Persistent knowledge storage and retrieval across sessions

#### 2.1.1 Current State (v0.80.0)

**Storage Architecture** (per ADR-006):
```
.cleo/
├── cleo.db                # SQLite database (tasks, sessions, lifecycle — per ADR-006)
│   ├── tasks              # Active + archived tasks (status-based)
│   ├── sessions           # Session state
│   ├── lifecycle_*        # RCSD-IVTR pipeline state
│   └── task_*             # Dependencies, relations, work history
├── config.json            # Human-editable configuration (JSON — ADR-006 exception)
└── todo-log.jsonl         # Immutable audit trail (append-only)

claudedocs/agent-outputs/
└── MANIFEST.jsonl         # Research artifacts (append-only)
```

**Capabilities**:
- Task persistence (atomic operations)
- Session state tracking
- Research artifact manifest
- RCSD lifecycle state

**Limitations**:
- **No decision memory**: Why choices were made
- **No pattern memory**: Recognized workflows
- **No learning memory**: Accumulated insights
- **No conversation continuity**: Each session starts fresh

#### 2.1.2 Target Capabilities

| Capability | Description | Data Structure | Implementation |
|------------|-------------|----------------|----------------|
| **Context Persistence** | Resume conversation state across sessions | `sessions` table (SQLite, per ADR-006) | Phase 1 |
| **Decision Memory** | Record architectural decisions with rationale | `brain_decisions` table (SQLite, per ADR-009) | Phase 2 |
| **Pattern Memory** | Store recognized workflow patterns | `brain_patterns` table (SQLite, per ADR-009) | Phase 2 |
| **Learning Memory** | Accumulated insights from completed work | `brain_learnings` table (SQLite, per ADR-009) | Phase 3 |
| **Temporal Queries** | "What was decided about X in January?" | SQLite FTS on brain_decisions | Phase 2 |
| **Memory Consolidation** | Compress old memories into summaries | Consolidation pipeline | Phase 3 |
| **Memory Export/Import** | Portable JSONL export for cross-project transfer | JSONL files (export format only, per ADR-009) | Phase 2 |

#### 2.1.3 Data Structures

> **Storage Note (ADR-006 / ADR-009)**: All BRAIN memory data is stored in SQLite tables at runtime. JSONL is used only as an export/import format for portability. See ADR-009 Section 3 for the full hybrid storage model.

**Session Context** — stored in `sessions` table (`.cleo/cleo.db`, per ADR-006)

Context fields are stored as JSON columns within the existing sessions table. Example row:

```json
{
  "id": "session_20260203_094904_1a1046",
  "name": "BRAIN Specification Work",
  "status": "active",
  "scope_json": "{\"type\":\"epic\",\"id\":\"T2975\"}",
  "notes_json": "[\"Working on CLEO Consolidation Sprint. Current focus: BRAIN specification.\"]",
  "started_at": "2026-02-03T09:49:04Z"
}
```

**Decision Memory** — `brain_decisions` table (`.cleo/cleo.db`, per ADR-009)

```sql
-- See ADR-009 Section 3.2 for full schema
-- Example rows:
INSERT INTO brain_decisions (id, type, decision, rationale, confidence, context_epic_id, context_task_id, created_at)
VALUES
  ('D001', 'architecture', 'Adopt BRAIN model for cognitive infrastructure',
   'Provides concrete capabilities vs abstract intelligence', 'high', 'T2975', 'T3002', '2026-02-03T17:00:00Z'),
  ('D002', 'technical', 'Use SQLite-vec for semantic search',
   'No external dependencies, proven stability', 'medium', NULL, 'T2973', '2026-02-03T18:00:00Z');
```

**Pattern Memory** — `brain_patterns` table (`.cleo/cleo.db`, per ADR-009)

```sql
-- See ADR-009 Section 3.2 for full schema
-- Example rows:
INSERT INTO brain_patterns (id, type, pattern, context, frequency, success_rate, examples_json, extracted_at)
VALUES
  ('P001', 'workflow', 'Research -> Consensus -> Specification -> Decomposition',
   'RCSD lifecycle', 15, 0.93, '["T2968","T2975"]', '2026-02-03T18:00:00Z'),
  ('P002', 'blocker', 'Database tasks without migration plan block 2-3 downstream tasks',
   'Schema changes', 8, NULL, '["T1234","T1456"]', '2026-02-03T18:00:00Z');
```

**Learning Memory** — `brain_learnings` table (`.cleo/cleo.db`, per ADR-009)

```sql
-- See ADR-009 Section 3.2 for full schema
-- Example rows:
INSERT INTO brain_learnings (id, insight, source, confidence, actionable, applicable_types_json, application, created_at)
VALUES
  ('L001', 'Tasks labeled research take 2-4 days median, 80% CI',
   '50 completed research tasks', 0.85, 1, '["research"]',
   'Suggest realistic timeline for new research tasks', '2026-02-03T18:00:00Z'),
  ('L002', 'Epics with >15 subtasks have 60% higher failure rate',
   '30 completed epics', 0.78, 1, '["epic"]',
   'Warn when epic exceeds 12 subtasks, suggest decomposition', '2026-02-03T18:00:00Z');
```

**JSONL Export Format** (for portability — not runtime storage)

BRAIN memory can be exported to JSONL for cross-project transfer via Nexus:
```bash
cleo memory export --type decisions --output decisions.jsonl
cleo memory import --type decisions --input decisions.jsonl
```

#### 2.1.4 Interfaces (CLI Commands)

The following commands **MUST** be implemented:

```bash
# Store knowledge
cleo memory store --type decision --content "Use SQLite-vec for semantic search" \
  --rationale "No external dependencies" \
  --linked-task T2973

# Recall knowledge
cleo memory recall "Why did we choose SQLite-vec?"
# Output: Decision D002: Use SQLite-vec for semantic search
#         Rationale: No external dependencies
#         Context: Phase 2 implementation
#         Confidence: medium

# Search memory
cleo memory search "authentication" --type decision --date-range "2026-01"

# Consolidate memory
cleo memory consolidate --period "2026-Q1" --output claudedocs/consolidated/2026-Q1-summary.md
```

#### 2.1.5 Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Context recall accuracy** | >90% after 7 days | Blind recall test with 20 sessions |
| **Decision retrieval time** | <500ms for 1,000 decisions | Benchmark on production data |
| **Pattern recognition** | >10 actionable patterns per 50 epics | Manual review by HITL |
| **Storage efficiency** | <10MB for 1 year of memory | File system audit |

---

### 2.2 Reasoning (Inference Layer)

**Purpose**: Causal inference, similarity detection, and temporal reasoning

#### 2.2.1 Current State (v0.80.0)

**Capabilities**:
- Dependency graph analysis (`cleo deps`)
- Wave-based parallel execution (`cleo orchestrator analyze`)
- Graph-RAG semantic discovery

**Limitations**:
- **Static dependencies**: No causal inference ("Why did X happen?")
- **No similarity matching**: Cannot find similar past work
- **No impact prediction**: Cannot predict downstream effects
- **No temporal reasoning**: Cannot analyze timelines (prohibited by "NO TIME ESTIMATES" rule)

#### 2.2.2 Target Capabilities

| Capability | Description | Implementation | Phase |
|------------|-------------|----------------|-------|
| **Causal Inference** | "Task T1 failed → blocked T2 → delayed Epic E" | Dependency trace with state history | Phase 2 |
| **Similarity Detection** | "Find tasks similar to authentication implementation" | SQLite-vec embeddings | Phase 2 |
| **Impact Prediction** | "Changing API X affects 7 tasks across 3 epics" | Reverse dependency analysis | Phase 2 |
| **Timeline Analysis** | "Similar epics took 2-4 weeks, median 3 weeks" | Historical pattern matching | Phase 3 |
| **Counterfactual Reasoning** | "If we chose approach B, timeline would differ by X" | Decision tree simulation | Phase 3 (experimental) |

#### 2.2.3 Causal Inference Model

**Causal Graph Structure**:

```
Task Event → Dependency Impact → Epic Outcome
     ↓              ↓                  ↓
  Blockers    Parallel Wave     Completion Time
     ↓              ↓                  ↓
  Root Cause  Critical Path     Predictive Model
```

**Example Query**:
```bash
cleo reason why --task T2345 --outcome blocked

# Output:
# Causal Chain:
#   1. T2345 depends on T2300 (migration task)
#   2. T2300 blocked due to missing schema approval
#   3. Schema approval required decision D045 (not yet made)
#   4. Decision D045 waiting on consensus C012
#   5. ROOT CAUSE: Consensus C012 incomplete (3/5 votes)
#
# Recommendation: Complete consensus C012 to unblock chain
```

#### 2.2.4 Similarity Detection Model

**Embedding Architecture**:

```
Task Description + Labels + Context
            ↓
    Text Embedding Model
            ↓
    SQLite-vec Storage
            ↓
    Cosine Similarity Search
            ↓
    Ranked Results (threshold > 0.8)
```

**Example Query**:
```bash
cleo reason similar --task T3002 --threshold 0.8 --limit 5

# Output:
# Similar Tasks (similarity score):
#   1. T2973 (0.92): Specification: CLEO Strategic Roadmap
#   2. T2971 (0.89): Research: BRAIN Vision Requirements
#   3. T2400 (0.87): Design: Skill Loading Mechanism
#   4. T2398 (0.85): Specification: Protocol Stack v1
#   5. T1234 (0.82): Specification: MCP Server Architecture
```

#### 2.2.5 Temporal Analysis Model

**Clarification: "No Time Estimates" vs Historical Analysis**

| Prohibited | Allowed |
|-----------|---------|
| ❌ "This task will take 3 hours" | ✅ "Similar tasks historically took 2-4 days (median 3 days, 80% CI)" |
| ❌ "Epic will complete by Friday" | ✅ "20 similar epics: 15 took 2-3 weeks, 3 took 4+ weeks, 2 failed" |
| ❌ Agent/human time estimates | ✅ Historical timeline analysis for learning only |

**Rationale**: Temporal reasoning enables **learning** (identify patterns) without **commitment** (prevent hallucinated estimates).

**Example Query**:
```bash
cleo reason timeline --type research --sample-size 50

# Output:
# Historical Timeline Analysis (50 research tasks):
#   Median: 3 days
#   80% Confidence Interval: 2-4 days
#   95% Confidence Interval: 1-6 days
#   Outliers: 2 tasks took 10+ days (investigation required)
#
# Distribution:
#   1 day:  5 tasks (10%)
#   2 days: 15 tasks (30%)
#   3 days: 18 tasks (36%)
#   4 days: 10 tasks (20%)
#   5+ days: 2 tasks (4%)
#
# Note: This is historical context, NOT a prediction or estimate
```

#### 2.2.6 Interfaces (CLI Commands)

```bash
# Causal inference
cleo reason why --task T2345
cleo reason why --epic T2975 --outcome delayed

# Similarity detection
cleo reason similar --task T3002 --threshold 0.8
cleo reason similar --description "authentication implementation" --limit 10

# Impact prediction
cleo reason impact --change "Modify GraphRAG interface"
cleo reason impact --task T2345 --what-if completed

# Timeline analysis (historical context only)
cleo reason timeline --type research
cleo reason timeline --epic T2975 --compare-to T2968

# Counterfactual (experimental)
cleo reason counterfactual --decision D045 --alternative "Use PostgreSQL instead of SQLite"
```

#### 2.2.7 Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Causal inference accuracy** | >85% root cause identified correctly | Blind validation on 50 blocked tasks |
| **Similarity relevance** | >80% of top-5 results rated relevant | User satisfaction survey |
| **Impact prediction recall** | >90% of affected tasks identified | Compare prediction vs actual |
| **Timeline analysis usefulness** | >70% of users find context helpful | Feedback survey |

---

### 2.3 Agent (Orchestration Layer)

**Purpose**: Autonomous multi-agent coordination with self-healing and learning

#### 2.3.1 Current State (v0.80.0)

**Architecture**:
- Orchestrator (ct-orchestrator)
- Universal subagent (cleo-subagent)
- 7 conditional protocols (Research, Consensus, Specification, Decomposition, Implementation, Contribution, Release)
- Protocol enforcement (exit codes 60-70)
- RCSD-IVTR lifecycle

**Capabilities**:
- Multi-agent spawning via Task tool
- Protocol injection
- Token pre-resolution
- Manifest-based output

**Limitations**:
- **No self-healing**: Agent failures require HITL intervention
- **No load balancing**: All tasks queue, no capacity awareness
- **No learning from execution**: Same mistakes repeated
- **No capability discovery**: Manual skill assignment
- **No agent registry**: Cannot track active agents

#### 2.3.2 Target Capabilities

| Capability | Description | Implementation | Phase |
|------------|-------------|----------------|-------|
| **Self-Healing** | Recover from agent failures, reassign tasks | Retry + reassignment logic | Phase 1 |
| **Load Balancing** | Distribute work based on agent capacity | Task queue with capacity tracking | Phase 2 |
| **Learning from Execution** | Improve based on task outcomes | Feedback loop to pattern memory | Phase 3 |
| **Capability Discovery** | Auto-detect which agents handle which tasks | Agent registry with skill tagging | Phase 2 |
| **Agent Health Monitoring** | Track agent state, detect crashes | Heartbeat + timeout detection | Phase 1 |
| **Parallel Execution** | Run independent tasks concurrently | Wave-based parallelization (exists, enhance) | Current |

#### 2.3.3 Self-Healing Architecture

**Failure Detection**:

```
Agent Spawn
    ↓
Heartbeat Every 30s
    ↓
Timeout After 3min → FAILURE DETECTED
    ↓
Retry Logic (3 attempts, exponential backoff)
    ↓
If All Retries Fail → Reassign to Different Agent
    ↓
If Reassignment Fails → Escalate to HITL
```

**Example Scenario**:

```bash
# Agent crashes during task execution
# System detects timeout after 3 minutes
# Automatic retry with exponential backoff:
#   Attempt 1: Immediate
#   Attempt 2: Wait 2s
#   Attempt 3: Wait 4s
# If all fail, reassign to different agent pool
# Log failure to learning memory for pattern analysis
```

#### 2.3.4 Load Balancing Architecture

**Capacity Model**:

```
Agent Registry:
  - agent_id
  - current_tasks (max 5)
  - capacity_remaining (5 - current_tasks)
  - specialization (skills)
  - performance_history (completion rate, avg time)

Task Queue:
  - task_id
  - priority (critical > normal > background)
  - required_skills
  - estimated_complexity (small/medium/large)

Routing Algorithm:
  1. Filter agents by required skills
  2. Sort by capacity_remaining DESC
  3. Prefer agents with successful history for similar tasks
  4. Assign task to highest-ranked agent
  5. Update capacity tracking
```

#### 2.3.5 Learning from Execution

**Feedback Loop**:

```
Task Completion
    ↓
Outcome Analysis:
  - Success/Failure
  - Actual vs Expected Complexity
  - Blockers Encountered
  - Patterns Observed
    ↓
Store in Learning Memory (brain_learnings table)
    ↓
Update Agent Performance History
    ↓
Adjust Future Task Routing
```

**Example Learning Entry**:

```jsonl
{"id":"L003","timestamp":"2026-02-03T18:00:00Z","insight":"Tasks requiring database migration should be assigned to agents with 'migration' skill","source":"5 failed assignments to generalist agents","confidence":0.90,"actionable":true,"application":"Update routing to require 'migration' skill for schema change tasks"}
```

#### 2.3.6 Interfaces (CLI Commands)

```bash
# Agent management
cleo agent spawn --task T3002 --auto-select   # Auto-select agent by capabilities
cleo agent status                             # View all active agents
cleo agent kill session_xyz                   # Terminate agent (graceful)
cleo agent registry                           # List all registered agents

# Learning
cleo agent learn --task T3002 --outcome success --notes "Pattern X worked well"
cleo agent learn --task T3002 --outcome failure --notes "Blocker: missing schema approval"

# Capacity management
cleo agent capacity --show                    # View agent capacity usage
cleo agent capacity --limit 10                # Increase max concurrent agents
```

#### 2.3.7 Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Self-healing success rate** | >95% recovery without HITL | Production failure injection test |
| **Load balancing efficiency** | >70% agent utilization | Capacity tracking logs |
| **Learning effectiveness** | >20% efficiency gain over 30 days | A/B comparison: learning on vs off |
| **Agent uptime** | >99.5% availability | Monitoring logs |

---

### 2.4 Intelligence (Validation & Adaptation Layer)

**Purpose**: Adaptive validation, proactive suggestions, and quality prediction

#### 2.4.1 Current State (v0.80.0)

**Capabilities**:
- 4-layer validation (schema → semantic → referential → protocol)
- 72 standardized exit codes
- Protocol enforcement (RCSD-IVTR lifecycle)
- Lifecycle gate enforcement (strict/advisory/off modes)
- Anti-hallucination checks

**Limitations**:
- **Static validation**: Same rules for all tasks, no learning
- **Reactive only**: Validates after operation, no proactive suggestions
- **No error pattern learning**: Same errors repeated
- **No quality prediction**: Cannot predict task success likelihood

#### 2.4.2 Target Capabilities

| Capability | Description | Implementation | Phase |
|------------|-------------|----------------|-------|
| **Adaptive Validation** | Learn common errors, suggest fixes proactively | Error pattern database | Phase 2 |
| **Proactive Suggestions** | Suggest actions before user asks | Context analysis engine | Phase 3 |
| **Quality Prediction** | Predict task success likelihood before execution | ML model on historical data | Phase 3 |
| **Auto-Remediation** | Automatically fix known error patterns | Fix script library | Phase 2 |
| **Compliance Scoring** | Rate protocol adherence quality | Compliance metrics dashboard | Phase 1 |

#### 2.4.3 Adaptive Validation Model

**Error Pattern Learning**:

```
Error Occurrence
    ↓
Extract Pattern:
  - Error code + context
  - Common preconditions
  - Successful fixes
    ↓
Store in Pattern Memory (brain_patterns table)
    ↓
Generate Proactive Warning for Similar Context
    ↓
Suggest Pre-Validated Fix
```

**Example**:

```bash
# User attempts to spawn task without setting epic scope
cleo add "Implement feature X"

# Adaptive validation detects pattern:
# "40% of tasks added without epic scope are later reparented"
# Proactive suggestion:

[WARNING] E_COMMON_PATTERN_DETECTED
Pattern: Tasks without epic scope often require reparenting (40% historical rate)
Suggestion: Set parent epic now to avoid rework
Fix: cleo add "Implement feature X" --parent T2975
Alternative: Skip warning with --force flag
```

#### 2.4.4 Proactive Suggestion Engine

**Context Analysis**:

```
Current Session State
    ↓
Analyze:
  - Focused task + dependencies
  - Recent decisions + patterns
  - Historical similar sessions
    ↓
Identify Likely Next Actions
    ↓
Suggest Proactively (if confidence >80%)
```

**Example**:

```bash
cleo complete T3002

# Proactive suggestion engine detects:
# - T3002 is specification task
# - Historical pattern: 85% of specs followed by decomposition task
# - Next logical action: decompose epic

[SUGGESTION] Next Action Predicted (85% confidence)
Based on similar specification tasks, consider:
  1. Decompose epic for Phase 1 implementation
     Command: cleo orchestrator spawn T2975 --protocol decomposition
  2. Create follow-up research task for validation
     Command: cleo add "Research: BRAIN Memory Layer Validation" --parent T2975
  3. Continue with next pending task in epic
     Command: cleo next

Run suggested command? [1/2/3/n]
```

#### 2.4.5 Quality Prediction Model

**Prediction Architecture**:

```
Task Metadata:
  - Description complexity (word count, structure)
  - Dependency count
  - Label similarity to past failures
  - Agent performance history
    ↓
Historical Data (1,000+ completed tasks):
  - Success/failure rate by type
  - Blocker patterns
  - Time to completion distribution
    ↓
ML Model (Logistic Regression):
  - Predict success probability
  - Identify risk factors
  - Suggest mitigations
    ↓
Output: Risk Score + Recommendations
```

**Example**:

```bash
cleo add "Refactor sessions.sh to TypeScript" --parent T2975

# Quality prediction runs:

[QUALITY PREDICTION] Task Risk Analysis
Success Probability: 65% (MEDIUM RISK)

Risk Factors Identified:
  1. Large file (3,098 lines) → 40% higher failure rate
  2. No TypeScript experience in recent tasks → 25% confidence penalty
  3. 12 dependencies → 15% additional risk

Recommended Mitigations:
  - Break into 3 smaller subtasks (<1,000 lines each)
  - Add prerequisite task: "TypeScript migration guide research"
  - Reduce dependencies from 12 to <5 by decoupling modules

Proceed anyway? [y/n/adjust]
```

#### 2.4.6 Interfaces (CLI Commands)

```bash
# Adaptive validation
cleo intelligence learn-errors                # Train on error history
cleo intelligence suggest-fix --error E_VALIDATION_FAILED

# Proactive suggestions
cleo intelligence suggest                     # Based on current context
cleo intelligence suggest --confidence 0.9    # Only high-confidence suggestions

# Quality prediction
cleo intelligence predict --task T3002
cleo intelligence predict --description "Refactor sessions.sh"

# Compliance
cleo compliance score --task T3002
cleo compliance score --epic T2975 --summary
```

#### 2.4.7 Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Error prevention rate** | >30% of common errors prevented proactively | Before/after comparison |
| **Suggestion acceptance rate** | >60% of proactive suggestions accepted | User action tracking |
| **Prediction accuracy** | >75% success probability within ±10% | Validation on 100 tasks |
| **Compliance score correlation** | r>0.7 between compliance score and success | Statistical analysis |

---

### 2.5 Network (Cross-Project Coordination Layer)

**Purpose**: Multi-project knowledge sharing and federated agent coordination

#### 2.5.1 Current State (v0.80.0)

**Capabilities**:
- Nexus registry (cross-project references)
- Global project registration (`~/.cleo/projects/`)
- Project-level isolation

**Limitations**:
- **Unvalidated**: Nexus shipped 8 days ago, zero real-world usage data
- **No cross-project intelligence**: Cannot find related work across projects
- **No knowledge transfer**: Patterns discovered in Project A don't inform Project B
- **No federated agents**: Agents are project-scoped only
- **Validation risk**: May be archived if Phase 1 validation fails

#### 2.5.2 Target Capabilities

| Capability | Description | Implementation | Phase |
|------------|-------------|----------------|-------|
| **Cross-Project Search** | Find related work anywhere in Nexus | Nexus query with semantic search | Phase 1 |
| **Knowledge Transfer** | Apply learnings across projects | Pattern export/import | Phase 2 |
| **Federated Agents** | Coordinate agents across multiple projects | Agent registry + RPC | Phase 3 |
| **Global Intelligence** | Aggregate insights from all projects | Consolidated learning memory | Phase 3 |
| **Project Similarity** | "Find projects similar to current work" | Project embedding model | Phase 2 |

#### 2.5.3 Cross-Project Search Model

**Search Architecture**:

```
Query: "authentication implementations"
    ↓
Nexus Registry Scan (5+ projects)
    ↓
Semantic Search (SQLite-vec):
  - Task descriptions
  - Research artifacts
  - Decision memory
    ↓
Rank by Relevance + Recency
    ↓
Return Results with Context:
  - Project name
  - Task ID + title
  - Similarity score
  - Date + status
```

**Example Query**:

```bash
cleo network search "authentication JWT implementation"

# Output:
# Cross-Project Results (3 projects):
#
# Project: backend-api (similarity: 0.94)
#   - T456: Implement JWT authentication middleware
#     Status: completed (2026-01-15)
#     Key Decision: Use HS256 for internal services, RS256 for public API
#
# Project: mobile-app (similarity: 0.87)
#   - T789: Add JWT token refresh logic
#     Status: completed (2026-01-20)
#     Anti-Pattern: Token stored in localStorage caused security issue
#
# Project: admin-dashboard (similarity: 0.82)
#   - T234: JWT authentication integration
#     Status: active (2026-02-01)
#     Blocker: Waiting on backend-api token validation endpoint
```

#### 2.5.4 Knowledge Transfer Model

**Transfer Architecture**:

```
Source Project Pattern:
  - Pattern memory entry
  - Success rate + context
    ↓
Export to Global Pattern Library
    ↓
Target Project Import:
  - Relevance check (similar context?)
  - Adaptation (project-specific adjustments)
    ↓
Store in Target Project Pattern Memory
    ↓
Track Transfer Effectiveness
```

**Example**:

```bash
# Export pattern from project A
cd /path/to/project-a
cleo network export-pattern P001 --global

# Pattern P001: "RCSD lifecycle reduces rework by 40%"
# Exported to: ~/.cleo/cleo-nexus.db (global_patterns table)

# Import to project B
cd /path/to/project-b
cleo network import-pattern P001 --adapt-to-context

# Pattern P001 imported and adapted:
# - Context adjusted for project B's workflow
# - Applied to 5 pending epics
# - Tracking effectiveness for 30 days
```

#### 2.5.5 Federated Agent Coordination

**Federation Architecture** (Phase 3):

```
Project A: Agent Pool (5 agents)
Project B: Agent Pool (3 agents)
Project C: Agent Pool (7 agents)
    ↓
Global Agent Registry:
  - Track all agents across projects
  - Coordinate cross-project tasks
  - Load balance globally
    ↓
Cross-Project Task Assignment:
  - Task in Project A requires expertise from Project B
  - Temporarily assign agent from Project B
  - Return agent after completion
```

**Use Case**:

```bash
# Project A needs database migration expertise
# Project B has agent specialized in migrations
# Global coordinator temporarily assigns Project B agent to Project A
# After completion, agent returns to Project B pool
```

#### 2.5.6 Interfaces (CLI Commands)

```bash
# Cross-project search
cleo network search "authentication implementation"
cleo network search --project backend-api --query "JWT"

# Knowledge transfer
cleo network export-pattern P001 --global
cleo network import-pattern P001 --project /path/to/project-b
cleo network list-patterns --global

# Federated agents (Phase 3)
cleo network agents                            # List all agents across projects
cleo network coordinate --projects "A,B,C"     # Cross-project coordination
cleo network transfer-agent agent_xyz --from A --to B --duration 2h

# Global intelligence
cleo network insights                          # Aggregate insights from all projects
cleo network similarity --project backend-api  # Find similar projects
```

#### 2.5.7 Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Cross-project query usefulness** | >70% of queries find relevant results | User feedback survey |
| **Knowledge transfer effectiveness** | >30% improvement in target project | Before/after comparison |
| **Federated agent utilization** | >80% when enabled | Capacity tracking |
| **Global pattern library growth** | >50 patterns after 6 months | Pattern count audit |

#### 2.5.8 Nexus Validation Gate (Phase 1)

**CRITICAL**: Network dimension expansion is **contingent** on Nexus validation.

**Validation Criteria** (ALL MUST pass):

| Metric | Target | Period | Status |
|--------|--------|--------|--------|
| Active Users | ≥3 developers | 30 days | PENDING |
| Multi-Project Usage | ≥2 projects/user | 30 days | PENDING |
| Cross-Project Queries | >100 queries | 30 days | PENDING |
| Time Savings | >30% context discovery reduction | 30 days | PENDING |

**If Validation Fails**:
- Consolidate Nexus (5 files → 1 file)
- Defer Network dimension to Phase 3+
- Focus on Base, Reasoning, Agent, Intelligence dimensions only

**If Validation Succeeds**:
- Expand Nexus with semantic search (Phase 2)
- Implement knowledge transfer (Phase 2)
- Add federated agents (Phase 3)

---

## 3. Implementation Phases

### 3.1 Phase Alignment with Strategic Roadmap

| BRAIN Dimension | Phase 0 (M1-2) | Phase 1 (M3-4) | Phase 2 (M5-9) | Phase 3 (M10-18) |
|-----------------|----------------|----------------|----------------|------------------|
| **Base (Memory)** | Current state | Context persistence | Decision/Pattern memory | Learning memory + consolidation |
| **Reasoning** | Current state | — | Causal + Similarity + Impact | Timeline analysis + Counterfactual |
| **Agent** | Current state | Self-healing + Health monitoring | Load balancing + Capability discovery | Learning from execution |
| **Intelligence** | Current state | Compliance scoring | Adaptive validation | Proactive suggestions + Quality prediction |
| **Network** | Current state | Cross-project search (if Nexus validates) | Knowledge transfer + Project similarity | Federated agents + Global intelligence |

### 3.2 Phase 0: Foundation (Months 1-2)

**Goal**: Simplify codebase + deliver MCP Server (no BRAIN expansion yet)

**BRAIN-Relevant Work**:
- MCP Server architecture (prepares for Agent layer enhancements)
- File consolidation (reduces cognitive load for future BRAIN features)
- No new BRAIN capabilities in this phase

**Deliverables**:
- 163 files → 100 files
- MCP Server v1.0.0 (2 tools: `cleo_query`, `cleo_mutate`)
- Zero breaking changes

### 3.3 Phase 1: Validation (Months 3-4)

**Goal**: Validate Nexus + MCP adoption before BRAIN expansion

**BRAIN-Relevant Work**:

#### Base (Memory) - Context Persistence

**Epic: Session Context Persistence**

| Task | Description | Timeline |
|------|-------------|----------|
| Design context schema | `session-context.json` structure | 1 week |
| Implement context save | Store on session end | 1 week |
| Implement context resume | Restore on session start | 1 week |
| Test context continuity | Validate 7-day recall | 1 week |

**Success Criteria**:
- Context recall >90% accurate after 7 days
- Zero data loss during context save/restore

#### Agent - Self-Healing

**Epic: Agent Self-Healing Infrastructure**

| Task | Description | Timeline |
|------|-------------|----------|
| Implement heartbeat monitoring | 30s intervals | 1 week |
| Add timeout detection | 3min timeout threshold | 1 week |
| Build retry logic | 3 attempts, exponential backoff | 1 week |
| Add reassignment logic | Failover to different agent | 1 week |

**Success Criteria**:
- >95% automatic recovery rate
- Zero task loss during agent failures

#### Intelligence - Compliance Scoring

**Epic: Protocol Compliance Scoring**

| Task | Description | Timeline |
|------|-------------|----------|
| Define compliance metrics | Score calculation algorithm | 1 week |
| Implement scoring dashboard | `cleo compliance score` | 1 week |
| Historical analysis | Backfill scores for completed tasks | 1 week |
| Correlation validation | Score vs success rate | 1 week |

**Success Criteria**:
- r>0.7 correlation between score and success
- Scoring overhead <100ms per task

#### Network - Cross-Project Search (Conditional)

**Epic: Nexus Cross-Project Search** (ONLY if Nexus validates)

| Task | Description | Timeline |
|------|-------------|----------|
| Nexus validation tracking | Measure 5 criteria for 30 days | 30 days (passive) |
| Semantic search integration | SQLite-vec for Nexus queries | 2 weeks |
| Cross-project query API | `cleo network search` | 1 week |
| Performance benchmarking | <3s for 10 projects | 1 week |

**Validation Gate**: If Nexus fails validation, defer Network dimension to Phase 3+

### 3.4 Phase 2: Intelligence (Months 5-9)

**Goal**: Add semantic intelligence capabilities (Tier M scale)

**Precondition**: Phase 1 validation MUST pass for Nexus AND MCP Server

#### Base (Memory) - Decision/Pattern Memory

**Epic: Decision and Pattern Memory**

| Task | Description | Timeline |
|------|-------------|----------|
| Design decision schema | `brain_decisions` SQLite table (per ADR-009) | 1 week |
| Design pattern schema | `brain_patterns` SQLite table (per ADR-009) | 1 week |
| Implement decision logging | `cleo memory store --type decision` | 2 weeks |
| Implement pattern extraction | Auto-extract from completed epics | 3 weeks |
| Build query interface | `cleo memory recall`, `cleo memory search` | 2 weeks |

**Success Criteria**:
- >10 actionable patterns extracted per 50 epics
- Decision retrieval <500ms for 1,000 entries

#### Reasoning - Causal + Similarity + Impact

**Epic: Reasoning Engine v1**

| Task | Description | Timeline |
|------|-------------|----------|
| Causal inference implementation | `cleo reason why` | 3 weeks |
| Similarity detection (SQLite-vec) | `cleo reason similar` | 3 weeks |
| Impact prediction | `cleo reason impact` | 2 weeks |
| Historical timeline analysis | `cleo reason timeline` (context only) | 2 weeks |

**Success Criteria**:
- >85% causal inference accuracy (blind validation)
- >80% similarity relevance (user survey)
- >90% impact prediction recall

#### Agent - Load Balancing + Capability Discovery

**Epic: Agent Registry and Load Balancing**

| Task | Description | Timeline |
|------|-------------|----------|
| Build agent registry | Track capacity + skills | 2 weeks |
| Implement capacity tracking | Max 5 tasks/agent | 1 week |
| Build routing algorithm | Skill-based + capacity-aware | 3 weeks |
| Performance optimization | <100ms routing latency | 1 week |

**Success Criteria**:
- Support 5-20 concurrent agents
- >70% agent utilization

#### Intelligence - Adaptive Validation

**Epic: Adaptive Validation Engine**

| Task | Description | Timeline |
|------|-------------|----------|
| Error pattern database | Store common errors + fixes | 2 weeks |
| Proactive warning system | Detect patterns before errors | 3 weeks |
| Auto-remediation library | Fix scripts for known errors | 2 weeks |
| Effectiveness tracking | Measure prevention rate | 1 week |

**Success Criteria**:
- >30% common errors prevented proactively
- <5% false positive rate

#### Network - Knowledge Transfer (Conditional)

**Epic: Cross-Project Knowledge Transfer** (ONLY if Nexus validated)

| Task | Description | Timeline |
|------|-------------|----------|
| Global pattern library | `~/.cleo/cleo-nexus.db` (global_patterns table) | 2 weeks |
| Export/import interface | `cleo network export-pattern` | 2 weeks |
| Pattern adaptation logic | Context-aware adjustments | 3 weeks |
| Effectiveness tracking | Measure transfer impact | 1 week |

**Success Criteria**:
- >30% improvement in target projects
- Pattern library grows to 50+ patterns after 6 months

### 3.5 Phase 3: Scale (Months 10-18)

**Goal**: Support Tier L scale (3-10 projects, 5-20 concurrent agents)

**Precondition**: Phase 2 MUST validate TypeScript value AND Tier M usage demonstrated

#### Base (Memory) - Learning Memory + Consolidation

**Epic: Learning Memory and Memory Consolidation**

| Task | Description | Timeline |
|------|-------------|----------|
| Design learning schema | `brain_learnings` SQLite table (per ADR-009) | 1 week |
| Implement learning extraction | Auto-extract insights from completed work | 4 weeks |
| Build consolidation pipeline | Compress old memories into summaries | 3 weeks |
| Semantic linking | Connect related memories | 2 weeks |

**Success Criteria**:
- >20% efficiency gain over 30 days (learning enabled vs disabled)
- Storage <10MB for 1 year of memory

#### Reasoning - Timeline Analysis + Counterfactual

**Epic: Advanced Reasoning Capabilities**

| Task | Description | Timeline |
|------|-------------|----------|
| Timeline prediction model | ML model for historical analysis | 4 weeks |
| Counterfactual simulation | Decision tree "what-if" analysis | 3 weeks |
| Deadline feasibility checks | Based on historical data | 2 weeks |
| Integration testing | Validate predictions on 100 tasks | 1 week |

**Success Criteria**:
- >75% prediction accuracy within ±10%
- Timeline analysis rated useful by >70% of users

#### Agent - Learning from Execution

**Epic: Agent Learning and Improvement**

| Task | Description | Timeline |
|------|-------------|----------|
| Feedback loop implementation | Capture task outcomes + blockers | 3 weeks |
| Performance history tracking | Agent success rates + patterns | 2 weeks |
| Adaptive routing | Adjust assignments based on learning | 3 weeks |
| A/B testing framework | Measure learning effectiveness | 2 weeks |

**Success Criteria**:
- >20% efficiency gain over 30 days
- Agent routing accuracy improves by >15%

#### Intelligence - Proactive Suggestions + Quality Prediction

**Epic: Proactive Intelligence**

| Task | Description | Timeline |
|------|-------------|----------|
| Context analysis engine | Predict next actions | 4 weeks |
| Quality prediction model | ML model for task risk scoring | 4 weeks |
| Suggestion acceptance tracking | Measure usefulness | 1 week |
| Prediction accuracy validation | Test on 100 tasks | 1 week |

**Success Criteria**:
- >60% suggestion acceptance rate
- >75% prediction accuracy within ±10%

#### Network - Federated Agents + Global Intelligence

**Epic: Federated Multi-Project Coordination** (ONLY if Tier L usage demonstrated)

| Task | Description | Timeline |
|------|-------------|----------|
| Global agent registry | Track agents across projects | 3 weeks |
| Cross-project RPC | Agent communication protocol | 4 weeks |
| Global load balancing | Coordinate across projects | 3 weeks |
| Global intelligence aggregation | Consolidated insights dashboard | 2 weeks |

**Success Criteria**:
- >80% federated agent utilization
- Global pattern library >100 patterns

---

## 4. Data Structures (JSON Schemas)

### 4.1 Session Context Schema

**File**: `schemas/session-context.schema.json`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://cleo-dev.com/schemas/v1/session-context.schema.json",
  "title": "CLEO Session Context",
  "description": "Persistent conversation context across sessions",
  "type": "object",
  "required": ["_meta", "sessionId", "context", "lastUpdated"],
  "properties": {
    "_meta": {
      "type": "object",
      "required": ["schemaVersion", "type"],
      "properties": {
        "schemaVersion": {
          "type": "string",
          "pattern": "^\\d+\\.\\d+\\.\\d+$",
          "description": "Schema version (semver)"
        },
        "type": {
          "type": "string",
          "const": "session-context"
        }
      }
    },
    "sessionId": {
      "type": "string",
      "pattern": "^session_\\d{8}_\\d{6}_[a-f0-9]{6}$",
      "description": "Session identifier"
    },
    "context": {
      "type": "object",
      "required": ["conversationSummary"],
      "properties": {
        "conversationSummary": {
          "type": "string",
          "maxLength": 1000,
          "description": "High-level summary of conversation context"
        },
        "keyDecisions": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["timestamp", "decision", "rationale"],
            "properties": {
              "timestamp": {
                "type": "string",
                "format": "date-time"
              },
              "decision": {
                "type": "string",
                "maxLength": 500
              },
              "rationale": {
                "type": "string",
                "maxLength": 1000
              }
            }
          }
        },
        "openQuestions": {
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 500
          }
        },
        "nextActions": {
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 500
          }
        }
      }
    },
    "lastUpdated": {
      "type": "string",
      "format": "date-time"
    },
    "tokenBudget": {
      "type": "object",
      "properties": {
        "used": {
          "type": "integer",
          "minimum": 0
        },
        "total": {
          "type": "integer",
          "minimum": 0
        },
        "percentage": {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        }
      }
    }
  }
}
```

### 4.2 Decision Memory Schema

**File**: `schemas/decision-memory.schema.json`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://cleo-dev.com/schemas/v1/decision-memory.schema.json",
  "title": "CLEO Decision Memory Entry",
  "description": "Architectural decision with rationale and context",
  "type": "object",
  "required": ["id", "timestamp", "type", "decision", "rationale", "context", "confidence"],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^D\\d{3,}$",
      "description": "Decision identifier (D001, D002, ...)"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time"
    },
    "type": {
      "type": "string",
      "enum": ["architecture", "technical", "process", "strategic", "tactical"],
      "description": "Decision category"
    },
    "decision": {
      "type": "string",
      "maxLength": 500,
      "description": "What was decided"
    },
    "rationale": {
      "type": "string",
      "maxLength": 1000,
      "description": "Why this decision was made"
    },
    "context": {
      "type": "object",
      "properties": {
        "epic": {
          "type": "string",
          "pattern": "^T\\d{3,}$"
        },
        "task": {
          "type": "string",
          "pattern": "^T\\d{3,}$"
        },
        "phase": {
          "type": "string"
        }
      }
    },
    "outcome": {
      "type": ["string", "null"],
      "enum": ["success", "failure", "mixed", "pending", null],
      "description": "Decision outcome (null if not yet evaluated)"
    },
    "confidence": {
      "type": "string",
      "enum": ["low", "medium", "high"],
      "description": "Confidence level in decision"
    },
    "alternatives": {
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 500
      },
      "description": "Alternative approaches considered"
    },
    "linkedTasks": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^T\\d{3,}$"
      }
    }
  }
}
```

### 4.3 Pattern Memory Schema

**File**: `schemas/pattern-memory.schema.json`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://cleo-dev.com/schemas/v1/pattern-memory.schema.json",
  "title": "CLEO Pattern Memory Entry",
  "description": "Recognized workflow pattern or anti-pattern",
  "type": "object",
  "required": ["id", "type", "pattern", "context", "frequency", "extractedAt"],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^P\\d{3,}$",
      "description": "Pattern identifier (P001, P002, ...)"
    },
    "type": {
      "type": "string",
      "enum": ["workflow", "blocker", "success", "failure", "optimization"],
      "description": "Pattern category"
    },
    "pattern": {
      "type": "string",
      "maxLength": 500,
      "description": "Pattern description"
    },
    "context": {
      "type": "string",
      "maxLength": 500,
      "description": "Context where pattern applies"
    },
    "frequency": {
      "type": "integer",
      "minimum": 1,
      "description": "Number of times pattern observed"
    },
    "successRate": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "Success rate for workflow patterns (0.0-1.0)"
    },
    "impact": {
      "type": "string",
      "enum": ["low", "medium", "high"],
      "description": "Impact level for blocker patterns"
    },
    "extractedAt": {
      "type": "string",
      "format": "date-time"
    },
    "examples": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^T\\d{3,}$"
      },
      "description": "Example task IDs where pattern occurred"
    },
    "antiPattern": {
      "type": "string",
      "maxLength": 500,
      "description": "Related anti-pattern to avoid"
    },
    "mitigation": {
      "type": "string",
      "maxLength": 500,
      "description": "How to avoid/fix this pattern"
    }
  }
}
```

### 4.4 Learning Memory Schema

**File**: `schemas/learning-memory.schema.json`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://cleo-dev.com/schemas/v1/learning-memory.schema.json",
  "title": "CLEO Learning Memory Entry",
  "description": "Accumulated insight from historical data",
  "type": "object",
  "required": ["id", "timestamp", "insight", "source", "confidence", "actionable"],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^L\\d{3,}$",
      "description": "Learning identifier (L001, L002, ...)"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time"
    },
    "insight": {
      "type": "string",
      "maxLength": 1000,
      "description": "What was learned"
    },
    "source": {
      "type": "string",
      "maxLength": 500,
      "description": "Data source for this learning"
    },
    "confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "Confidence level (0.0-1.0)"
    },
    "applicableToTypes": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Task types this learning applies to"
    },
    "actionable": {
      "type": "boolean",
      "description": "Can this insight be acted upon?"
    },
    "application": {
      "type": "string",
      "maxLength": 500,
      "description": "How to apply this learning"
    }
  }
}
```

---

## 5. Success Metrics

### 5.1 BRAIN Certification Criteria

**When is CLEO a true AGENTIC BRAIN?**

All 5 dimensions MUST meet certification criteria:

| Dimension | Certification Criteria | Evidence Required | Timeline |
|-----------|------------------------|-------------------|----------|
| **Base (Memory)** | Multi-modal storage (JSON + SQLite), context recall >90%, <10MB/year | Performance benchmarks + storage audit | Phase 1-3 |
| **Reasoning** | Causal inference >85% accuracy, similarity relevance >80%, impact recall >90% | Blind validation on 100 tasks | Phase 2-3 |
| **Agent** | Self-healing >95% recovery, load balancing >70% utilization, learning >20% efficiency gain | Production load testing | Phase 1-3 |
| **Intelligence** | Adaptive validation >30% error prevention, proactive suggestions >60% acceptance, quality prediction >75% accuracy | A/B comparison + user surveys | Phase 2-3 |
| **Network** | Cross-project queries >70% useful, knowledge transfer >30% improvement, >50 global patterns | Multi-project usage data | Phase 1-3 (contingent) |

**Certification Gate**: After Phase 3 completion (Month 18+)

### 5.2 Phase-Specific Success Metrics

**Phase 1 (Months 3-4)**:

| Metric | Target | Status |
|--------|--------|--------|
| Context recall accuracy | >90% after 7 days | PENDING |
| Self-healing recovery rate | >95% without HITL | PENDING |
| Compliance score correlation | r>0.7 with success rate | PENDING |
| Nexus cross-project queries | >100 in 30 days | PENDING (validation gate) |

**Phase 2 (Months 5-9)**:

| Metric | Target | Status |
|--------|--------|--------|
| Pattern extraction | >10 per 50 epics | PENDING |
| Causal inference accuracy | >85% blind validation | PENDING |
| Similarity relevance | >80% user satisfaction | PENDING |
| Agent load balancing | >70% utilization | PENDING |
| Error prevention rate | >30% proactive | PENDING |

**Phase 3 (Months 10-18)**:

| Metric | Target | Status |
|--------|--------|--------|
| Learning effectiveness | >20% efficiency gain | PENDING |
| Timeline analysis usefulness | >70% user satisfaction | PENDING |
| Quality prediction accuracy | >75% within ±10% | PENDING |
| Suggestion acceptance rate | >60% acceptance | PENDING |
| Global pattern library | >50 patterns after 6 months | PENDING |

### 5.3 Continuous Monitoring Metrics

**Production Metrics** (tracked via OpenTelemetry):

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Memory storage growth | <10MB/year | >20MB/year |
| Query response time | <3s p95 | >5s p95 |
| Agent uptime | >99.5% | <99% |
| Context recall accuracy | >90% | <85% |
| Error prevention rate | >30% | <20% |

---

## 6. Risks and Mitigations

### 6.1 High-Risk Decisions

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Memory bloat** | Storage grows >100MB/year, performance degrades | Memory consolidation pipeline, strict retention policies |
| **Learning accuracy** | Wrong patterns learned, reduced efficiency | Confidence thresholds, HITL review, rollback mechanism |
| **Network dimension failure** | Nexus validation fails, lose cross-project capability | Contingency: Consolidate to single file, defer to Phase 3+ |
| **Complexity creep** | BRAIN features add overhead without value | Phase gates enforce evidence-based expansion |
| **Agent coordination failures** | Deadlocks, race conditions | Self-healing, timeout detection, circuit breakers |

### 6.2 Medium-Risk Decisions

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Schema evolution** | Breaking changes to memory schemas | Versioning + migration functions |
| **Query performance** | Semantic search >3s response time | SQLite-vec optimization, caching, indexing |
| **Pattern extraction noise** | >50% false patterns | Frequency threshold (min 5 occurrences), HITL review |
| **Suggestion fatigue** | Users ignore proactive suggestions | Confidence threshold >80%, limit frequency |

### 6.3 Rollback Triggers

**Automatic Rollback** (no human intervention):

- Memory storage >50MB/year
- Query response >10s p95
- Context recall <80% accuracy
- Agent uptime <98%

**Manual Rollback** (HITL decision):

- Phase validation fails (any criterion unmet)
- User satisfaction <50% for any BRAIN dimension
- >3 critical bugs in production

---

## 7. References

### 7.1 Strategic Foundation

- **T2975**: EPIC: CLEO Consolidation Sprint
- **T2996**: Research: BRAIN Vision Alignment - Strategic Roadmap Review
- **T2973**: Specification: CLEO Strategic Roadmap
- **T2971**: Research: BRAIN Vision Requirements
- **T2968**: EPIC: CLEO Strategic Inflection Point Review

### 7.2 Specifications

- **docs/specs/PORTABLE-BRAIN-SPEC.md**: Canonical product contract and invariants
- **docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md**: Phase definitions and timeline
- **docs/specs/MCP-SERVER-SPECIFICATION.md**: MCP architecture (prepares for Agent enhancements)
- **docs/specs/CLEO-NEXUS-SPEC.md**: Network dimension architecture
- **docs/specs/PROJECT-LIFECYCLE-SPEC.md**: RCSD-IVTR lifecycle

### 7.3 Architecture

- **CLAUDE.md**: Core repository guidelines
- **.cleo/templates/CLEO-INJECTION.md**: Subagent architecture
- **docs/concepts/vision.mdx**: CLEO vision statement

---

## Appendix A: BRAIN vs Task Manager Comparison

| Capability | Task Manager (Tier S) | AGENTIC BRAIN (Tier M/L) |
|------------|----------------------|--------------------------|
| **Memory** | Single-session only | Persistent across sessions |
| **Reasoning** | Static dependencies | Causal inference + temporal analysis |
| **Agent** | Protocol enforcement | Self-healing + learning + coordination |
| **Intelligence** | Reactive validation | Adaptive + proactive + predictive |
| **Network** | Isolated projects | Cross-project intelligence + federated agents |
| **Learning** | None | Pattern extraction + knowledge transfer |
| **Prediction** | None | Quality prediction + timeline analysis |
| **Coordination** | Project-scoped | Multi-project federated |

---

## Appendix B: Data Flow Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ USER INTERACTION LAYER                                       │
│ - CLI commands (76 commands)                                 │
│ - MCP Server (cleo_query / cleo_mutate)                     │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ INTELLIGENCE LAYER (Validation + Adaptation)                 │
│ - 4-layer validation                                         │
│ - Adaptive validation (Phase 2)                              │
│ - Proactive suggestions (Phase 3)                            │
│ - Quality prediction (Phase 3)                               │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ AGENT LAYER (Orchestration)                                  │
│ - ct-orchestrator                                            │
│ - cleo-subagent                                              │
│ - Self-healing (Phase 1)                                     │
│ - Load balancing (Phase 2)                                   │
│ - Learning from execution (Phase 3)                          │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ REASONING LAYER (Inference)                                  │
│ - Causal inference (Phase 2)                                 │
│ - Similarity detection (Phase 2)                             │
│ - Impact prediction (Phase 2)                                │
│ - Timeline analysis (Phase 3)                                │
│ - Domain placement: DEFERRED (ADR-009 Section 2.5)          │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ BASE LAYER (Memory) — SQLite per ADR-006                     │
│ - Tasks + sessions (.cleo/cleo.db — tasks, sessions tables) │
│ - Decision memory (.cleo/cleo.db — brain_decisions table)   │
│ - Pattern memory (.cleo/cleo.db — brain_patterns table)     │
│ - Learning memory (.cleo/cleo.db — brain_learnings table)   │
│ - Research artifacts (MANIFEST.jsonl — append-only)          │
│ - JSONL export/import for portability (ADR-009)              │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ NETWORK LAYER (Cross-Project) — SQLite per ADR-006           │
│ - Global Registry (~/.cleo/cleo-nexus.db)                   │
│ - Global patterns (cleo-nexus.db — future table)            │
│ - Agent registry (federated, Phase 3)                        │
└─────────────────────────────────────────────────────────────┘
```

---

**Specification Status**: DRAFT
**Next Steps**: HITL review → Approval → Phase 1 implementation planning
**Approval Authority**: CLEO Development Team
**Review Cycle**: Quarterly (or after each phase gate)
