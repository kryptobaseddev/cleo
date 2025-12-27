# phases Command

Manage and visualize workflow phases with progress tracking, task counts, and completion metrics.

## Usage

```bash
cleo phases [SUBCOMMAND] [OPTIONS]
```

## Description

The `phases` command provides comprehensive phase management for your workflow. Phases represent distinct stages of your project lifecycle (e.g., setup, core development, polish) and help organize tasks into logical workflow stages.

This command is particularly useful for:
- Tracking progress across different project stages
- Understanding which phases need attention
- Visualizing workflow completion with progress bars
- Organizing tasks by development lifecycle
- Identifying bottlenecks in specific project phases

## Subcommands

| Subcommand | Description |
|------------|-------------|
| (none) | List all phases with progress bars (default) |
| `list` | Same as default - list all phases with progress |
| `show PHASE` | Display all tasks in a specific phase |
| `stats` | Show detailed phase statistics with priority breakdown |

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--format FORMAT` | `-f` | Output format: `text` or `json` | `text` |
| `--help` | `-h` | Show help message | |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (validation failed, phase not found, file operation error) |

## Examples

### List All Phases

```bash
# Show all phases with progress bars and completion percentage
cleo phases
```

Output:
```
PHASES
────────────────────────────────────────────────────────────
PHASE        NAME                   DONE  TOTAL     %  PROGRESS              STATUS
────────────────────────────────────────────────────────────
setup        Setup                     5      5   100%  ████████████████████  Completed
core         Core Development          4     10    40%  ████████░░░░░░░░░░░░  In Progress
polish       Polish & Testing          0      4     0%  ░░░░░░░░░░░░░░░░░░░░  Pending
────────────────────────────────────────────────────────────
Overall Progress: 9/19 tasks (47%)
```

### Show Tasks in Specific Phase

```bash
# List all tasks in the 'core' phase
cleo phases show core
```

Output:
```
Phase: Core Development (core)
Build core functionality and features

Tasks (10):
────────────────────────────────────────────────────────────
  ◉ T015   active   critical Implement user authentication
  ○ T018   pending  high     Add error logging middleware
  ⊗ T020   blocked  high     Deploy to staging
  ✓ T016   done     medium   Create database schema
  ○ T019   pending  medium   Refactor user service
  ○ T021   pending  medium   Add request validation
  ○ T022   pending  medium   Optimize API response times
  ✓ T017   done     medium   Setup CI/CD pipeline
  ○ T023   pending  low      Update documentation
  ✓ T024   done     low      Add unit tests
```

### Detailed Statistics

```bash
# Show comprehensive phase analytics with priority breakdown
cleo phases stats
```

Output:
```
PHASE STATISTICS
════════════════════════════════════════════════════════════

Setup (setup)
  ██████████████████████████████ 100%
  Done: 5 | Pending: 0 | Active: 0 | Blocked: 0
  Priority: 0 critical | 2 high | 3 medium | 0 low

Core Development (core)
  ████████████░░░░░░░░░░░░░░░░░░ 40%
  Done: 4 | Pending: 5 | Active: 1 | Blocked: 0
  Priority: 1 critical | 2 high | 6 medium | 1 low

Polish & Testing (polish)
  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 0%
  Done: 0 | Pending: 4 | Active: 0 | Blocked: 0
  Priority: 0 critical | 0 high | 2 medium | 2 low

════════════════════════════════════════════════════════════
OVERALL SUMMARY
  Total Phases: 3
  Total Tasks: 19
  Completed: 9 (47%)
  Active: 1
  Blocked: 0
