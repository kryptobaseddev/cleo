# analyze Command

Smart task triage and prioritization using leverage scoring, bottleneck detection, and domain grouping.

## Usage

```bash
cleo analyze [OPTIONS]
```

## Description

The `analyze` command provides intelligent task prioritization by calculating leverage scores, identifying bottlenecks, grouping tasks by domain, and recommending an optimal action order. It combines multiple analysis dimensions to help LLM agents and users make data-driven decisions about what to work on next.

**Default output is LLM-optimized JSON** designed for autonomous agent consumption. Use `--human` for human-readable text output.

This command is particularly useful for:
- **LLM agents**: Token-efficient structured JSON with all analysis data for autonomous task selection
- **Decision paralysis**: Data-driven task prioritization when multiple options exist
- **Project planning**: Understanding dependency chains and bottlenecks
- **Impact assessment**: Identifying which tasks unlock the most downstream work

## Algorithm

### 1. Hierarchy-Aware Leverage Score Calculation

Leverage measures downstream impact with hierarchy-aware weighting. Dependencies are weighted based on their relationship type:

| Relationship | Weight | Rationale |
|--------------|--------|-----------|
| Parent→Child | 0.3x | Same scope, less strategic impact |
| Same Epic | 1.0x | Standard true blockers |
| Cross-Phase | 1.5x | Phase alignment = higher strategic value |

```
weighted_unlocks = Σ(weight_for_each_blocked_task)
leverage_score = floor(weighted_unlocks * 15) + priority_score
```

**Components**:
- **Priority Score**: Task's intrinsic priority (critical=100, high=75, medium=50, low=25)
- **Weighted Unlocks**: Sum of dependency weights for all blocked tasks

**Examples**:
```
Task T312 (high priority) blocks 4 cross-phase tasks
weighted_unlocks = 4 * 1.5 = 6.0
Leverage Score = floor(6.0 * 15) + 75 = 90 + 75 = 165

Task T001 (epic) blocks 3 child tasks
weighted_unlocks = 3 * 0.3 = 0.9
Leverage Score = floor(0.9 * 15) + 75 = 13 + 75 = 88
```

**Configuration** (via config.json):
```json
{
  "analyze": {
    "hierarchyWeight": {
      "parentChild": 0.3,
      "crossEpic": 1.0,
      "crossPhase": 1.5
    }
  }
}
```

### 2. Actionable vs Blocked Detection

Tasks are classified as **actionable** if all their dependencies are satisfied (status=done).

```json
{
  "is_actionable": true,   // All deps completed
  "blocked_by": []         // Empty - no blockers
}
```

Blocked tasks have unsatisfied dependencies:
```json
{
  "is_actionable": false,
  "blocked_by": ["T312", "T204"]  // Waiting on these
}
```

### 3. Bottleneck Detection

Bottlenecks are tasks that block 2+ other tasks:

```bash
T312 blocks: T316, T317, T318... (11 total) -> CRITICAL BOTTLENECK
T204 blocks: T215, T216, T217... (7 total)  -> HIGH BOTTLENECK
```

### 4. Tier Assignment

Tasks are automatically grouped into action tiers based on leverage and actionability:

| Tier | Criteria | Action |
|------|----------|--------|
| **Tier 1: Unblock** | Actionable AND unlocks 3+ tasks | Start immediately |
| **Tier 2: Critical** | Actionable AND (critical OR high priority) | Prioritize next |
| **Tier 3: Blocked** | Has unsatisfied dependencies | Wait for blockers |
| **Tier 4: Routine** | Actionable AND (medium OR low priority) | Normal queue |

### 5. Domain Grouping

Tasks are dynamically grouped by their labels to identify thematic clusters:

