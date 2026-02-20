# Enhanced CLI Commands Research

**Research Date:** 2025-12-12
**Purpose:** Analyze command structures for 7 proposed enhancement features
**Context:** claude-todo v0.4.0 command routing and naming conventions

---

## Current CLI Architecture Analysis

### Existing Command Pattern

**Current router structure:**
```bash
# Main router: scripts/claude-todo (not yet implemented - uses direct script execution)
# Pattern: claude-todo <command> [OPTIONS] [ARGS]
# Examples:
#   claude-todo list --status pending
#   claude-todo add "Task title"
#   claude-todo focus set T001
#   claude-todo session start
```

**Command categories:**
1. **Task Operations:** add, update, complete, list
2. **State Management:** focus, session, archive
3. **Analysis:** stats, validate, export
4. **Utilities:** init, backup, restore, migrate, log

**Subcommand Pattern (established):**
- `focus {set|clear|show|note|next}`
- `session {start|end|status}`
- Future: Similar multi-operation commands use subcommand pattern

---

## Proposed Commands Research

### 1. Phase Summary Command

**Command Name:** `phases` or `phase`
**Alias:** None recommended
**Pattern:** Multi-operation subcommand

#### Command Structure Options

**Option A: Subcommand style (RECOMMENDED)**
```bash
claude-todo phases list                    # List all phases with task counts
claude-todo phases show <phase-slug>       # Show tasks in specific phase
claude-todo phases stats                   # Phase completion statistics
claude-todo phases [--format json|text]    # Default: list all phases
```

**Option B: Flat style with flags**
```bash
claude-todo phases                         # List all phases (default)
claude-todo phases --phase core            # Show specific phase
claude-todo phases --stats                 # Statistics mode
```

**Option C: Unified with list**
```bash
claude-todo list --phase core              # ALREADY IMPLEMENTED
claude-todo list --group-by phase          # New flag for list command
```

#### Recommended Approach: **Option A**
- Consistent with `focus` and `session` patterns
- Dedicated analysis of phase workflow
- Room for future phase operations (add phase, reorder phases)

#### Implementation Considerations

**Data Sources:**
- Read `phases` object from `todo.json` schema
- Aggregate task counts by `task.phase` field
- Calculate completion rates per phase

**Output Format (text):**
```
╭─────────────────────────────────────────╮
│  📊 PROJECT PHASES                      │
├─────────────────────────────────────────┤
│  1. setup (Planning)                    │
│     ○ 2 pending   ◉ 1 active   ✓ 5 done│
│     Progress: ████████░░ 75%            │
│                                         │
│  2. core (Core Development)             │
│     ○ 8 pending   ◉ 1 active   ✓ 3 done│
│     Progress: ███░░░░░░░ 33%            │
│                                         │
│  3. testing (Testing & QA)              │
│     ○ 4 pending   ◉ 0 active   ✓ 0 done│
│     Progress: ░░░░░░░░░░ 0%             │
╰─────────────────────────────────────────╯
```

**Output Format (json):**
```json
{
  "phases": [
    {
      "slug": "setup",
      "name": "Planning",
      "order": 1,
      "tasks": {
        "pending": 2,
        "active": 1,
        "blocked": 0,
        "done": 5,
        "total": 8
      },
      "progress": 0.75,
      "taskIds": ["T001", "T002", "T003", "..."]
    }
  ],
  "totalPhases": 3,
  "overallProgress": 0.42
}
```

**Subcommand Details:**

```bash
# phases list (default)
claude-todo phases list [--format text|json|markdown]
# Shows all phases with counts, progress bars, current phase indicator

# phases show <slug>
claude-todo phases show core [--format text|json]
# Lists all tasks in specified phase (equivalent to list --phase core but prettier)

# phases stats
claude-todo phases stats [--format text|json]
# Completion metrics per phase, average time per phase, bottleneck detection
```

---

### 2. Dependency Tree Command

