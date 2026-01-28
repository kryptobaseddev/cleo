# CLEO Claude Code Plugin Specification

**Version:** 1.0.0-draft
**Date:** 2025-12-29
**Status:** Planning
**Architecture:** Option A - CLI + Companion Plugin

---

## Executive Summary

This specification defines a Claude Code companion plugin for CLEO that provides Claude-native integration while preserving the standalone CLI tool. The plugin replaces manual CLAUDE.md injection with auto-discovered skills, adds convenient slash commands, provides autonomous agents for task analysis, and automates session lifecycle via hooks.

### Goals

1. **Replace injection workflow** - Skills auto-load instead of manual CLAUDE.md updates
2. **Enhance Claude integration** - Commands, agents, hooks for native experience
3. **Preserve CLI independence** - `cleo`/`ct` commands remain available outside Claude
4. **Maintain version sync** - Plugin distributed with CLI ensures version compatibility

### Non-Goals

- Converting CLEO entirely to a plugin (no standalone CLI)
- Duplicating CLI functionality in plugin code
- Supporting Claude Code versions without plugin system

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     User's System                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ~/.cleo/                          ~/.claude/plugins/cleo/       │
│  ├── bin/cleo (CLI)                ├── .claude-plugin/           │
│  ├── lib/*.sh                      │   └── plugin.json           │
│  ├── scripts/*.sh                  ├── skills/                   │
│  ├── schemas/                      │   └── task-management/      │
│  ├── docs/                         ├── commands/                 │
│  └── plugin/ ──────────────────────┤── agents/                   │
│       (symlink to plugin)          └── hooks/                    │
│                                                                  │
│  Project Directory                                               │
│  ├── .cleo/           (project task data)                        │
│  │   ├── todo.json                                               │
│  │   ├── sessions.json                                           │
│  │   └── config.json                                             │
│  └── CLAUDE.md        (NO injection needed)                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Component Relationship

| Component | Source | Function |
|-----------|--------|----------|
| **CLI** | `~/.cleo/bin/cleo` | Task operations, data management |
| **Plugin Skills** | `~/.claude/plugins/cleo/skills/` | Claude guidance for using CLI |
| **Plugin Commands** | `~/.claude/plugins/cleo/commands/` | Slash command wrappers |
| **Plugin Agents** | `~/.claude/plugins/cleo/agents/` | Autonomous task operations |
| **Plugin Hooks** | `~/.claude/plugins/cleo/hooks/` | Session lifecycle automation |

---

## Plugin Structure

```
cleo-plugin/
├── .claude-plugin/
│   └── plugin.json                    # Plugin manifest
│
├── skills/
│   └── task-management/
│       ├── SKILL.md                   # Core task management guidance
│       └── references/
│           ├── command-reference.md   # Full CLI command reference
│           ├── session-protocol.md    # Session workflow patterns
│           ├── multi-session.md       # Multi-agent coordination
│           ├── phase-discipline.md    # Phase workflow patterns
│           └── error-handling.md      # Error codes and recovery
│
├── commands/
│   ├── ct.md                          # General cleo wrapper
│   ├── ct-session.md                  # Session start/end
│   ├── ct-add.md                      # Quick task creation
│   ├── ct-focus.md                    # Focus management
│   └── ct-analyze.md                  # Task analysis/triage
│
├── agents/
│   ├── task-planner.md                # Break down features into tasks
│   ├── task-analyzer.md               # Analyze and prioritize tasks
│   └── session-reviewer.md            # Review session completeness
│
├── hooks/
│   ├── hooks.json                     # Hook configuration
│   └── scripts/
│       ├── session-start.sh           # Auto-start cleo session
│       ├── session-end.sh             # Auto-end cleo session
│       └── check-focus.sh             # Validate task focus
│
└── README.md                          # Plugin documentation
```

---

## Component Specifications

### 1. Plugin Manifest

**File:** `.claude-plugin/plugin.json`

```json
{
  "name": "cleo",
  "version": "1.0.0",
  "description": "Task management integration for CLEO CLI - LLM-agent-first task tracking",
  "author": {
    "name": "CLEO Team",
    "url": "https://github.com/cleo-dev/cleo"
  },
  "homepage": "https://github.com/cleo-dev/cleo",
  "repository": "https://github.com/cleo-dev/cleo",
  "license": "MIT",
  "keywords": ["task-management", "todo", "productivity", "llm-agent", "workflow"],
  "engines": {
    "claude-code": ">=1.0.0"
  },
  "dependencies": {
    "cli": {
      "command": "cleo",
      "version": ">=0.41.0",
      "install": "See https://github.com/cleo-dev/cleo#installation"
    }
  }
}
```

---

### 2. Skills

#### 2.1 Task Management Skill

**File:** `skills/task-management/SKILL.md`

**Frontmatter:**
```yaml
---
name: CLEO Task Management
description: >
  This skill should be used when the user asks to "create a task", "add a todo",
  "track tasks", "manage tasks", "use cleo", "use ct", "start a session",
  "end session", "focus on task", "complete task", "list tasks", "show tasks",
  "analyze tasks", "task triage", "what should I work on", "plan work",
  or discusses task management, project phases, or work sessions.
  Provides comprehensive guidance for the CLEO task management CLI.
version: 1.0.0
---
```

**Body Structure (~1,800 words):**

```markdown
# CLEO Task Management

CLEO is an LLM-agent-first task management CLI. All task operations use the `cleo`
(or `ct` alias) command. This skill provides guidance for effective task management
with proper session discipline, error handling, and workflow patterns.

## Critical Rules

### Data Integrity
- **CLI only** - Never read/edit `.cleo/*.json` directly
- **Verify state** - Use `ct list` before assuming task state
- **Session discipline** - Always start/end sessions properly
- **Error handling** - Check exit codes after every command

### Error Handling Protocol
After EVERY command, verify:
1. Exit code `0` = success, `1-22` = error, `100+` = special
2. JSON field `"success": false` = operation failed
3. Execute `error.fix` command if provided
4. Check `error.alternatives` for options

**Common exit codes:**
| Code | Meaning | Resolution |
|------|---------|------------|
| 4 | E_NOT_FOUND | Verify task ID with `ct find` |
| 6 | E_VALIDATION | Check field lengths, escape `$` |
| 10 | E_PARENT_NOT_FOUND | Verify parent with `ct exists` |
| 11 | E_DEPTH_EXCEEDED | Max depth is 3 (epic→task→subtask) |

## Essential Commands

### Task Operations
```bash
ct add "Task title"              # Create task
ct done <id>                     # Complete task
ct list                          # View all tasks
ct find "query"                  # Fuzzy search (preferred)
ct show <id>                     # Task details
ct update <id> --notes "text"    # Add notes
ct delete <id> --reason "why"    # Cancel task
```

### Session Management
```bash
ct session start                 # Begin work session
ct session end                   # End session
ct focus set <id>                # Set active task
ct focus show                    # Show current focus
ct focus clear                   # Clear focus
```

### Analysis
```bash
ct dash                          # Project overview
ct analyze                       # Task triage with scoring
ct analyze --auto-focus          # Auto-set focus to top task
ct next                          # Suggest next task
ct blockers                      # Show blocked tasks
```

## Session Protocol

### Starting Work
1. `ct session start` - Begin session
2. `ct dash` - Review project state
3. `ct focus set <id>` - Focus on one task
4. Work on focused task

### During Work
- `ct update <id> --notes "progress"` - Track progress
- `ct focus note "status"` - Session-level notes
- `ct add "Subtask" --parent <id>` - Break down work

### Completing Work
1. `ct done <id>` - Complete task
2. `ct focus clear` - Clear focus
3. `ct session end` - End session

## Phase Discipline

Check phase context before work:
```bash
ct phase show                    # Current phase
ct list --phase $(ct phase show -q)  # Phase tasks
```

Create tasks in appropriate phase:
```bash
ct add "Feature" --phase core
ct add "Tests" --phase testing --depends T001
```

## Additional Resources

### Reference Files
Detailed guidance available in `references/`:

- **`command-reference.md`** - Complete CLI command documentation
- **`session-protocol.md`** - Detailed session workflow patterns
- **`multi-session.md`** - Multi-agent coordination (v0.41.0+)
- **`phase-discipline.md`** - Phase workflow guidelines
- **`error-handling.md`** - Complete error codes and recovery

### Quick Tips
- Prefer `ct find` over `ct list` for discovery (99% less context)
- JSON output is automatic when piped
- Use native filters (`--status`, `--phase`) instead of jq
- Escape `$` as `\$` in notes to prevent shell interpolation
```

#### 2.2 Reference Files

**File:** `skills/task-management/references/command-reference.md`

Content: Comprehensive command reference extracted from `docs/TODO_Task_Management.md` (~3,000 words)

**File:** `skills/task-management/references/session-protocol.md`

Content: Detailed session workflows for single and multi-session modes (~1,500 words)

**File:** `skills/task-management/references/multi-session.md`

Content: Multi-agent coordination patterns from MULTI-SESSION-SPEC.md (~2,000 words)

**File:** `skills/task-management/references/phase-discipline.md`

Content: Phase workflow patterns and guidelines (~1,200 words)

**File:** `skills/task-management/references/error-handling.md`

Content: Complete error codes, recovery procedures, and troubleshooting (~1,500 words)

---

### 3. Commands

#### 3.1 General CLEO Command

**File:** `commands/ct.md`

```markdown
---
name: ct
description: Execute CLEO task management commands
argument-hint: <command> [args...]
allowed-tools: ["Bash"]
---

Execute a CLEO CLI command. This is a convenience wrapper around the `cleo` (or `ct`) CLI.

## Usage

Run any CLEO command:
```
/ct list --status pending
/ct add "New task" --priority high
/ct done T042
```

## Execution

1. Pass the provided arguments directly to the `ct` command
2. Execute: `ct <arguments>`
3. Check exit code for success (0) or error (non-zero)
4. If error, examine the JSON output for `error.fix` command
5. Report results to user

## Common Commands

- `ct list` - List tasks
- `ct add "title"` - Create task
- `ct done <id>` - Complete task
- `ct focus set <id>` - Set focus
- `ct session start|end` - Session lifecycle

For full command reference, consult the task-management skill.
```

#### 3.2 Session Command

**File:** `commands/ct-session.md`

```markdown
---
name: ct-session
description: Start or end a CLEO work session
argument-hint: start|end|status
allowed-tools: ["Bash"]
---

Manage CLEO session lifecycle. Sessions track work context and enable proper audit trails.

## Usage

```
/ct-session start     # Begin work session
/ct-session end       # End work session
/ct-session status    # Check session state
```

## Execution

### For `start`:
1. Execute: `ct session start`
2. If successful, follow with `ct dash` to show project overview
3. If session already active, inform user and show status

### For `end`:
1. Check if tasks are still in progress: `ct focus show`
2. If task focused, ask user if they want to complete or clear focus
3. Execute: `ct session end`
4. Report session summary

### For `status`:
1. Execute: `ct session status`
2. Display current session state

## Session Protocol

Always start sessions before task work. This ensures:
- Audit trail for changes
- Focus tracking
- Session notes persistence
```

#### 3.3 Add Task Command

**File:** `commands/ct-add.md`

```markdown
---
name: ct-add
description: Create a new CLEO task
argument-hint: "Task title" [--priority high] [--phase core] [--parent T001]
allowed-tools: ["Bash"]
---

Create a new task in CLEO with optional metadata.

## Usage

```
/ct-add "Implement user authentication"
/ct-add "Write unit tests" --phase testing --depends T001
/ct-add "Fix login bug" --priority high --labels bug,auth
```

## Execution

1. Parse the task title (required) and options
2. Construct command: `ct add "title" [options]`
3. Execute and check exit code
4. If exit code 0: Report task ID created
5. If error: Show `error.fix` command and alternatives

## Options

| Option | Values | Purpose |
|--------|--------|---------|
| `--priority` | critical, high, medium, low | Urgency |
| `--phase` | setup, core, testing, polish, maintenance | Workflow stage |
| `--parent` | Task ID | Hierarchy parent |
| `--depends` | Task IDs (comma-separated) | Dependencies |
| `--labels` | Labels (comma-separated) | Categorization |
| `--description` | Text | Detailed description |

## Tips

- Title should be action-oriented ("Implement X", "Fix Y")
- Set phase to match current project phase when possible
- Use dependencies for task ordering
```

#### 3.4 Focus Command

**File:** `commands/ct-focus.md`

```markdown
---
name: ct-focus
description: Manage task focus - set, show, or clear the active task
argument-hint: set <id>|show|clear|note "text"
allowed-tools: ["Bash"]
---

Manage which task is currently being worked on. Only one task can be focused at a time.

## Usage

```
/ct-focus set T042     # Focus on task T042
/ct-focus show         # Show current focus
/ct-focus clear        # Clear focus
/ct-focus note "Working on API"  # Add session note
```

## Execution

### For `set <id>`:
1. Verify task exists: `ct exists <id> --quiet`
2. If not found, suggest `ct find` to locate task
3. Execute: `ct focus set <id>`
4. Show task details after focusing

### For `show`:
1. Execute: `ct focus show`
2. Display focused task or "No task focused"

### For `clear`:
1. Execute: `ct focus clear`
2. Confirm focus cleared

### For `note "text"`:
1. Execute: `ct focus note "text"`
2. Confirm note added

## Focus Discipline

- Focus on ONE task at a time
- Complete or clear focus before switching
- Use focus notes for session-level progress
- Use `ct update --notes` for task-specific notes
```

#### 3.5 Analyze Command

**File:** `commands/ct-analyze.md`

```markdown
---
name: ct-analyze
description: Analyze and triage tasks with intelligent scoring
argument-hint: [--auto-focus]
allowed-tools: ["Bash"]
---

Run CLEO task triage analysis with leverage scoring to determine optimal task ordering.

## Usage

```
/ct-analyze              # Show task triage analysis
/ct-analyze --auto-focus # Analyze and auto-set focus to top task
```

## Execution

1. Execute: `ct analyze [--auto-focus]`
2. Parse JSON output
3. Present analysis summary:
   - Top recommended tasks with scores
   - Blocked tasks and blockers
   - Phase progress
4. If `--auto-focus` used, confirm which task was focused

## Output Interpretation

The analyzer considers:
- Priority level
- Dependencies (blocked vs unblocked)
- Phase alignment
- Task age
- Leverage score (impact vs effort)

Higher scores indicate tasks that should be worked on first.
```

---

### 4. Agents

**Important: Subagent Skill Inheritance**

Subagents do NOT automatically inherit skills from the parent conversation. Each agent must explicitly declare required skills in the `skills:` frontmatter field. All CLEO plugin agents declare `skills: task-management` to ensure they have access to CLI guidance.

Hooks (PreToolUse, PostToolUse) DO fire on subagent tool calls, so session lifecycle hooks will apply.

#### 4.1 Task Planner Agent

**File:** `agents/task-planner.md`

```markdown
---
name: task-planner
description: >
  Use this agent when the user needs to break down a feature, project, or epic
  into concrete CLEO tasks. Examples:

  <example>
  Context: User has described a new feature they want to build
  user: "I need to add user authentication to my app"
  assistant: "I'll use the task-planner agent to break this down into concrete tasks with proper dependencies and phases."
  <commentary>
  User described a feature that needs decomposition into multiple tasks.
  The task-planner agent will analyze requirements and create a structured task hierarchy.
  </commentary>
  </example>

  <example>
  Context: User wants to plan implementation work
  user: "Help me plan out the tasks for implementing a REST API"
  assistant: "Let me use the task-planner agent to create a comprehensive task breakdown with phases and dependencies."
  <commentary>
  User explicitly asked for task planning. The task-planner agent specializes in
  decomposing work into well-structured CLEO tasks.
  </commentary>
  </example>

  <example>
  Context: User has a vague idea that needs structure
  user: "I want to refactor the database layer but I'm not sure where to start"
  assistant: "I'll analyze what's involved and break this down into manageable tasks using the task-planner agent."
  <commentary>
  User has unclear scope. Task-planner will help structure the work into
  concrete, actionable tasks with proper sequencing.
  </commentary>
  </example>

model: inherit
color: cyan
skills: task-management
tools: ["Read", "Bash", "Grep", "Glob"]
---

You are a task planning specialist for CLEO task management. Your role is to analyze
feature requests, projects, or vague ideas and decompose them into well-structured
CLEO tasks with proper hierarchy, dependencies, and phase assignments.

**Your Core Responsibilities:**

1. Analyze the user's request to understand scope and requirements
2. Identify natural task boundaries and dependencies
3. Create a task hierarchy (epic → tasks → subtasks where appropriate)
4. Assign appropriate phases (setup, core, testing, polish, maintenance)
5. Define dependencies between tasks
6. Set reasonable priorities
7. Create tasks using CLEO CLI commands

**Analysis Process:**

1. **Understand Scope**
   - What is the end goal?
   - What are the key components?
   - What existing code/systems are involved?

2. **Identify Task Boundaries**
   - What can be done independently?
   - What has natural dependencies?
   - What is the minimum viable first step?

3. **Structure Hierarchy**
   - Create epic for large features (>5 tasks)
   - Break into logical task groups
   - Use subtasks for detailed steps within a task

4. **Assign Metadata**
   - Phase: Where in workflow does this belong?
   - Priority: What's the urgency/importance?
   - Dependencies: What must complete first?
   - Labels: How should this be categorized?

**Task Creation Pattern:**

```bash
# For epics (large features)
ct add "Epic: Feature Name" --type epic --phase core --priority high

# For tasks under epic
ct add "Task description" --parent <epic-id> --phase core --depends <id>

# For subtasks (detailed steps)
ct add "Subtask description" --parent <task-id> --type subtask
```

**Output Format:**

Provide:
1. Summary of the planned work
2. Task hierarchy visualization
3. The exact CLEO commands to create tasks
4. Explanation of dependencies and sequencing

**Quality Standards:**

- Tasks should be actionable (start with verb)
- Each task should be completable in one session
- Dependencies should reflect true blocking relationships
- Phases should align with project workflow
- No time estimates (describe scope instead)
```

#### 4.2 Task Analyzer Agent

**File:** `agents/task-analyzer.md`

```markdown
---
name: task-analyzer
description: >
  Use this agent when the user wants to understand task status, find what to work on,
  or analyze project progress. Triggers proactively after significant task completions
  to suggest next steps. Examples:

  <example>
  Context: User completed several tasks and needs direction
  user: "What should I work on next?"
  assistant: "I'll analyze your tasks to recommend the highest-impact next step."
  <commentary>
  User is seeking guidance on task prioritization. Task-analyzer will evaluate
  current state and recommend optimal next task.
  </commentary>
  </example>

  <example>
  Context: User wants project status overview
  user: "How is the project progressing?"
  assistant: "Let me analyze your task data to provide a comprehensive progress report."
  <commentary>
  User wants status understanding. Task-analyzer will provide metrics and insights.
  </commentary>
  </example>

  <example>
  Context: User seems stuck or uncertain
  user: "I'm not sure what's blocking progress"
  assistant: "I'll analyze your tasks to identify blockers and suggest unblocking strategies."
  <commentary>
  User experiencing friction. Task-analyzer will identify blockers and provide actionable guidance.
  </commentary>
  </example>

model: inherit
color: green
skills: task-management
tools: ["Bash", "Read"]
---

You are a task analysis specialist for CLEO. Your role is to analyze task state,
identify patterns, recommend priorities, and provide actionable insights.

**Your Core Responsibilities:**

1. Analyze current task state using CLEO commands
2. Identify blockers and dependencies
3. Calculate progress metrics
4. Recommend next actions
5. Surface potential issues

**Analysis Process:**

1. **Gather State**
   ```bash
   ct dash --compact        # Quick overview
   ct analyze               # Detailed triage
   ct blockers              # Identify blockers
   ct phases                # Phase progress
   ```

2. **Evaluate Priorities**
   - Which tasks are unblocked?
   - What has highest leverage score?
   - What aligns with current phase?
   - What has been pending longest?

3. **Identify Issues**
   - Orphaned tasks (no path to completion)
   - Circular dependencies
   - Stale tasks (no activity)
   - Phase misalignment

4. **Formulate Recommendations**
   - Primary recommendation with reasoning
   - Alternative options
   - Blockers to address

**Output Format:**

Provide:
1. Current state summary (tasks by status, phase progress)
2. Key insights (blockers, patterns, risks)
3. Recommended next task with reasoning
4. Alternative options if primary is blocked

**Analysis Commands:**

```bash
ct list --status pending    # Pending tasks
ct list --status blocked    # Blocked tasks
ct blockers analyze         # Critical path
ct deps tree               # Dependency visualization
ct history --days 7        # Recent completions
```

**Quality Standards:**

- Base recommendations on data, not assumptions
- Always verify task existence before referencing
- Provide actionable next steps
- Explain reasoning for recommendations
```

#### 4.3 Session Reviewer Agent

**File:** `agents/session-reviewer.md`

```markdown
---
name: session-reviewer
description: >
  Use this agent when ending a session to review completeness, or when validating
  that work is properly tracked. Triggers proactively before session end. Examples:

  <example>
  Context: User is about to end their session
  user: "I'm done for today"
  assistant: "Before ending, let me review the session to ensure everything is properly tracked."
  <commentary>
  User ending session. Session-reviewer validates completeness before session end.
  </commentary>
  </example>

  <example>
  Context: User wants to verify their work is tracked
  user: "Did I capture everything I worked on?"
  assistant: "I'll review the session activity to verify all work is properly tracked."
  <commentary>
  User seeking validation. Session-reviewer will audit session activity.
  </commentary>
  </example>

model: inherit
color: yellow
skills: task-management
tools: ["Bash", "Read"]
---

You are a session review specialist for CLEO. Your role is to validate that work
sessions are properly completed with all changes tracked.

**Your Core Responsibilities:**

1. Review session activity
2. Verify task completions are recorded
3. Identify untracked work
4. Ensure session notes capture progress
5. Validate session can be cleanly ended

**Review Process:**

1. **Check Session State**
   ```bash
   ct session status        # Current session info
   ct focus show           # Current focus
   ```

2. **Review Activity**
   ```bash
   ct log --limit 20       # Recent operations
   ct history --days 1     # Today's completions
   ```

3. **Validate Completeness**
   - Is focused task completed or progress noted?
   - Are there uncommitted code changes?
   - Are session notes up to date?
   - Any tasks started but not updated?

4. **Prepare for End**
   - Recommend completing or clearing focus
   - Suggest adding session notes
   - Identify any cleanup needed

**Output Format:**

Provide:
1. Session summary (duration, tasks touched)
2. Completion checklist
3. Recommended actions before ending
4. Any warnings or issues

**Quality Standards:**

- Always check focus state before recommending end
- Verify no tasks left in inconsistent state
- Recommend notes for work in progress
- Ensure clean session termination
```

---

### 5. Hooks

#### 5.1 Hook Configuration

**File:** `hooks/hooks.json`

```json
{
  "description": "CLEO session lifecycle automation hooks",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/session-start.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Before stopping, verify CLEO session state. Check: Is there an active CLEO session? Is a task focused? Should the session be ended or suspended? If work is incomplete, recommend proper session handling. Return 'approve' to stop or 'block' with session cleanup recommendations.",
            "timeout": 15
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/check-focus.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

#### 5.2 Session Start Hook Script

**File:** `hooks/scripts/session-start.sh`

```bash
#!/usr/bin/env bash
# CLEO SessionStart hook - auto-start session if project has .cleo/
set -euo pipefail

# Check if this is a CLEO-enabled project
CLEO_DIR="${CLAUDE_PROJECT_DIR:-.}/.cleo"

if [[ -d "$CLEO_DIR" ]]; then
    # Check if session already active
    session_status=$(ct session status --format json 2>/dev/null || echo '{"active": false}')
    is_active=$(echo "$session_status" | jq -r '.active // false')

    if [[ "$is_active" == "false" ]]; then
        # Start session automatically
        ct session start --quiet 2>/dev/null || true

        # Get project overview
        overview=$(ct dash --compact 2>/dev/null || echo "CLEO project detected")

        echo "{\"systemMessage\": \"CLEO session started. $overview\"}"
    else
        echo "{\"systemMessage\": \"CLEO session already active.\"}"
    fi
else
    # Not a CLEO project, no action
    echo "{}"
fi
```

#### 5.3 Check Focus Hook Script

**File:** `hooks/scripts/check-focus.sh`

```bash
#!/usr/bin/env bash
# CLEO UserPromptSubmit hook - remind about focus if working on tasks
set -euo pipefail

# Only run if CLEO project
CLEO_DIR="${CLAUDE_PROJECT_DIR:-.}/.cleo"
[[ -d "$CLEO_DIR" ]] || exit 0

# Read the user prompt from stdin
input=$(cat)
user_prompt=$(echo "$input" | jq -r '.user_prompt // ""')

# Check if prompt is task-related
if echo "$user_prompt" | grep -qiE '(task|todo|work on|implement|fix|add|create|build)'; then
    # Check focus state
    focus_status=$(ct focus show --format json 2>/dev/null || echo '{"focused": false}')
    has_focus=$(echo "$focus_status" | jq -r '.focused // false')

    if [[ "$has_focus" == "false" ]]; then
        # No task focused, suggest setting focus
        echo "{\"systemMessage\": \"Note: No CLEO task is currently focused. Consider using 'ct focus set <id>' to track this work.\"}"
    fi
fi

# Default: no message
echo "{}"
```

#### 5.4 Session End Hook Script (Optional)

**File:** `hooks/scripts/session-end.sh`

```bash
#!/usr/bin/env bash
# CLEO SessionEnd hook - cleanup and summary
set -euo pipefail

CLEO_DIR="${CLAUDE_PROJECT_DIR:-.}/.cleo"
[[ -d "$CLEO_DIR" ]] || exit 0

# Check if CLEO session is active
session_status=$(ct session status --format json 2>/dev/null || echo '{"active": false}')
is_active=$(echo "$session_status" | jq -r '.active // false')

if [[ "$is_active" == "true" ]]; then
    # End the session
    ct session end --quiet 2>/dev/null || true
    echo "{\"systemMessage\": \"CLEO session ended.\"}"
fi

echo "{}"
```

---

## Installation & Distribution

### Distribution Strategy

The plugin is distributed as part of the CLEO CLI package:

```
~/.cleo/
├── bin/cleo
├── lib/*.sh
├── scripts/*.sh
├── ...
└── plugin/                    # Plugin directory
    ├── .claude-plugin/
    ├── skills/
    ├── commands/
    ├── agents/
    └── hooks/
```

### Installation Process

The `install.sh` script will be updated to:

1. Install CLI to `~/.cleo/` (existing behavior)
2. Create symlink: `~/.claude/plugins/cleo → ~/.cleo/plugin/`
3. Verify Claude Code plugin system is available
4. Report success with plugin activation instructions

```bash
# In install.sh
install_plugin() {
    local plugin_dir="$INSTALL_DIR/plugin"
    local claude_plugins_dir="$HOME/.claude/plugins"

    # Create Claude plugins directory if needed
    mkdir -p "$claude_plugins_dir"

    # Create symlink to plugin
    if [[ -L "$claude_plugins_dir/cleo" ]]; then
        rm "$claude_plugins_dir/cleo"
    fi
    ln -s "$plugin_dir" "$claude_plugins_dir/cleo"

    echo "Claude Code plugin installed: ~/.claude/plugins/cleo"
}
```

### Version Synchronization

Plugin version matches CLI version:
- `VERSION` file in repo root
- `plugin.json` version updated by `bump-version.sh`
- Ensures CLI and plugin are always compatible

---

## Migration Path

### From Current Injection Workflow

**Before (Current):**
1. User runs `cleo init` in project
2. CLAUDE.md is injected with instructions
3. User's `~/.claude/CLAUDE.md` has TODO_Task_Management.md reference
4. Manual updates when CLEO upgrades

**After (With Plugin):**
1. User installs CLEO (includes plugin)
2. Plugin auto-discovers in Claude Code
3. Skills provide instructions automatically
4. Hooks manage session lifecycle
5. No CLAUDE.md injection needed

### Deprecation of Injection

1. **Phase 1:** Plugin released alongside injection (parallel support)
2. **Phase 2:** Plugin documented as recommended approach
3. **Phase 3:** Injection deprecated with migration guide
4. **Phase 4:** Injection removed in future major version

---

## Testing Strategy

### Unit Tests

- Validate plugin.json schema
- Validate hooks.json schema
- Test hook scripts with mock input
- Verify skill YAML frontmatter

### Integration Tests

- Plugin loads in Claude Code
- Skills trigger on expected phrases
- Commands execute correctly
- Hooks fire on events
- Agents trigger appropriately

### Manual Testing Checklist

- [ ] Plugin appears in `/plugins` command
- [ ] Skill loads when discussing tasks
- [ ] `/ct-session start` works
- [ ] `/ct-add "test"` creates task
- [ ] SessionStart hook auto-starts session
- [ ] Stop hook validates before stopping
- [ ] task-planner agent triggers on feature planning
- [ ] task-analyzer agent triggers on "what to work on"

---

## Success Criteria

| Metric | Target |
|--------|--------|
| Injection replacement | 100% of injection functionality covered by skills |
| Command coverage | 5 most common operations have slash commands |
| Agent triggering | Agents trigger >90% on matching phrases |
| Hook reliability | Hooks execute successfully >99% |
| User friction | No manual CLAUDE.md updates required |

---

## Open Questions

1. **Plugin marketplace:** Should we publish to Claude Code marketplace?
2. **Standalone plugin:** Should plugin be installable separately from CLI?
3. **MCP integration:** Should we add MCP server for tool-based access?
4. **Multi-project:** How to handle multiple CLEO projects in one session?

---

## Appendix: File Inventory

| File | Type | Size Estimate |
|------|------|---------------|
| `.claude-plugin/plugin.json` | Manifest | ~500 bytes |
| `skills/task-management/SKILL.md` | Skill | ~1,800 words |
| `skills/task-management/references/command-reference.md` | Reference | ~3,000 words |
| `skills/task-management/references/session-protocol.md` | Reference | ~1,500 words |
| `skills/task-management/references/multi-session.md` | Reference | ~2,000 words |
| `skills/task-management/references/phase-discipline.md` | Reference | ~1,200 words |
| `skills/task-management/references/error-handling.md` | Reference | ~1,500 words |
| `commands/ct.md` | Command | ~300 words |
| `commands/ct-session.md` | Command | ~350 words |
| `commands/ct-add.md` | Command | ~400 words |
| `commands/ct-focus.md` | Command | ~350 words |
| `commands/ct-analyze.md` | Command | ~300 words |
| `agents/task-planner.md` | Agent | ~600 words |
| `agents/task-analyzer.md` | Agent | ~500 words |
| `agents/session-reviewer.md` | Agent | ~400 words |
| `hooks/hooks.json` | Config | ~1,000 bytes |
| `hooks/scripts/session-start.sh` | Script | ~40 lines |
| `hooks/scripts/check-focus.sh` | Script | ~35 lines |
| `hooks/scripts/session-end.sh` | Script | ~25 lines |
| `README.md` | Docs | ~500 words |

**Total: 19 files**

---

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0-draft | 2025-12-29 | Initial specification |