```json
{
  "domains": [
    {"domain": "feature-phase", "count": 12, "actionable_count": 8},
    {"domain": "hierarchy", "count": 22, "actionable_count": 1},
    {"domain": "testing", "count": 10, "actionable_count": 3}
  ]
}
```

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--parent ID` | | Scope analysis to epic/task and all descendants | (project-wide) |
| `--human` | | Human-readable text output | (JSON) |
| `--full` | | Comprehensive human-readable report | (JSON) |
| `--auto-focus` | | Automatically set focus to top recommendation | `false` |
| `--help` | `-h` | Show help message | |

## Epic-Scoped Analysis (`--parent`)

The `--parent` flag enables epic-scoped analysis, providing detailed breakdown of an epic and all its children. This is particularly useful for:

- Understanding epic progress across phases
- Identifying ready vs blocked tasks within an epic
- Planning execution waves for parallel work
- Finding the critical path through the epic

### Usage

```bash
# JSON output (default for LLM agents)
cleo analyze --parent T998

# Human-readable output
cleo analyze --parent T998 --human
```

### Epic-Scoped Output Structure

```json
{
  "_meta": {
    "algorithm": "epic_scoped_analysis",
    "scope": {
      "type": "epic",
      "rootTaskId": "T998",
      "includesRoot": true
    }
  },
  "epic": {
    "id": "T998",
    "title": "EPIC: Feature Implementation",
    "progress": {
      "done": 8,
      "total": 30,
      "percent": 27,
      "byStatus": { "done": 8, "pending": 18, "active": 2, "blocked": 2 }
    }
  },
  "phases": [
    {
      "phase": "setup",
      "status": "complete",
      "progress": { "done": 4, "total": 4, "percent": 100 },
      "waves": [
        { "depth": 0, "tasks": ["T001"], "status": "complete" },
        { "depth": 1, "tasks": ["T002"], "status": "complete" }
      ]
    },
    {
      "phase": "core",
      "status": "in_progress",
      "progress": { "done": 4, "total": 16, "percent": 25 },
      "waves": [
        { "depth": 0, "tasks": ["T003", "T004"], "status": "partial" }
      ]
    }
  ],
  "inventory": {
    "completed": [...],
    "ready": [
      { "id": "T003", "title": "...", "unlocks": 3, "reason": "All dependencies satisfied" }
    ],
    "blocked": [
      { "id": "T005", "title": "...", "waitingOn": ["T003"], "chainDepth": 1 }
    ]
  },
  "executionPlan": {
    "criticalPath": {
      "path": [...],
      "length": 5,
      "entryTask": "T003"
    },
    "waves": [
      { "wave": 1, "parallel": ["T003", "T004"], "count": 2 }
    ],
    "recommendation": {
      "nextTask": "T003",
      "reason": "Unblocks 3 tasks",
      "command": "ct focus set T003"
    }
  },
  "summary": {
    "totalTasks": 30,
    "byStatus": { ... },
    "byPhase": { ... },
    "readyCount": 5,
    "blockedCount": 8,
    "criticalPathLength": 5
  }
}
```

### Human Output (`--human`)

```
═══════════════════════════════════════════════════════════════════
📊 EPIC ANALYSIS: T998
═══════════════════════════════════════════════════════════════════

EPIC: Session System Enhancement
Progress: 8/30 tasks (27%)

PHASES
───────────────────────────────────────────────────────────────────
  ✓ setup        4/4 (100%)
  → core         4/16 (25%)
  ○ testing      0/5 (0%)
  ○ polish       0/5 (0%)

READY TO START (5 tasks)
───────────────────────────────────────────────────────────────────
  T003 [high] Implement feature X (unlocks: 3)
  T004 [medium] Add documentation (unlocks: 1)

BLOCKED (8 tasks)
───────────────────────────────────────────────────────────────────
  T005 [high] Integration → waiting on: T003
  T006 [medium] Testing → waiting on: T005

EXECUTION PLAN
───────────────────────────────────────────────────────────────────
  Critical path length: 5 tasks

  Execution Waves:
    Wave 1: T003, T004 (2 parallel)
    Wave 2: T005 (1 parallel)

