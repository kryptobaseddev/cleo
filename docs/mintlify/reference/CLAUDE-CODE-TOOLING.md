# Claude Code Tooling Reference

**Version**: 2.1.29 (as of 2026-01-31)
**Status**: Living Document
**Purpose**: Reverse-engineered reference for Claude Code's internal tooling to inform CLEO development

---

## Overview

Claude Code is distributed as a compiled ELF binary (~220MB). The source code is not publicly available, but we can reverse-engineer the tooling through:

1. **~/.claude/** - Configuration, schemas, debug logs
2. **Binary strings** - Embedded definitions
3. **Debug logs** - Tool invocations
4. **npm package** - TypeScript type definitions
5. **Official plugins repo** - Architecture patterns

**Scraping scripts**: See `/mnt/projects/claude-code/SCRAPING-GUIDE.md`

---

## Core Tools (19 Built-in)

### File Operations

| Tool | Parameters | Description |
|------|-----------|-------------|
| **Read** | `file_path`, `offset?`, `limit?` | Read file contents with optional pagination |
| **Write** | `file_path`, `content` | Create or overwrite file |
| **Edit** | `file_path`, `old_string`, `new_string`, `replace_all?` | String replacement editing |
| **Glob** | `pattern`, `path?` | File pattern matching (e.g., `**/*.ts`) |
| **Grep** | `pattern`, `path?`, `glob?`, `output_mode?`, `-A/-B/-C?`, `-i?`, `-n?`, `type?`, `head_limit?`, `offset?`, `multiline?` | Content search with ripgrep |
| **NotebookEdit** | `notebook_path`, `cell_id?`, `new_source`, `cell_type?`, `edit_mode?` | Jupyter notebook editing |

### Execution

| Tool | Parameters | Description |
|------|-----------|-------------|
| **Bash** | `command`, `timeout?`, `description?`, `run_in_background?`, `dangerouslyDisableSandbox?` | Shell command execution |
| **Task** | `description`, `prompt`, `subagent_type`, `model?`, `resume?`, `run_in_background?`, `max_turns?` | Spawn autonomous subagents |
| **TaskOutput** | `task_id`, `block`, `timeout` | Retrieve background task output |
| **TaskStop** | `task_id` | Stop running background task |

### Web & Search

| Tool | Parameters | Description |
|------|-----------|-------------|
| **WebFetch** | `url`, `prompt` | Fetch URL and analyze with prompt |
| **WebSearch** | `query`, `allowed_domains?`, `blocked_domains?` | Web search |

### Interaction

| Tool | Parameters | Description |
|------|-----------|-------------|
| **AskUserQuestion** | `questions[]` | Interactive multi-choice prompts |
| **TodoWrite** | `todos[]` | Session task tracking |
| **Skill** | `skill`, `args?` | Invoke registered skills |

### Planning & MCP

| Tool | Parameters | Description |
|------|-----------|-------------|
| **ExitPlanMode** | `allowedPrompts?`, `pushToRemote?` | Exit planning mode |
| **EnterPlanMode** | (none) | Enter planning mode |
| **ListMcpResources** | `server?` | List MCP server resources |
| **ReadMcpResource** | `server`, `uri` | Read specific MCP resource |

---

## Tool Schemas (Detailed)

### Read
```typescript
interface FileReadInput {
  file_path: string;      // Absolute path required
  offset?: number;        // Line number to start from
  limit?: number;         // Number of lines to read
}
```

### Write
```typescript
interface FileWriteInput {
  file_path: string;      // Absolute path required
  content: string;        // Full file content
}
```

### Edit
```typescript
interface FileEditInput {
  file_path: string;      // Absolute path required
  old_string: string;     // Text to find (must be unique)
  new_string: string;     // Replacement text
  replace_all?: boolean;  // Replace all occurrences (default: false)
}
```

### Bash
```typescript
interface BashInput {
  command: string;                    // Command to execute
  timeout?: number;                   // Timeout in ms (max 600000)
  description?: string;               // Human-readable description
  run_in_background?: boolean;        // Run async
  dangerouslyDisableSandbox?: boolean; // Bypass sandbox
}
```

### Grep
```typescript
interface GrepInput {
  pattern: string;                    // Regex pattern
  path?: string;                      // Search path
  glob?: string;                      // File glob filter
  output_mode?: 'content' | 'files_with_matches' | 'count';
  '-A'?: number;                      // Lines after match
  '-B'?: number;                      // Lines before match
  '-C'?: number;                      // Context lines
  '-i'?: boolean;                     // Case insensitive
  '-n'?: boolean;                     // Line numbers
  type?: string;                      // File type (js, py, etc.)
  head_limit?: number;                // Limit results
  offset?: number;                    // Skip first N
  multiline?: boolean;                // Multiline mode
}
```

### Task (Agent Spawning)
```typescript
interface AgentInput {
  description: string;                // Short task description (3-5 words)
  prompt: string;                     // Full instructions for agent
  subagent_type: string;              // Agent type identifier
  model?: 'inherit' | 'sonnet' | 'opus' | 'haiku';
  resume?: string;                    // Agent ID to resume
  run_in_background?: boolean;        // Run async
  max_turns?: number;                 // Max API round-trips
}
```

### TodoWrite
```typescript
interface TodoWriteInput {
  todos: Array<{
    content: string;                  // Task description (imperative)
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;               // Present continuous for spinner
  }>;
}
```

### AskUserQuestion
```typescript
interface AskUserQuestionInput {
  questions: Array<{
    question: string;                 // The question text
    header: string;                   // Short label (max 12 chars)
    options: Array<{
      label: string;                  // Option display text
      description: string;            // Option explanation
    }>;
    multiSelect?: boolean;            // Allow multiple selections
  }>;
}
```

### WebFetch
```typescript
interface WebFetchInput {
  url: string;                        // URL to fetch
  prompt: string;                     // Analysis prompt
}
```

### WebSearch
```typescript
interface WebSearchInput {
  query: string;                      // Search query
  allowed_domains?: string[];         // Whitelist domains
  blocked_domains?: string[];         // Blacklist domains
}
```

---

## MCP Servers

### Installed Servers (8)

| Server | Purpose | Key Tools |
|--------|---------|-----------|
| **context7** | Library documentation | `resolve-library-id`, `query-docs`, `get-library-docs` |
| **sequential-thinking** | Multi-step reasoning | `sequentialthinking` |
| **tavily** | Web search | `tavily-search`, `tavily-extract` |
| **serena** | Code analysis & memory | `find_symbol`, `search_for_pattern`, `read_memory`, `write_memory` |
| **morphllm** | Bulk code edits | `edit_file` |
| **playwright** | Browser automation | (various browser controls) |
| **claude-in-chrome** | Chrome DevTools | `computer`, `navigate`, `read_page`, `javascript_tool` |

### MCP Tool Naming Convention
```
mcp__{server}__{tool}
```

Examples:
- `mcp__context7__query-docs`
- `mcp__serena__find_symbol`
- `mcp__tavily__tavily-search`

### Context7 Tools
```typescript
// Resolve library name to ID
interface ResolveLibraryId {
  libraryName: string;    // e.g., "react", "express"
  query: string;          // User's question for relevance
}