**Command Name:** `deps` or `tree` or `depend`
**Alias:** `tree` → `deps`
**Pattern:** Analysis command with visualization

#### Command Structure Options

**Option A: deps with subcommands (RECOMMENDED)**
```bash
claude-todo deps                           # Show full dependency tree
claude-todo deps show <task-id>            # Show dependencies for specific task
claude-todo deps check                     # Validate all dependencies
claude-todo deps blocked                   # Show tasks blocked by dependencies
```

**Option B: tree as primary command**
```bash
claude-todo tree                           # Visual tree of all dependencies
claude-todo tree <task-id>                 # Tree from specific task
claude-todo tree --blocked-only            # Only blocked relationships
```

**Option C: Integrated with list**
```bash
claude-todo list --tree                    # Show with dependency indicators
claude-todo list --depends <task-id>       # Tasks depending on this one
```

#### Recommended Approach: **Option A (deps)**
- Clear semantic meaning (dependencies)
- `tree` as alias for convenience
- Dedicated dependency analysis
- Aligns with graph/network terminology

#### Implementation Considerations

**Data Sources:**
- Parse `task.depends` arrays from all tasks
- Build directed acyclic graph (DAG)
- Detect circular dependencies (should not exist due to validation)

**Output Format (text - ASCII tree):**
```
🌳 Dependency Tree

T001 Implement authentication
├─┬ T002 Add JWT middleware (active)
│ └── T003 Write auth tests (pending)
└─┬ T004 Add login endpoint (pending)
  └── T005 Add logout endpoint (pending)

T010 Deploy to production (blocked)
└── T002 Add JWT middleware (active) ← blocking

Legend:
  ├── Direct dependency
  └── Terminal dependency
  (status) Current task status
  ← blocking: This task blocks others
```

**Output Format (JSON):**
```json
{
  "dependencyGraph": {
    "T001": {
      "title": "Implement authentication",
      "status": "done",
      "dependents": ["T002", "T004"],
      "blocksCount": 2,
      "depth": 0
    },
    "T002": {
      "title": "Add JWT middleware",
      "status": "active",
      "depends": ["T001"],
      "dependents": ["T003", "T010"],
      "blocksCount": 2,
      "depth": 1
    }
  },
  "rootTasks": ["T001"],
  "blockedTasks": ["T010"],
  "criticalPath": ["T001", "T002", "T010"],
  "circularDependencies": []
}
```

**Subcommand Details:**

```bash
# deps (default - full tree)
claude-todo deps [--format text|json|dot|mermaid]
# Visualize entire dependency graph

# deps show <task-id>
claude-todo deps show T002
# Show this task's dependencies (what it depends on)
# Show this task's dependents (what depends on it)
# Show if blocking any tasks

# deps check
claude-todo deps check
# Validate all dependencies exist
# Check for circular dependencies (should never happen)
# Detect orphaned dependencies (references to archived/deleted tasks)

# deps blocked
claude-todo deps blocked
# List all tasks blocked by incomplete dependencies
# Show which dependency is causing the block
```

**Export Formats:**

```bash
# DOT format for Graphviz
claude-todo deps --format dot > deps.dot
dot -Tpng deps.dot -o deps.png

# Mermaid format for documentation
claude-todo deps --format mermaid > deps.mmd
# Can be embedded in markdown
```

---

### 3. Labels Overview Command

**Command Name:** `labels` or `tags`
**Alias:** `tags` → `labels`
**Pattern:** Analysis command

#### Command Structure Options

**Option A: labels as primary (RECOMMENDED)**
```bash
claude-todo labels                         # List all labels with counts
claude-todo labels show <label>            # Tasks with specific label
claude-todo labels stats                   # Label usage statistics
```

**Option B: Integrated with list**
```bash
claude-todo list --labels                  # Show label distribution
claude-todo list --label <label>           # ALREADY IMPLEMENTED
```