RECOMMENDATION
  → ct focus set T003
  Unblocks 3 tasks

═══════════════════════════════════════════════════════════════════
```

### Wave Computation

Waves represent the parallel execution order based on dependency depth:

- **Wave 0**: Tasks with no dependencies (entry points)
- **Wave N**: Tasks whose max dependency wave is N-1

Waves are computed within each phase, allowing you to understand the execution order even when tasks span multiple phases.

## Output Formats

### JSON Format (Default)

LLM-optimized structured data for autonomous agents:

```bash
cleo analyze
```

Output structure:
```json
{
  "_meta": {
    "version": "0.39.0",
    "timestamp": "2025-12-28T10:00:00Z",
    "algorithm": "hierarchy_aware_leverage",
    "weights": {
      "parentChild": 0.3,
      "crossEpic": 1.0,
      "crossPhase": 1.5
    }
  },
  "summary": {
    "total_pending": 47,
    "actionable": 15,
    "blocked": 32,
    "total_done": 206,
    "bottleneck_count": 9
  },
  "recommendation": {
    "task_id": "T312",
    "title": "DOCS: Create production readiness checklist",
    "priority": "high",
    "reason": "Highest leverage - unblocks 11 tasks",
    "unlocks": ["T316", "T317", "T318", "T319", "T320", "T321", "T322", "T323", "T324", "T325", "T326"],
    "command": "ct focus set T312"
  },
  "action_order": [
    {"id": "T312", "title": "...", "priority": "high", "reason": "Unblocks 11 tasks", "tier": 1},
    {"id": "T204", "title": "...", "priority": "high", "reason": "Unblocks 7 tasks", "tier": 1},
    {"id": "T290", "title": "...", "priority": "critical", "reason": "Unblocks 4 tasks", "tier": 1}
  ],
  "bottlenecks": [
    {
      "id": "T312",
      "title": "DOCS: Create production readiness checklist",
      "priority": "high",
      "blocks_count": 11,
      "blocked_tasks": ["T316", "T317", "T318", "..."],
      "is_actionable": true
    }
  ],
  "leverage": [
    {
      "id": "T312",
      "title": "...",
      "priority": "high",
      "unlocks_count": 11,
      "weighted_unlocks": 16.5,
      "unlocks_tasks": ["T316", "T317", "..."],
      "leverage_score": 322,
      "is_actionable": true
    }
  ],
  "tiers": {
    "tier1_unblock": {
      "description": "High leverage - unblock multiple tasks",
      "count": 4,
      "tasks": [...]
    },
    "tier2_critical": {
      "description": "Critical/high priority, actionable",
      "count": 9,
      "tasks": [...]
    },
    "tier3_blocked": {
      "description": "Blocked by incomplete dependencies",
      "count": 32,
      "tasks": [...]
    },
    "tier4_routine": {
      "description": "Medium/low priority, actionable",
      "count": 2,
      "tasks": [...]
    }
  },
  "domains": [
    {
      "domain": "feature-phase",
      "count": 12,
      "actionable_count": 8,
      "tasks": [...]
    }
  ]
}
```

### Human Format (`--human`)

Brief human-readable summary:

```bash
cleo analyze --human
```

Output:
```
TASK ANALYSIS (47 pending, 15 actionable, 32 blocked)
====================================================================

RECOMMENDATION
  -> ct focus set T312
  Highest leverage - unblocks 11 tasks
  Unblocks: T316, T317, T318, T319, T320, T321, T322, T323, T324, T325, T326

ACTION ORDER (suggested sequence)
  T312 [high] Unblocks 11 tasks
  T204 [high] Unblocks 7 tasks
  T290 [critical] Unblocks 4 tasks
  T328 [critical] Unblocks 4 tasks
  T288 [critical] High priority, actionable