```

### JSON Output

```bash
# Machine-readable format for scripting
cleo phases --format json
```

Output structure:
```json
{
  "phases": [
    {
      "slug": "setup",
      "name": "Setup",
      "description": "Initial project setup and configuration",
      "order": 1,
      "total": 5,
      "done": 5,
      "pending": 0,
      "active": 0,
      "blocked": 0,
      "percent": 100
    },
    {
      "slug": "core",
      "name": "Core Development",
      "description": "Build core functionality and features",
      "order": 2,
      "total": 10,
      "done": 4,
      "pending": 5,
      "active": 1,
      "blocked": 0,
      "percent": 40
    }
  ],
  "summary": {
    "totalPhases": 3,
    "totalTasks": 19,
    "completedTasks": 9
  }
}
```

### Show Phase Stats as JSON

```bash
# Get detailed statistics in JSON format
cleo phases stats --format json
```

Output structure:
```json
{
  "phases": [
    {
      "slug": "core",
      "name": "Core Development",
      "total": 10,
      "done": 4,
      "pending": 5,
      "active": 1,
      "blocked": 0,
      "percent": 40,
      "tasksByPriority": {
        "critical": 1,
        "high": 2,
        "medium": 6,
        "low": 1
      }
    }
  ],
  "summary": {
    "totalPhases": 3,
    "totalTasks": 19,
    "completedTasks": 9,
    "activeTasks": 1,
    "blockedTasks": 0
  }
}
```

## Phase Configuration (v2.2.0)

Since v2.2.0, phases are defined in `.cleo/todo.json` under the `project.phases` key with project-level tracking:

```json
{
  "version": "2.2.0",
  "project": {
    "name": "my-project",
    "currentPhase": "core",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "description": "Initial project setup and configuration",
        "status": "completed",
        "startedAt": "2025-12-01T10:00:00Z",
        "completedAt": "2025-12-10T15:00:00Z"
      },
      "core": {
        "order": 2,
        "name": "Core Development",
        "description": "Build core functionality and features",
        "status": "active",
        "startedAt": "2025-12-10T15:00:00Z",
        "completedAt": null
      },
      "polish": {
        "order": 3,
        "name": "Polish & Testing",
        "description": "Refine, test, and prepare for release",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      }
    }
  }
}
```

### Phase Definition Fields

| Field | Type | Description | Required | Notes |
|-------|------|-------------|----------|-------|
| `order` | integer | Sort order for phase display (≥1) | **Yes** | Determines sequence |
| `name` | string | Display name for the phase | **Yes** | Max 50 characters |
| `status` | string | Phase status: `pending`, `active`, `completed` | **Yes** | Enum value |
| `description` | string | Detailed description of the phase purpose | No | Max 200 characters |
| `startedAt` | string | ISO 8601 timestamp when phase started | No* | Required if `status` is `active` or `completed` |
| `completedAt` | string | ISO 8601 timestamp when phase completed | No* | Required if `status` is `completed` |

\* **Conditional Requirements**:
- `pending` phases: Both `startedAt` and `completedAt` must be `null`
- `active` phases: `startedAt` required, `completedAt` must be `null`
- `completed` phases: Both `startedAt` and `completedAt` required

### Project-Level Fields

| Field | Type | Description | Notes |
|-------|------|-------------|-------|
| `project.currentPhase` | string\|null | Slug of currently active phase | Must match a key in `project.phases` |
| `project.name` | string | Project name | Required in v2.2.0+ |
| `project.phases` | object | Phase definitions keyed by slug | Required in v2.2.0+ |

### Phase Lifecycle States

Phases follow a strict lifecycle with state transitions managed by the `phase` command:

```
pending → active → completed
   ↓         ↓
(start)  (complete)
```

**State Rules**:
1. Only ONE phase can be `active` at a time
2. `pending` → `active`: Sets `startedAt`, updates `currentPhase`
3. `active` → `completed`: Sets `completedAt`, requires all tasks in phase to be `done`
4. `completed` phases cannot return to `active` or `pending`

## Use Cases

### Project Planning

```bash
# See overall project progress across phases
cleo phases

# Identify which phase needs most attention
cleo phases stats | grep "Pending"
```

### Sprint Focus

```bash
# Show all tasks in current sprint phase
cleo phases show core

# Export phase tasks for sprint planning
cleo phases show core --format json > sprint-tasks.json
```

### Progress Reporting

```bash
# Generate phase progress report
cleo phases stats

# Track completion velocity
cleo phases --format json | \
  jq '.summary | "Completed: \(.completedTasks)/\(.totalTasks) (\((.completedTasks * 100 / .totalTasks))%)"'
```

### Workflow Visualization

```bash
# See visual progress bars for all phases
cleo phases