**Option C: labels with management**
```bash
claude-todo labels list                    # List all
claude-todo labels rename <old> <new>      # Rename label across all tasks
claude-todo labels merge <label1> <label2> # Merge two labels
```

#### Recommended Approach: **Option A**
- Dedicated label analysis
- Extensible for future label management
- Consistent with existing command patterns

#### Implementation Considerations

**Data Sources:**
- Read `labels` index from `todo.json` (pre-computed)
- Aggregate counts by status/priority per label
- Calculate label co-occurrence (which labels appear together)

**Output Format (text):**
```
╭─────────────────────────────────────────╮
│  🏷️  LABELS                              │
├─────────────────────────────────────────┤
│  backend (12 tasks)                     │
│    ○ 5 pending   ◉ 2 active   ✓ 5 done │
│                                         │
│  frontend (8 tasks)                     │
│    ○ 4 pending   ◉ 1 active   ✓ 3 done │
│                                         │
│  security (5 tasks)                     │
│    ○ 2 pending   ◉ 1 active   ✓ 2 done │
│                                         │
│  docs (3 tasks)                         │
│    ○ 2 pending   ◉ 0 active   ✓ 1 done │
╰─────────────────────────────────────────╯

Co-occurring labels:
  backend + security (4 tasks)
  frontend + ui (6 tasks)
```

**Output Format (JSON):**
```json
{
  "labels": {
    "backend": {
      "count": 12,
      "taskIds": ["T001", "T002", "..."],
      "status": {
        "pending": 5,
        "active": 2,
        "blocked": 0,
        "done": 5
      },
      "priority": {
        "critical": 1,
        "high": 4,
        "medium": 5,
        "low": 2
      }
    }
  },
  "cooccurrence": [
    {"labels": ["backend", "security"], "count": 4},
    {"labels": ["frontend", "ui"], "count": 6}
  ],
  "totalLabels": 4,
  "totalTasks": 20,
  "avgLabelsPerTask": 1.5
}
```

**Subcommand Details:**

```bash
# labels (default - list all)
claude-todo labels [--format text|json|csv]
# List all labels with counts, status distribution

# labels show <label>
claude-todo labels show backend
# List all tasks with this label (prettier than list --label)

# labels stats
claude-todo labels stats
# Label usage patterns, trends, co-occurrence matrix
```

---

### 4. Dashboard/Overview Command

**Command Name:** `dash` or `overview` or `status`
**Alias:** `dash` ↔ `overview`
**Pattern:** Comprehensive status display

#### Command Structure Options

**Option A: dash as primary (RECOMMENDED)**
```bash
claude-todo dash                           # Full dashboard
claude-todo dash --compact                 # Condensed view
claude-todo dash --sections current,blocked # Specific sections only
```

**Option B: overview as primary**
```bash
claude-todo overview                       # Same as dash
claude-todo overview --minimal             # Essential info only
```

**Option C: status (conflict with task status)**
```bash
claude-todo status                         # Conflicts with potential task status command
```

#### Recommended Approach: **Option A (dash with overview alias)**
- Short, memorable command
- Common in CLI tools (k9s, lazygit use "dash" concept)
- `overview` as semantic alias

#### Implementation Considerations

**Data Sources:**
- Aggregate data from `todo.json`, `archive.json`, `log.json`
- Calculate real-time statistics
- Show session state from `focus` object