// Query documentation
interface QueryDocs {
  libraryId: string;      // e.g., "/vercel/next.js"
  query: string;          // Specific question
}
```

### Serena Tools
```typescript
// Find symbol in codebase
interface FindSymbol {
  symbol_name: string;
  file_path?: string;
}

// Search with pattern
interface SearchForPattern {
  pattern: string;
  file_pattern?: string;
}

// Memory operations
interface ReadMemory { key: string; }
interface WriteMemory { key: string; value: string; }
```

### Sequential Thinking
```typescript
interface SequentialThinking {
  thought: string;            // Current reasoning step
  nextThoughtNeeded: boolean; // Continue thinking?
  thoughtNumber: number;      // Step number
  totalThoughts: number;      // Estimated total
}
```

---

## Plugin Architecture

### Directory Structure
```
plugin-name/
├── .claude-plugin/
│   └── plugin.json              # Required manifest
├── commands/                    # Slash commands (.md)
│   └── command-name.md
├── agents/                      # Subagent definitions (.md)
│   └── agent-name.md
├── skills/                      # Auto-activated knowledge
│   └── skill-name/
│       ├── SKILL.md             # Required
│       ├── examples/
│       └── references/
├── hooks/
│   ├── hooks.json               # Hook configuration
│   └── scripts/
└── .mcp.json                    # MCP server definitions
```

### Plugin Manifest (plugin.json)
```json
{
  "name": "plugin-name",
  "version": "1.0.0",
  "description": "Plugin description",
  "author": { "name": "Author" },
  "commands": "./commands",
  "agents": "./agents",
  "skills": "./skills",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json"
}
```

### Command Format (.md)
```markdown
---
description: Brief description for /help
allowed-tools: Read, Write, Grep
model: sonnet
argument-hint: [arg1] [arg2]
---