BOTTLENECKS (tasks blocking others)
  T312 blocks 11 tasks: T316, T317, T318, T319, T320, T321, T322, T323, T324, T325, T326
  T339 blocks 9 tasks: T340, T341, T342, T343, T344, T345, T346, T347, T348
  T204 blocks 7 tasks: T215, T216, T217, T218, T219, T220, T221

TIERS
  Tier 1 (Unblock):  4 task(s)
  Tier 2 (Critical): 9 task(s)
  Tier 3 (Blocked):  32 task(s)
  Tier 4 (Routine):  2 task(s)

DOMAINS (by label)
  hierarchy: 1/22 actionable
  feature-phase: 8/12 actionable
  testing: 3/10 actionable
```

### Full Format (`--full`)

Comprehensive human-readable report with detailed tier breakdowns:

```bash
cleo analyze --full
```

Includes everything from `--human` plus:
- Detailed task lists for each tier
- Which tasks each bottleneck unblocks
- Which dependencies are blocking each blocked task
- Full domain breakdown with task IDs

## Use Cases

### 1. Autonomous Agent Task Selection

```bash
# LLM agent gets full analysis, selects optimal task
analysis=$(cleo analyze)
task_id=$(echo "$analysis" | jq -r '.recommendation.task_id')
cleo focus set "$task_id"
```

### 2. Autonomous Mode with Auto-Focus

```bash
# Analyze and automatically set focus to top recommendation
cleo analyze --auto-focus
```

### 3. Human Planning Session

```bash
# Get readable overview for sprint planning
cleo analyze --human

# Get detailed breakdown for deeper analysis
cleo analyze --full
```

### 4. CI/CD Health Check

```bash
# Check for bottleneck health in pipeline
analysis=$(cleo analyze)
bottleneck_count=$(echo "$analysis" | jq '.summary.bottleneck_count')
blocked_ratio=$(echo "$analysis" | jq '.summary.blocked / .summary.total_pending')

if (( $(echo "$blocked_ratio > 0.8" | bc -l) )); then
  echo "WARNING: 80%+ tasks blocked - resolve bottlenecks"
fi
```

### 5. Extract Top Action Order

```bash
# Get just the action order for quick decisions
cleo analyze | jq -r '.action_order[0:5][] | "\(.id) - \(.reason)"'
```

## Understanding the Output

### Leverage Score

Higher leverage = higher impact. Work on high-leverage tasks first:

| Score Range | Impact | Action |
|-------------|--------|--------|
| **200+** | Critical | Immediate attention |
| **100-199** | High | Next in queue |
| **50-99** | Medium | Standard priority |
| **<50** | Low | Background/defer |

### Actionable vs Blocked

- **Actionable tasks**: Ready to work on (all dependencies satisfied)
- **Blocked tasks**: Waiting on other tasks (shown in Tier 3)

Only Tier 1 and Tier 2 contain actionable tasks. Tier 3 explicitly shows what's blocking each task.

### Domain Insights

Domains are grouped by labels. Use this to:
- Identify which feature areas have work available
- See bottleneck concentration by domain
- Plan sprints around domain themes

## Comparison with Other Commands

| Command | Purpose | Use When |
|---------|---------|----------|
| **analyze** | Full triage with leverage, tiers, domains | Need strategic prioritization |
| **next** | Simple next-task suggestion | Quick "what should I do?" |
| **blockers** | Show blocked tasks and chains | Focus on unblocking |
| **deps** | Visualize dependency tree | Understand task relationships |
| **dash** | Project overview | High-level status check |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (file not found, jq missing) |
| `2` | No pending tasks to analyze |

## Version History

- **v0.42.0**: Epic-scoped analysis with `--parent` flag - phase grouping, wave computation, inventory, execution plan, human ASCII output
- **v0.39.0**: Hierarchy-aware leverage scoring with configurable weights (parentChild, crossEpic, crossPhase)
- **v0.16.0**: Major rewrite - JSON default, --human flag, domain grouping, action order, improved tier logic
- **v0.15.0**: Initial implementation with leverage scoring, bottleneck detection, tier system