**Output Format (text - full dashboard):**
```
╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮
│  📊 PROJECT DASHBOARD                      │
│  my-project                                │
│  Last updated: 2025-12-12 14:30:00        │
├────────────────────────────────────────────┤
│  🎯 CURRENT FOCUS                         │
│  T002: Add JWT middleware (active)        │
│  Next: Write unit tests for auth module   │
├────────────────────────────────────────────┤
│  📋 TASK OVERVIEW                         │
│  ○ 8 pending   ◉ 1 active                │
│  ⊗ 1 blocked   ✓ 12 done                 │
│  Total: 22 tasks                          │
├────────────────────────────────────────────┤
│  🔴 HIGH PRIORITY (5 tasks)               │
│  T003 Write auth tests                    │
│  T010 Deploy to production (blocked)      │
│  T015 Security audit                      │
├────────────────────────────────────────────┤
│  ⊗ BLOCKED TASKS (1)                      │
│  T010 Deploy → blocked by T002            │
├────────────────────────────────────────────┤
│  📊 PHASES                                │
│  ▸ setup      ████████░░ 75% (6/8)       │
│  ▸ core       ███░░░░░░░ 33% (4/12)      │
│  ▸ testing    ░░░░░░░░░░  0% (0/4)       │
├────────────────────────────────────────────┤
│  🏷️  TOP LABELS                           │
│  backend (12)  frontend (8)  security (5) │
├────────────────────────────────────────────┤
│  📈 RECENT ACTIVITY (7 days)              │
│  Created: 8   Completed: 5   Rate: 62%   │
│  Avg completion: 2.3 days                 │
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯
```

**Compact mode:**
```
📊 my-project | ○8 ◉1 ⊗1 ✓12 | Focus: T002 | High: 5 | Blocked: 1
```

**JSON output:**
```json
{
  "project": "my-project",
  "lastUpdated": "2025-12-12T14:30:00Z",
  "focus": {
    "taskId": "T002",
    "title": "Add JWT middleware",
    "status": "active",
    "nextAction": "Write unit tests for auth module"
  },
  "summary": {
    "pending": 8,
    "active": 1,
    "blocked": 1,
    "done": 12,
    "total": 22
  },
  "highPriority": {
    "count": 5,
    "tasks": ["T003", "T010", "T015"]
  },
  "blockedTasks": [
    {
      "taskId": "T010",
      "blockedBy": ["T002"],
      "reason": "Waiting for JWT middleware"
    }
  ],
  "phases": [
    {"slug": "setup", "progress": 0.75, "completed": 6, "total": 8}
  ],
  "topLabels": [
    {"label": "backend", "count": 12},
    {"label": "frontend", "count": 8}
  ],
  "recentActivity": {
    "days": 7,
    "created": 8,
    "completed": 5,
    "completionRate": 0.62,
    "avgCompletionDays": 2.3
  }
}
```

**Sections (customizable):**
```bash
# Show specific sections only
claude-todo dash --sections focus,blocked,priority

Available sections:
  - focus: Current focus task
  - summary: Task counts by status
  - priority: High priority tasks
  - blocked: Blocked tasks
  - phases: Phase progress
  - labels: Top labels
  - activity: Recent activity metrics
  - all: Everything (default)
```

---

### 5. Plan Command (Project Planning View)

**Command Name:** `plan` or `roadmap` or `planner`
**Alias:** None
**Pattern:** Strategic view command

#### Command Structure Options

**Option A: plan as primary (RECOMMENDED)**
```bash
claude-todo plan                           # Full project plan
claude-todo plan --phase core              # Plan for specific phase
claude-todo plan --horizon 7               # Next 7 days
```

**Option B: roadmap (more feature-oriented)**
```bash
claude-todo roadmap                        # Project roadmap view
claude-todo roadmap --timeline             # Timeline visualization
```

**Option C: Extended list command**
```bash
claude-todo list --plan                    # Planning mode
claude-todo list --roadmap                 # Roadmap view
```

#### Recommended Approach: **Option A (plan)**
- Clear semantic purpose
- Distinct from `list` (operational) vs `plan` (strategic)
- Room for planning-specific features

#### Implementation Considerations

**Data Sources:**
- Tasks organized by phase order
- Dependency chains (from `deps` analysis)
- Time estimates (if added later - currently not supported)
- Priority and status information