# Check if any phase is blocked
cleo phases stats | grep -E "Blocked: [1-9]"
```

## Phase Best Practices

### Naming Conventions

Use clear, sequential phase names that represent workflow stages:

**Good Phase Names**:
- `setup`, `foundation`, `init` - Initial setup work
- `core`, `development`, `implementation` - Main feature development
- `polish`, `refinement`, `testing` - Quality and testing
- `release`, `deploy`, `launch` - Deployment and release

**Avoid Ambiguous Names**:
- `phase1`, `phase2` (not descriptive)
- `misc`, `other` (too vague)
- `todo`, `tasks` (redundant)

### Phase Organization

Organize phases to match your workflow:

**Linear Workflow**:
```json
{
  "phases": {
    "planning": {"name": "Planning", "order": 1},
    "design": {"name": "Design", "order": 2},
    "development": {"name": "Development", "order": 3},
    "testing": {"name": "Testing", "order": 4},
    "deployment": {"name": "Deployment", "order": 5}
  }
}
```

**Iterative Workflow**:
```json
{
  "phases": {
    "mvp": {"name": "MVP", "order": 1},
    "iteration1": {"name": "Iteration 1", "order": 2},
    "iteration2": {"name": "Iteration 2", "order": 3},
    "polish": {"name": "Polish", "order": 4}
  }
}
```

**Component-Based**:
```json
{
  "phases": {
    "backend": {"name": "Backend", "order": 1},
    "frontend": {"name": "Frontend", "order": 2},
    "integration": {"name": "Integration", "order": 3},
    "optimization": {"name": "Optimization", "order": 4}
  }
}
```

### Assigning Tasks to Phases

```bash
# Add task with phase
cleo add "Implement login" --phase core

# Update task phase
cleo update T015 --phase polish

# Move all tasks from one phase to another
cleo phases show setup --format json | \
  jq -r '.tasks[].id' | \
  xargs -I {} cleo update {} --phase core
```

## Progress Indicators

### Visual Progress Bars

The progress bar visualization uses different colors based on completion:

| Completion | Color | Meaning |
|------------|-------|---------|
| 100% | Green | Phase completed |
| 75-99% | Cyan | Nearly complete |
| 50-74% | Yellow | Good progress |
| 25-49% | Magenta | Some progress |
| 0-24% | Red | Just started or blocked |

### Status Indicators

| Status | Icon | Description |
|--------|------|-------------|
| Empty | - | No tasks in phase |
| Pending | ░░░ | Not started (0% complete) |
| In Progress | ▓▓▓ | Partially complete |
| Completed | ███ | All tasks done |

### Task Status Icons

When viewing tasks in a phase (`show` command):

| Icon | Status | Description |
|------|--------|-------------|
| ✓ | done | Task completed |
| ◉ | active | Currently active |
| ⊗ | blocked | Blocked/waiting |
| ○ | pending | Not started |

## Integration Examples

### Shell Function for Phase Focus

```bash
# Add to .bashrc or .zshrc
ct-phase() {
  local phase="$1"
  echo "Tasks in $phase phase:"
  cleo phases show "$phase" --format json | \
    jq -r '.tasks[] | "\(.id) [\(.status)] \(.title)"'
}

# Usage: ct-phase core
```

### Weekly Phase Report

```bash
#!/usr/bin/env bash
# weekly-phase-report.sh

echo "=== Weekly Phase Progress Report ==="
echo ""
cleo phases stats
echo ""
echo "=== Phase-by-Phase Details ==="
cleo phases --format json | \
  jq -r '.phases[] | "Phase: \(.name) - \(.done)/\(.total) tasks (\(.percent)%)"'
```

### CI/CD Phase Validation

```bash
# Fail build if setup phase not complete
SETUP_COMPLETE=$(cleo phases show setup --format json | \
  jq '.tasks | map(select(.status != "done")) | length')

if [[ $SETUP_COMPLETE -gt 0 ]]; then
  echo "ERROR: Setup phase not complete"
  exit 1
fi
```

### Phase Completion Notifications

```bash
# Notify when phase completes
PHASE_PROGRESS=$(cleo phases --format json | \
  jq -r '.phases[] | select(.percent == 100) | .name')

if [[ -n "$PHASE_PROGRESS" ]]; then
  echo "✅ Phase completed: $PHASE_PROGRESS"
  # Send notification (Slack, Discord, email, etc.)
fi
```

## Advanced Queries

### Find Empty Phases

```bash
# List phases with no tasks
cleo phases --format json | \
  jq -r '.phases[] | select(.total == 0) | .slug'
```

### Calculate Phase Velocity

```bash
# Tasks completed per phase
cleo phases stats --format json | \
  jq '.phases[] | "\(.name): \(.done) done / \(.total) total"'
```

### Identify Bottleneck Phases

```bash
# Find phases with most blocked tasks
cleo phases stats --format json | \
  jq -r '.phases[] | select(.blocked > 0) | "\(.name): \(.blocked) blocked"'