Instructions for Claude when command is invoked.

Arguments available: $ARGUMENTS, $1, $2, $3
File references: @file.md
Bash execution: !`command`
Plugin paths: ${CLAUDE_PLUGIN_ROOT}
```

### Agent Format (.md)
```markdown
---
name: agent-identifier
description: |
  Use this agent when [conditions].

  <example>
  Context: [Scenario]
  user: "[Request]"
  assistant: "[Response]"
  </example>
model: sonnet
color: blue
tools: ["Read", "Write", "Grep"]
---

Agent system prompt and instructions...
```

### Skill Format (SKILL.md)
```markdown
---
name: Skill Name
description: Trigger phrases and when to use
version: 1.0.0
---

# Skill Content

Progressive disclosure: metadata → SKILL.md → references/
```

### Hook Configuration (hooks.json)
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "type": "prompt",
        "prompt": "Validate this edit: $TOOL_INPUT"
      }
    ],
    "PostToolUse": [...],
    "Stop": [...],
    "UserPromptSubmit": [...],
    "SessionStart": [...],
    "SessionEnd": [...]
  }
}
```

### Hook Events

| Event | Trigger | Use Case |
|-------|---------|----------|
| `PreToolUse` | Before tool execution | Validate, modify, block |
| `PostToolUse` | After tool execution | React, log, feedback |
| `Stop` | Before agent stops | Completeness check |
| `SubagentStop` | Before subagent stops | Subagent validation |
| `UserPromptSubmit` | User sends message | Add context |
| `SessionStart` | Session begins | Load context |
| `SessionEnd` | Session ends | Cleanup |
| `PreCompact` | Before context compact | Preserve info |
| `Notification` | User notification | React |

### Hook Output Format
```json
{
  "continue": true,
  "suppressOutput": false,
  "systemMessage": "Message for Claude",
  "hookSpecificOutput": {
    "permissionDecision": "allow|deny|ask",
    "updatedInput": {}
  }
}
```

---

## Key Locations

### Configuration
- `~/.claude/settings.json` - User settings
- `~/.claude/CLAUDE.md` - Global instructions
- `~/.claude/.credentials.json` - Auth credentials

### Data
- `~/.claude/history.jsonl` - Conversation history
- `~/.claude/todos/` - Task items
- `~/.claude/projects/` - Project-specific data

### Debugging
- `~/.claude/debug/` - Debug traces (UUID.txt files)
- `~/.claude/logs/` - Structured logs

### Plugins
- `~/.claude/plugins/` - Installed plugins
- `~/.claude/agents/` - Agent definitions
- `~/.claude/skills/` - Skill definitions

### Binary
- `~/.local/bin/claude` - Symlink to active version
- `~/.local/share/claude/versions/` - Version binaries

---

## Implications for CLEO

### Tool Parity Checklist

| Claude Tool | CLEO Equivalent | Status |
|-------------|-----------------|--------|
| TodoWrite | `cleo` CLI | Implemented (more sophisticated) |
| Task | Subagent spawning | Implemented via orchestrator |
| Read/Write/Edit | Bash + lib functions | N/A (Claude handles) |
| Skill | Skills system | Implemented |
| Hooks | Not yet | **Opportunity** |

### Architecture Alignment