**Output Format (text):**
```
╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮
│  🗺️  PROJECT PLAN                         │
│  my-project                                │
├────────────────────────────────────────────┤
│  Phase 1: setup (Planning)                │
│  ████████░░ 75% complete                  │
│                                           │
│  ✓ T001 Design API schema                │
│  ✓ T002 Create database models           │
│  ○ T003 Write API docs                   │
│  ○ T004 Setup test framework             │
├────────────────────────────────────────────┤
│  Phase 2: core (Core Development)         │
│  ███░░░░░░░ 33% complete                  │
│                                           │
│  ✓ T005 Implement auth endpoints         │
│  ◉ T006 Add JWT middleware (IN PROGRESS) │
│  ○ T007 Write auth tests (blocked)       │
│     └─ Depends on: T006                  │
│  ○ T008 Add user endpoints               │
│  ○ T009 Add validation                   │
├────────────────────────────────────────────┤
│  Phase 3: testing (Testing & QA)          │
│  ░░░░░░░░░░ 0% complete                   │
│                                           │
│  ○ T010 Integration tests                │
│  ○ T011 Load testing                     │
│  ○ T012 Security audit                   │
├────────────────────────────────────────────┤
│  Critical Path: T006 → T007 → T010       │
│  Next milestone: Complete core phase      │
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯
```

**Horizon view (next N days):**
```bash
claude-todo plan --horizon 7

Next 7 days:
─────────────
TODAY (2025-12-12)
  ◉ T006 Add JWT middleware (continue)

TOMORROW (2025-12-13)
  ○ T007 Write auth tests (if T006 done)

LATER THIS WEEK
  ○ T008 Add user endpoints
  ○ T009 Add validation

Blocked (cannot start yet):
  ⊗ T010 Integration tests (blocked by T006)
```

**JSON output:**
```json
{
  "plan": {
    "phases": [
      {
        "slug": "setup",
        "name": "Planning",
        "order": 1,
        "progress": 0.75,
        "tasks": [
          {
            "id": "T001",
            "title": "Design API schema",
            "status": "done",
            "priority": "high"
          }
        ]
      }
    ],
    "criticalPath": ["T006", "T007", "T010"],
    "nextMilestone": "Complete core phase",
    "horizon": {
      "days": 7,
      "today": ["T006"],
      "tomorrow": ["T007"],
      "later": ["T008", "T009"],
      "blocked": ["T010"]
    }
  }
}
```

---

### 6. Next Action Command

**Command Name:** `next` or `whats-next` or `suggest`
**Alias:** None
**Pattern:** Intelligent recommendation

#### Command Structure Options

**Option A: next as primary (RECOMMENDED)**
```bash
claude-todo next                           # Suggest next task to work on
claude-todo next --explain                 # Explain why this task
claude-todo next --limit 3                 # Top 3 suggestions
```

**Option B: Integrated with focus**
```bash
claude-todo focus suggest                  # Suggest next focus
claude-todo focus next                     # Auto-set next suggested task
```

**Option C: ai or suggest**
```bash
claude-todo suggest                        # Task suggestion
claude-todo ai next                        # AI-powered suggestion
```

#### Recommended Approach: **Option A (next)**
- Simple, clear command
- Aligns with agile/GTD "next action" concept
- Distinct from `focus` (setting) vs `next` (recommending)

#### Implementation Considerations

**Suggestion Algorithm:**
1. Exclude active tasks (already working on one)
2. Exclude blocked tasks
3. Check dependencies (only suggest tasks with satisfied dependencies)
4. Rank by priority (critical > high > medium > low)
5. Consider phase order (earlier phases higher priority)
6. Break ties by creation date (oldest first)

**Data Sources:**
- Current focus from `focus.currentTask`
- Dependency graph
- Priority and phase information
- Recent activity patterns (from log)

**Output Format (text):**
```
🎯 Suggested Next Task

T008: Add user endpoints
  Priority: high
  Phase: core
  Why: All dependencies completed, high priority
  Estimated: Ready to start immediately

Alternative options:
  2. T009 Add validation (medium priority)
  3. T003 Write API docs (low priority, earlier phase)

To start working:
  claude-todo focus set T008
```