```

### Export Phase Tasks

```bash
# Export all tasks from a phase to CSV
cleo phases show core --format json | \
  jq -r '.tasks[] | [.id, .status, .priority, .title] | @csv' > core-tasks.csv
```

## Combining with Other Commands

### Phase + Focus Workflow

```bash
# See current phase progress
cleo phases

# Get next task in current focus phase
cleo next --explain

# Set focus to highest priority task in phase
TASK_ID=$(cleo phases show core --format json | \
  jq -r '.tasks[] | select(.status == "pending") | .id' | head -1)
cleo focus set "$TASK_ID"
```

### Phase + Labels

```bash
# Show tasks with specific label in a phase
cleo phases show core --format json | \
  jq '.tasks[] | select(.labels | index("backend"))'

# Count tasks by label in each phase
cleo list --format json | \
  jq 'group_by(.phase) | map({phase: .[0].phase, count: length})'
```

### Phase Progress Dashboard

```bash
# Comprehensive phase-focused dashboard
echo "=== Phase Dashboard ==="
cleo phases
echo ""
echo "=== Current Focus Phase ==="
FOCUS_PHASE=$(cleo focus show --format json | jq -r '.phase')
cleo phases show "$FOCUS_PHASE"
```

## Color Output

The phases command respects standard color controls:

```bash
# Disable colors
NO_COLOR=1 cleo phases

# Force colors in pipes
FORCE_COLOR=1 cleo phases | less -R
```

## Related Commands

- `cleo add --phase PHASE` - Add task to specific phase
- `cleo update ID --phase PHASE` - Move task to different phase
- `cleo list --phase PHASE` - List tasks filtered by phase
- `cleo dash` - Dashboard shows phase progress section
- `cleo stats` - Overall statistics including phase metrics

## Tips

1. **Define Phases Early**: Set up your phase structure before adding many tasks
2. **Consistent Ordering**: Use the `order` field to maintain logical phase sequence
3. **Descriptive Names**: Use clear phase names that communicate workflow stage
4. **Limit Phases**: Keep to 3-7 phases for clarity; too many reduces usefulness
5. **Review Progress**: Use `phases stats` weekly to track completion trends
6. **Phase Alignment**: Group related work in same phase for focus efficiency
7. **Update as Needed**: Move tasks between phases as project evolves

## Troubleshooting

### No Phases Displayed

If `cleo phases` shows no phases:

```bash
# Check if phases are defined in todo.json
jq '.phases' .cleo/todo.json

# If null or empty, add phase definitions:
# Edit .cleo/todo.json and add phases object
```

### Phase Not Found Error

```bash
# List available phases
cleo phases --format json | jq -r '.phases[].slug'

# Verify task phase assignment
jq '.tasks[] | {id, phase}' .cleo/todo.json
```

### Incorrect Progress Percentages

```bash
# Validate task statuses
cleo validate

# Check for tasks with invalid status values
jq '.tasks[] | select(.status != "pending" and .status != "active" and .status != "blocked" and .status != "done")' .cleo/todo.json
```

## Managing Phases with `phase` Command (v2.2.0)

v2.2.0 introduces the `phase` command for project-level phase management:

```bash
# Set/create a phase
cleo phase set <slug> --name "Phase Name" --description "Phase description"

# Start a phase (marks as active)
cleo phase start <slug>

# Complete a phase (marks as completed, requires all tasks done)
cleo phase complete <slug>

# Advance to next phase in sequence
cleo phase advance

# Show phase details
cleo phase show <slug>

# List all phases
cleo phase list
```

See `docs/commands/phase.md` for complete `phase` command documentation.

### Phase vs Phases Command

| Command | Purpose | Scope |
|---------|---------|-------|
| `phase` | **Manage** phase lifecycle (set, start, complete, advance) | Project-level state |
| `phases` | **View** phase progress and task distribution | Task-level analytics |

Use `phase` to control which phase you're in, and `phases` to see progress across all phases.

## Version History

- **v2.2.0**: Added project-level phase tracking with `status`, `startedAt`, `completedAt`
- **v2.2.0**: Introduced `phase` command for phase lifecycle management
- **v2.2.0**: `currentPhase` now tracked at project level in `project.currentPhase`
- **v0.9.0**: Initial implementation with list, show, and stats subcommands
- **v0.9.0**: Added visual progress bars and priority breakdown in stats