1. **Progressive Disclosure** - CLEO skills should follow metadata → core → references pattern
2. **Event Hooks** - Consider adding PreToolUse/PostToolUse patterns to CLEO
3. **Agent Spawning** - `subagent_type` routing aligns with CLEO's orchestrator model
4. **Status Enum** - `pending`, `in_progress`, `completed` matches CLEO exactly

### Integration Opportunities

1. **MCP Server Creation** - CLEO could expose an MCP server for Claude Code integration
2. **Hook System** - Add CLEO-specific hooks for task lifecycle events
3. **Plugin Format** - Consider packaging CLEO as a Claude Code plugin

---

---

## Claude Code Tasks System (v2.1.29+)

Claude Code introduced a new Tasks system that competes with CLEO's task management.

### Task Tools (5 Tools)

| Tool | Parameters | Description |
|------|-----------|-------------|
| **TaskCreate** | `subject`, `description`, `activeForm?`, `metadata?` | Create new task |
| **TaskUpdate** | `taskId`, `status?`, `owner?`, `addBlocks?`, `addBlockedBy?`, `metadata?` | Update or delete task |
| **TaskGet** | `taskId` | Retrieve task by ID |
| **TaskList** | (none) | List all tasks with summary |
| **TaskOutput** | `task_id`, `block`, `timeout` | Read background task output |

### Task Schema

```typescript
interface Task {
  id: string;                           // Sequential: "1", "2", "3"
  subject: string;                      // Brief title
  description: string;                  // Detailed description
  activeForm?: string;                  // Present continuous for spinner
  status: "pending" | "in_progress" | "completed";
  owner?: string;                       // Agent/user assignment
  blocks: string[];                     // Tasks this blocks (downstream)
  blockedBy: string[];                  // Tasks blocking this (upstream)
  metadata?: Record<string, unknown>;   // Arbitrary key-value pairs
}
```

### Storage Location

```
~/.claude/tasks/{taskListId}/
├── 1.json           # Individual task files
├── 2.json
├── .highwatermark   # Tracks highest task ID
└── .lock            # File lock for concurrency
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `CLAUDE_CODE_ENABLE_TASKS` | Set to `false` to use legacy TodoWrite |
| `CLAUDE_CODE_TASK_LIST_ID` | Override task list ID for shared lists |

### Multi-Agent Coordination

- Tasks support `owner` field for assignment
- When agent terminates, owned tasks are automatically unassigned
- `blocks`/`blockedBy` are bidirectional (both updated automatically)
- Concurrent access protected by file locking

### CLEO vs Claude Code Tasks

| Feature | CLEO | Claude Code Tasks |
|---------|------|-------------------|
| Status enum | `pending`, `active`, `blocked`, `done` | `pending`, `in_progress`, `completed` |
| Dependencies | `depends` array | `blocks` + `blockedBy` (bidirectional) |
| Hierarchy | Parent-child (epic→task→subtask) | Flat with dependencies |
| Owner | Session-based | `owner` field per task |
| Metadata | Labels, notes, timestamps | Generic `metadata` object |
| Storage | Single `todo.json` + archive | Per-task JSON files |
| Validation | JSON Schema + anti-hallucination | Zod validation |
| CLI | Full CLI (`cleo`) | Tool-based only |
| Audit trail | Append-only `todo-log.jsonl` | None visible |
| Phases | Full phase system | None |

**CLEO Advantages**: Hierarchies, phases, audit trails, anti-hallucination, full CLI
**Claude Tasks Advantages**: Bidirectional deps auto-managed, native multi-agent support

---

## Version History

| Date | Claude Version | Changes |
|------|---------------|---------|
| 2026-01-31 | 2.1.29 | Initial reverse engineering, Tasks system documented |

---

## Related Documents

- `/mnt/projects/claude-code/SCRAPING-GUIDE.md` - How to extract tool definitions
- `/mnt/projects/claude-code/REVERSE-ENGINEERING-NOTES.md` - Detailed findings
- `docs/specs/CLEO-SUBAGENT-PROTOCOL-v1.md` - CLEO's protocol (compare with Claude)