**With explanation:**
```bash
claude-todo next --explain

🎯 Why T008 is suggested:

✓ No dependencies blocking
✓ High priority (urgent)
✓ Part of current phase (core)
✓ No active task currently
✓ Related to recent work (auth module)

Decision factors:
  1. Priority score: 90/100
  2. Dependency readiness: 100% (all done)
  3. Phase alignment: current phase
  4. Context relevance: 80% (similar to T006)

Skip this task:
  claude-todo update T008 --status blocked --blocked-by "Not ready yet"
```

**JSON output:**
```json
{
  "suggestion": {
    "taskId": "T008",
    "title": "Add user endpoints",
    "priority": "high",
    "phase": "core",
    "score": 90,
    "reasoning": {
      "dependenciesReady": true,
      "highPriority": true,
      "currentPhase": true,
      "noActiveTask": true,
      "contextRelevant": 0.8
    },
    "readyToStart": true,
    "blockers": []
  },
  "alternatives": [
    {
      "taskId": "T009",
      "title": "Add validation",
      "score": 70
    }
  ],
  "command": "claude-todo focus set T008"
}
```

---

### 7. Blocker Analysis Command

**Command Name:** `blockers` or `blocked` or `analyze-blockers`
**Alias:** `blocked` → `blockers`
**Pattern:** Analysis and reporting

#### Command Structure Options

**Option A: blockers as primary (RECOMMENDED)**
```bash
claude-todo blockers                       # List all blockers
claude-todo blockers analyze               # Deep analysis of blocking patterns
claude-todo blockers impact                # Show impact of each blocker
```

**Option B: Integrated with list**
```bash
claude-todo list --blocked                 # Show only blocked tasks
claude-todo list --blockers                # Show blocker relationships
```

**Option C: Extended deps command**
```bash
claude-todo deps blocked                   # Already proposed for deps command
claude-todo deps analyze-blockers          # Blocker-specific analysis
```

#### Recommended Approach: **Option A (blockers as dedicated command)**
- Specialized analysis tool
- Distinct from dependency tree (structural) vs blockers (problem-focused)
- Extensible for blocker resolution workflows

#### Implementation Considerations

**Data Sources:**
- Tasks with `status: "blocked"` and `blockedBy` field
- Dependency chains (`task.depends`)
- Log history (how long blocked)
- Priority levels of blocked tasks

**Blocker Types:**
1. **Dependency blockers:** Waiting on another task
2. **External blockers:** Resource, approval, etc. (text in `blockedBy`)
3. **Implicit blockers:** High-priority dependency incomplete

**Output Format (text):**
```
╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮
│  ⊗ BLOCKER ANALYSIS                       │
├────────────────────────────────────────────┤
│  🚨 CRITICAL BLOCKERS (1)                 │
│                                           │
│  T002 Add JWT middleware                  │
│    Blocking: 2 tasks                      │
│    • T007 Write auth tests (high)        │
│    • T010 Integration tests (critical)   │
│    Impact: 2 high-priority tasks stalled │
│    Blocked for: 3 days                   │
│    Action: Complete T002 immediately     │
├────────────────────────────────────────────┤
│  ⚠️  EXTERNAL BLOCKERS (1)                │
│                                           │
│  T015 Security audit                      │
│    Blocked by: "Waiting for security review" │
│    Blocked for: 7 days                   │
│    Action: Follow up with security team  │
├────────────────────────────────────────────┤
│  📊 BLOCKER STATISTICS                    │
│                                           │
│  Total blocked tasks: 3                   │
│  Avg blocked duration: 5 days             │
│  High-priority blocked: 2                 │
│  Critical path blocked: Yes (T010)       │
│                                           │
│  Top blocker: T002 (blocking 2 tasks)    │
│  Longest blocked: T015 (7 days)          │
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯

Recommendations:
  1. Prioritize T002 completion (unblocks 2 tasks)
  2. Follow up on T015 external blocker
  3. Consider breaking T010 into smaller tasks
```

**Impact analysis:**
```bash
claude-todo blockers impact

Blocker Impact Analysis:

T002 (Add JWT middleware)
  Direct impact: 2 tasks blocked
  Cascading impact: 4 tasks (including dependencies)
  Priority impact: 1 critical + 1 high priority
  Phase impact: Blocking core phase completion
  Risk: High (on critical path)

T015 (Security audit - external)
  Direct impact: 1 task blocked
  Cascading impact: 1 task
  Priority impact: 1 medium priority
  Risk: Medium (growing stale at 7 days)
```

**JSON output:**
```json
{
  "blockerAnalysis": {
    "summary": {
      "totalBlocked": 3,
      "avgBlockedDays": 5,
      "highPriorityBlocked": 2,
      "criticalPathBlocked": true
    },
    "blockers": [
      {
        "blockerId": "T002",
        "blockerTitle": "Add JWT middleware",
        "blockerStatus": "active",
        "blockedTasks": [
          {
            "taskId": "T007",
            "priority": "high",
            "blockedFor": "3 days"
          },
          {
            "taskId": "T010",
            "priority": "critical",
            "blockedFor": "3 days"
          }
        ],
        "directImpact": 2,
        "cascadingImpact": 4,
        "riskLevel": "high"
      }
    ],
    "externalBlockers": [
      {
        "taskId": "T015",
        "blockedBy": "Waiting for security review",
        "blockedFor": "7 days",
        "priority": "medium",
        "riskLevel": "medium"
      }
    ],
    "recommendations": [
      "Prioritize T002 completion (unblocks 2 tasks)",
      "Follow up on T015 external blocker"
    ]
  }
}
```

**Subcommand Details:**

```bash
# blockers (default - list view)
claude-todo blockers [--format text|json]
# Show all blockers with impact summary

# blockers analyze
claude-todo blockers analyze
# Deep analysis: blocker duration, cascading effects, risk assessment

# blockers impact [task-id]
claude-todo blockers impact T002
# Show what would be unblocked if this task completes
# Useful for prioritization decisions

# blockers resolve <task-id>
# Future: Interactive blocker resolution wizard
```

---

## Command Naming Conventions Summary

### Recommended Primary Commands

| Feature | Primary Command | Alias | Pattern |
|---------|----------------|-------|---------|
| Phase summary | `phases` | - | Subcommand |
| Dependency tree | `deps` | `tree` | Subcommand |
| Labels overview | `labels` | `tags` | Analysis |
| Dashboard | `dash` | `overview` | Display |
| Project plan | `plan` | - | Strategic |
| Next action | `next` | - | Recommendation |
| Blocker analysis | `blockers` | `blocked` | Analysis |

### Command Categories

**Analysis Commands** (read-only, information display)
- `stats` (existing)
- `phases` (new)
- `deps` (new)
- `labels` (new)
- `dash` (new)
- `blockers` (new)

**Planning Commands** (strategic view)
- `plan` (new)
- `next` (new)

**Operation Commands** (state-changing)
- `add`, `update`, `complete` (existing)
- `focus` (existing)
- `session` (existing)

---

## Integration with Existing Commands

### Avoid Duplication

**list command:**
- Keep focused on task listing with filters
- Don't overload with analysis features
- Use dedicated commands for complex views

**stats command:**
- Numeric metrics and trends
- Different from visual dashboard (dash)
- Different from specific analyses (phases, labels, blockers)

**focus command:**
- Task selection and session context
- Not for suggestions (use `next` for that)

### Complementary Usage Patterns

```bash
# Morning workflow
claude-todo dash                    # See overall status
claude-todo next                    # Get suggestion
claude-todo focus set T008          # Start working

# Planning session
claude-todo plan                    # Review project roadmap
claude-todo phases                  # Check phase progress
claude-todo blockers                # Identify bottlenecks

# Dependency work
claude-todo deps                    # View full tree
claude-todo deps show T010          # Specific task dependencies
claude-todo blockers                # See what's blocking progress

# Organization review
claude-todo labels                  # Label distribution
claude-todo phases stats            # Phase completion metrics
claude-todo stats --period 30       # Overall statistics
```

---

## Implementation Priority Recommendations

### Phase 1 (High Value, Lower Complexity)
1. **`dash`** - Immediate value, aggregates existing data
2. **`next`** - Simple algorithm, high utility for daily use
3. **`labels`** - Uses existing labels index

### Phase 2 (Medium Complexity)
4. **`phases`** - Requires phase data structure (already in schema)
5. **`blockers`** - Analysis of existing blocker data

### Phase 3 (Higher Complexity)
6. **`deps`** - Graph algorithms, visualization formats
7. **`plan`** - Strategic view, multiple data sources

---

## Output Format Consistency

### Standard Formats for All Commands

**Text output:**
- Box drawing characters for sections (╭─╮│╰╯)
- Color coding (RED=critical, YELLOW=high, CYAN=medium, DIM=low)
- Icons for status (○ pending, ◉ active, ⊗ blocked, ✓ done)
- Progress bars (████░░░░░░)

**JSON output:**
- Always available via `--format json`
- Structured for programmatic consumption
- Includes metadata (generated_at, version)

**Markdown output:**
- For documentation and reporting
- GitHub-flavored markdown
- Task checklists where appropriate

### Common Options Across All Commands

```bash
--format text|json|markdown     # Output format
--help, -h                      # Show help
--verbose, -v                   # Detailed output
--quiet, -q                     # Minimal output
```

---

## Potential Conflicts and Resolutions

### Command Name Collisions

**`status`** - Avoid as primary command
- Conflicts with potential future `task status` subcommand
- Use `dash` or `overview` instead

**`tree`** - Use as alias only
- Could conflict with Unix `tree` command
- Primary command `deps` is clearer

**`blocked`** - Use as alias for `blockers`
- Past tense (blocked) less clear than plural noun (blockers)

### Subcommand Consistency

**list vs show:**
- `list` = show multiple items (phases list, labels list)
- `show` = show single item detail (phases show core, deps show T001)

**stats vs analyze:**
- `stats` = numeric metrics
- `analyze` = deeper investigation with recommendations

---

## Future Extensions

### Commands Not Yet Proposed

**`timeline`** - Chronological task view
```bash
claude-todo timeline --days 30
```

**`burndown`** - Progress over time
```bash
claude-todo burndown --period 14
```

**`search`** - Full-text search
```bash
claude-todo search "authentication"
```

**`report`** - Custom reports
```bash
claude-todo report --template weekly-standup
```

**`clean`** - Maintenance operations
```bash
claude-todo clean --stale-labels --orphaned-deps
```

---

## References and Inspiration

### CLI Tools with Similar Patterns

**Git:**
- Subcommand structure (`git branch list`, `git remote show`)
- Analysis commands (`git blame`, `git log --graph`)

**GitHub CLI (gh):**
- Resource-based commands (`gh issue list`, `gh pr view`)
- Dashboard concept (`gh dash`)

**Taskwarrior:**
- Task management commands
- Report generation (`task summary`, `task burndown`)

**Jira CLI:**
- Blocker analysis
- Sprint planning views

**k9s (Kubernetes):**
- Dashboard interface
- Context switching

---

## Conclusion

This research proposes 7 new commands with consistent naming patterns:

1. **phases** - Subcommand structure, phase-based analysis
2. **deps** - Graph visualization, dependency management
3. **labels** - Tag-based organization and metrics
4. **dash** - Comprehensive dashboard view
5. **plan** - Strategic roadmap visualization
6. **next** - Intelligent task suggestion
7. **blockers** - Blocker identification and impact analysis

All follow established patterns:
- Subcommands for multi-operation features
- JSON/text/markdown output formats
- Consistent help and usage messages
- Integration with existing commands without duplication

Implementation can be phased based on value vs complexity trade-offs.
